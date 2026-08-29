import { ProductError, type ProductMessageDescriptor } from '../productMessage';
import type { BufferId, PassChannelCfg, ProjectSources, ShaderlabProject } from '../project/types';
import { BUFFER_IDS, sourcesWithDefaults } from '../project/types';

/**
 * Shadertoy 官方导出 JSON 结构（结构保留字段可缺省）。
 * 参考：https://shadertoy.com —— 「Export → Export to JSON」产物格式。
 */
export interface StSampler {
  filter?: string;
  wrap?: string;
  vflip?: string;
  srgb?: string;
  internal?: string;
}

export interface StInput {
  id: number;
  src: string | null;
  ctype: string;
  channel: number;
  sampler?: StSampler;
}

export interface StOutput {
  id: number;
  channel: number;
}

export interface StRenderPass {
  outputs: StOutput[];
  inputs: StInput[];
  code: string;
  name: string;
  description: string;
  type: 'image' | 'buffer' | 'sound' | 'common';
}

export interface StInfo {
  id: string;
  date: string;
  viewed: number;
  name: string;
  username: string;
  description: string;
  likes: number;
  published: number;
  flags: number;
  tags: string[];
  hasLiked?: boolean;
}

export interface StShader {
  ver: string;
  info: StInfo;
  renderpass: StRenderPass[];
  tags?: string[];
  flags?: number;
  usePreview?: number;
}

export interface StRoot {
  shader: StShader;
}

interface StRootLoose {
  shader?: StShader;
  renderpass?: StRenderPass[];
  info?: Partial<StInfo>;
}

/** 导入结果：sources + 各 Buffer 的启用/feedback/通道 + 汇总信息 */
export interface ShadertoyImport {
  name: string;
  description: string;
  sources: ProjectSources;
  buffers: Partial<
    Record<'image' | BufferId, { enabled: boolean; feedback: boolean; channels: PassChannelCfg[] }>
  >;
  sound: boolean;
  skippedChannels: { ctype: string; count: number }[];
  warnings: ProductMessageDescriptor[];
}

const SAMPLER_DEFAULT: Required<StSampler> = {
  filter: 'linear',
  wrap: 'clamp',
  vflip: 'true',
  srgb: 'false',
  internal: 'byte',
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function toStr(v: unknown, dflt = ''): string {
  return typeof v === 'string' ? v : dflt;
}

function normFilter(f: string | undefined): 'linear' | 'nearest' {
  return f === 'nearest' ? 'nearest' : 'linear';
}

function normWrap(w: string | undefined): 'repeat' | 'clamp' {
  return w === 'repeat' ? 'repeat' : 'clamp';
}

/**
 * 解析 Shadertoy 导出 JSON → 应用内部结构。
 * - type:buffer 的 pass 按出现顺序映射 Buffer A–D（最多 4 个）
 * - ctype:buffer 的 input 通过 outputs id 关联到目标 Buffer
 * - 其余 ctype（texture/webcam/keyboard/…）无法离线复刻，计数后跳过
 */
export function parseShadertoyJson(text: string): ShadertoyImport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProductError({
      code: 'shadertoy.invalid-json',
      rawDetail: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isObj(raw)) throw new ProductError({ code: 'shadertoy.root-invalid' });
  const root = raw as StRootLoose;
  const shader = isObj(root.shader) ? root.shader : root;
  const passes = shader.renderpass;
  if (!Array.isArray(passes) || passes.length === 0) {
    throw new ProductError({ code: 'shadertoy.renderpass-missing' });
  }

  const info = isObj(shader.info) ? shader.info : {};
  const result: ShadertoyImport = {
    name: toStr(info.name),
    description: toStr(info.description),
    sources: { image: '', common: '' },
    buffers: {},
    sound: false,
    skippedChannels: [],
    warnings: [],
  };
  const skippedMap = new Map<string, number>();
  const noteSkipped = (ctype: string) => {
    skippedMap.set(ctype, (skippedMap.get(ctype) ?? 0) + 1);
  };

  // 第一遍：落位源码，记录 buffer 输出 id → Buffer 名
  const outputIdToBuffer = new Map<number, BufferId>();
  const passBySlot = new Map<string, StRenderPass>();
  let bufferSeq = 0;
  for (const rp of passes) {
    if (!isObj(rp)) continue;
    const p = rp as unknown as StRenderPass;
    const code = toStr(p.code);
    switch (p.type) {
      case 'image':
        result.sources.image = code;
        passBySlot.set('image', p);
        break;
      case 'common':
        result.sources.common = code;
        break;
      case 'sound':
        if (code.trim()) {
          result.sources.sound = code;
          result.sound = true;
        }
        break;
      case 'buffer': {
        if (bufferSeq >= BUFFER_IDS.length) {
          result.warnings.push({ code: 'shadertoy.warning.extra-buffers' });
          break;
        }
        const bid = BUFFER_IDS[bufferSeq++];
        result.sources[bid] = code;
        const outId = Array.isArray(p.outputs) && isObj(p.outputs[0]) ? Number(p.outputs[0].id) : NaN;
        if (Number.isFinite(outId)) outputIdToBuffer.set(outId, bid);
        passBySlot.set(bid, p);
        break;
      }
    }
  }

  if (!result.sources.image.trim()) {
    throw new ProductError({ code: 'shadertoy.image-missing' });
  }

  // 通道映射辅助：channel 索引 + sampler 归一化
  const toChannelCfg = (inp: StInput, src: BufferId): PassChannelCfg => {
    const s = { ...SAMPLER_DEFAULT, ...(isObj(inp.sampler) ? inp.sampler : {}) };
    return {
      index: Math.max(0, Math.min(3, Math.round(Number(inp.channel) || 0))),
      type: 'buffer',
      src,
      filter: normFilter(s.filter),
      wrap: normWrap(s.wrap),
    };
  };

  // 第二遍：image + buffers 的 inputs → buffer 通道
  for (const [slot, rp] of passBySlot) {
    if (slot === 'sound') continue;
    const inputs = Array.isArray(rp.inputs) ? rp.inputs : [];
    const cfgs: PassChannelCfg[] = [];
    for (const raw2 of inputs) {
      if (!isObj(raw2)) continue;
      const inp = raw2 as unknown as StInput;
      if (toStr(inp.ctype) === 'buffer') {
        const target = outputIdToBuffer.get(Number(inp.id));
        if (target) {
          cfgs.push(toChannelCfg(inp, target));
          continue;
        }
        noteSkipped('buffer-missing-reference');
        continue;
      }
      noteSkipped(toStr(inp.ctype, 'unknown'));
    }
    if (cfgs.length === 0) continue;
    if (slot === 'image') {
      result.buffers.image = { enabled: true, feedback: false, channels: cfgs };
    } else {
      const bid = slot as BufferId;
      // 自引用即 feedback 语义：保留显式通道，运行时按自引用绑定（不会重复前置）
      const selfRef = cfgs.some((c) => c.src === bid);
      result.buffers[bid] = { enabled: true, feedback: selfRef, channels: cfgs };
    }
  }
  for (const bid of BUFFER_IDS) {
    if (result.sources[bid]?.trim() && !result.buffers[bid]) {
      result.buffers[bid] = { enabled: true, feedback: false, channels: [] };
    }
  }

  result.skippedChannels = [...skippedMap.entries()].map(([ctype, count]) => ({ ctype, count }));
  if (result.skippedChannels.length > 0) {
    result.warnings.push({
      code: 'shadertoy.warning.channels-skipped',
      params: { count: result.skippedChannels.reduce((sum, item) => sum + item.count, 0) },
    });
  }
  result.sources = sourcesWithDefaults(result.sources);
  return result;
}

function sanitizeName(name: string): string {
  const s = name.trim().replace(/[^\w\u4e00-\u9fa5-]+/g, '_');
  return s || 'shader';
}

/** 内部项目 → Shadertoy 导出 JSON 文本 */
export function toShadertoyJson(meta: ShaderlabProject, sources: ProjectSources): string {
  const emptyPass = (type: StRenderPass['type'], name: string): StRenderPass => ({
    outputs: [],
    inputs: [],
    code: '',
    name,
    description: '',
    type,
  });

  const renderpass: StRenderPass[] = [];
  let nextId = 1;
  const bufferOutId = new Map<BufferId, number>();

  const imageSrc = sources.image ?? '';
  if (!imageSrc.trim()) {
    throw new ProductError({ code: 'shadertoy.image-empty' });
  }

  // id 分配顺序：image → bufferA–D → sound → common
  const imagePass = emptyPass('image', 'Image');
  imagePass.outputs = [{ id: nextId++, channel: 0 }];
  imagePass.code = imageSrc;
  renderpass.push(imagePass);

  for (const bid of BUFFER_IDS) {
    const code = (sources[bid] ?? '').trim();
    const pc = meta.passes[bid];
    if (!code || !pc?.enabled) continue;
    const p = emptyPass('buffer', `Buffer ${bid.slice(-1).toUpperCase()}`);
    p.outputs = [{ id: nextId++, channel: 0 }];
    bufferOutId.set(bid, p.outputs[0].id);
    p.code = sources[bid]!;
    renderpass.push(p);
  }

  const soundSrc = (sources.sound ?? '').trim();
  if (soundSrc && meta.passes.sound?.enabled) {
    const p = emptyPass('sound', 'Sound');
    p.code = soundSrc;
    renderpass.push(p);
  }

  const commonSrc = (sources.common ?? '').trim();
  if (commonSrc) {
    const p = emptyPass('common', 'Common');
    p.code = commonSrc;
    renderpass.push(p);
  }

  // inputs：显式通道 + feedback 自引用
  const attachInputs = (
    slot: 'image' | BufferId,
    pass: StRenderPass,
    selfOutId: number | null,
  ) => {
    const pc = slot === 'image' ? meta.passes.image : meta.passes[slot];
    const chs = (pc?.channels ?? []).filter(
      (c): c is PassChannelCfg & { src: BufferId } =>
        c.type === 'buffer' && bufferOutId.has(c.src as BufferId),
    );
    for (const c of chs) {
      pass.inputs.push({
        id: bufferOutId.get(c.src as BufferId)!,
        src: null,
        ctype: 'buffer',
        channel: c.index,
        sampler: {
          filter: c.filter === 'nearest' ? 'nearest' : 'linear',
          wrap: c.wrap === 'repeat' ? 'repeat' : 'clamp',
          vflip: 'true',
          srgb: 'false',
          internal: 'byte',
        },
      });
    }
    if (pc?.feedback && selfOutId !== null && !chs.some((c) => c.src === slot)) {
      const used = new Set(chs.map((c) => c.index));
      const freeIdx = [0, 1, 2, 3].find((i) => !used.has(i));
      if (freeIdx !== undefined) {
        pass.inputs.push({
          id: selfOutId,
          src: null,
          ctype: 'buffer',
          channel: freeIdx,
          sampler: { ...SAMPLER_DEFAULT },
        });
      }
    }
  };
  attachInputs('image', imagePass, null);
  for (const p of renderpass) {
    if (p.type !== 'buffer') continue;
    const bid = BUFFER_IDS.find((b) => `Buffer ${b.slice(-1).toUpperCase()}` === p.name)!;
    attachInputs(bid, p, bufferOutId.get(bid) ?? null);
  }

  const doc: StRoot = {
    shader: {
      ver: '0.1',
      info: {
        id: '',
        date: '0',
        viewed: 0,
        name: meta.name || 'ShaderLab Project',
        username: 'ShaderLab Pro',
        description: meta.description ?? '',
        likes: 0,
        published: 0,
        flags: 0,
        tags: [],
        hasLiked: false,
      },
      renderpass,
      tags: [],
      flags: 0,
      usePreview: 1,
    },
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

export function shadertoyFileName(name: string): string {
  return `${sanitizeName(name)}.shadertoy.json`;
}
