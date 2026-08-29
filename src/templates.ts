import { compileGraph } from './graph/compiler/index';
import { createDefaultImageGraph } from './graph/editor/defaultGraph';
import type { GraphDocument } from './graph/model';
import type { BufferId, ProjectSources } from './project/types';
import { t, type Locale } from './i18n';

export interface ProjectTemplate {
  id: string;
  name: string;
  desc: string;
  sources: ProjectSources;
  buffers: { id: BufferId; feedback?: boolean }[];
  sound?: boolean;
  graph?: { document: GraphDocument; fallback: string };
}

export type BuiltinTemplateId =
  | 'graph-gradient'
  | 'glow'
  | 'noise'
  | 'mandelbrot'
  | 'plasma'
  | 'raymarch'
  | 'trishader';

type BuiltinTemplateTextKey = `template.builtin.${BuiltinTemplateId}.${'name' | 'description'}`;

export const BUILTIN_TEMPLATE_KEYS = {
  'graph-gradient': {
    name: 'template.builtin.graph-gradient.name',
    description: 'template.builtin.graph-gradient.description',
  },
  glow: {
    name: 'template.builtin.glow.name',
    description: 'template.builtin.glow.description',
  },
  noise: {
    name: 'template.builtin.noise.name',
    description: 'template.builtin.noise.description',
  },
  mandelbrot: {
    name: 'template.builtin.mandelbrot.name',
    description: 'template.builtin.mandelbrot.description',
  },
  plasma: {
    name: 'template.builtin.plasma.name',
    description: 'template.builtin.plasma.description',
  },
  raymarch: {
    name: 'template.builtin.raymarch.name',
    description: 'template.builtin.raymarch.description',
  },
  trishader: {
    name: 'template.builtin.trishader.name',
    description: 'template.builtin.trishader.description',
  },
} as const satisfies Record<BuiltinTemplateId, Record<'name' | 'description', BuiltinTemplateTextKey>>;

const BUILTIN_TEMPLATE_IDS = new Set<string>(Object.keys(BUILTIN_TEMPLATE_KEYS));

export function getBuiltinTemplateDisplay(
  template: ProjectTemplate,
  _locale?: Locale,
): { name: string; description: string } {
  if (!BUILTIN_TEMPLATE_IDS.has(template.id)) {
    return { name: template.name, description: template.desc };
  }
  const keys = BUILTIN_TEMPLATE_KEYS[template.id as BuiltinTemplateId];
  return { name: t(keys.name), description: t(keys.description) };
}

export function getTemplateCanonicalName(template: ProjectTemplate): string {
  return BUILTIN_TEMPLATE_IDS.has(template.id) ? template.id : template.name;
}

const STARTER_GRAPH_DOCUMENT = createDefaultImageGraph();
const STARTER_GRAPH_COMPILE = compileGraph(STARTER_GRAPH_DOCUMENT);
if (!STARTER_GRAPH_COMPILE.ok || !STARTER_GRAPH_COMPILE.artifact) {
  throw new Error('内置 Graph 模板编译失败');
}
const STARTER_GRAPH_FALLBACK = STARTER_GRAPH_COMPILE.artifact.source;

const GLOW_IMAGE = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
    float t = iTime;
    vec3 col = vec3(0.02, 0.03, 0.05);
    for (float i = 0.0; i < 4.0; i++) {
        vec2 c = vec2(sin(t * 0.6 + i * 2.1), cos(t * 0.8 + i * 1.7)) * 0.5;
        float d = length(uv - c);
        col += 0.16 / d * vec3(0.4 + 0.6 * sin(i + t), 0.5, 0.6 + 0.4 * cos(i + t));
    }
    col *= smoothstep(1.6, 0.3, length(uv));
    fragColor = vec4(pow(col, vec3(0.4545)), 1.0);
}
`;

const NOISE_IMAGE = `float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
}

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
        v += a * vnoise(p);
        p *= 2.02;
        a *= 0.5;
    }
    return v;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
    float n = fbm(uv * 3.0 + vec2(0.0, iTime * 0.3));
    vec3 col = mix(vec3(0.05, 0.1, 0.21), vec3(0.15, 0.5, 0.85), n);
    col += vec3(0.1, 0.4, 0.6) * pow(n, 4.0);
    fragColor = vec4(col, 1.0);
}
`;

const MANDEL_IMAGE = `float mandelbrot(vec2 z0) {
    vec2 z = z0;
    for (int i = 0; i < 96; i++) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + z0;
        if (dot(z, z) > 4.0) return float(i);
    }
    return 96.0;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy - 0.5;
    vec2 z0 = (uv - vec2(-0.5, 0.0)) * 3.0;
    float it = mandelbrot(z0);
    vec3 col = it >= 96.0 ? vec3(0.0) : 0.5 + 0.5 * cos(6.28318 * (vec3(0.2, 0.4, 0.6) * it / 20.0));
    fragColor = vec4(col, 1.0);
}
`;

const PLASMA_IMAGE = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    float t = iTime;
    float v = sin(uv.x * 10.0 + t) + sin(uv.y * 8.0 - t * 1.3)
            + sin((uv.x + uv.y) * 6.0 + t * 0.7)
            + 0.5 * sin(length(uv - 0.5) * 14.0 - t * 2.0);
    v = v * 0.25 + 0.5;
    vec3 col = 0.5 + 0.5 * cos(6.28318 * (uv.xyx + vec3(0.0, 1.0, 2.0)) + v * 6.28318);
    fragColor = vec4(col, 1.0);
}
`;

const RAY_IMAGE = `float sdsphere(vec3 p, float r) { return length(p) - r; }

float map(vec3 p) {
    return sdsphere(p - vec3(0.0, 0.0, 6.0), 1.2);
}

vec3 calcNormal(vec3 p) {
    vec2 e = vec2(0.001, 0.0);
    return normalize(vec3(map(p + e.xyy) - map(p - e.xyy),
                         map(p + e.yxy) - map(p - e.yxy),
                         map(p + e.yyx) - map(p - e.yyx)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
    vec3 ro = vec3(0.0, 0.0, 0.0);
    vec3 rd = normalize(vec3(uv, 1.0));
    float t = 0.0;
    bool hit = false;
    for (int i = 0; i < 80; i++) {
        vec3 p = ro + rd * t;
        float d = map(p);
        if (d < 0.001) { hit = true; break; }
        t += d;
        if (t > 20.0) break;
    }
    vec3 col = mix(vec3(0.05, 0.08, 0.12), vec3(0.9, 0.85, 0.7), 0.6 * rd.y + 0.6);
    if (hit) {
        vec3 n = calcNormal(ro + rd * t);
        vec3 l = normalize(vec3(0.6, 0.8, 0.4));
        float diff = max(dot(n, l), 0.0);
        col = vec3(0.4, 0.45, 0.7) * (0.25 + 0.75 * diff);
        col += vec3(0.4, 0.35, 0.3) * pow(max(dot(reflect(rd, n), l), 0.0), 16.0);
    }
    col = pow(col, vec3(0.4545));
    fragColor = vec4(col, 1.0);
}
`;

const TRI_IMAGE = `float triwave(float t) { return abs(fract(t) * 2.0 - 1.0); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
    vec3 col = vec3(0.03, 0.04, 0.08);
    for (int i = 0; i < 3; i++) {
        float f = 1.0 + 3.0 * float(i);
        float v = triwave(uv.x * f + iTime * (0.4 + 0.1 * float(i)));
        col += vec3(0.2, 0.3, 0.5) * (0.12 / abs(uv.y + 0.25 - v * 0.4 + 0.0001));
    }
    col = min(col, vec3(1.0));
    fragColor = vec4(pow(col, vec3(0.4545)), 1.0);
}
`;

const TRI_SOUND = `vec2 mainSound(int samp, float time) {
    float f1 = 220.0;
    float n = 0.3 * sin(6.2831853 * f1 * time);
    n += 0.15 * sin(6.2831853 * f1 * 1.5 * time);
    n *= min(1.0, time * 20.0);
    return vec2(n);
}
`;

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'graph-gradient',
    name: '节点图动态渐变',
    desc: 'Graph v1 入门模板：UV、时间、正弦与颜色组合，可直接编辑节点',
    sources: { image: STARTER_GRAPH_FALLBACK, common: '', bufferA: '', bufferB: '', bufferC: '', bufferD: '', sound: '' },
    buffers: [],
    graph: { document: STARTER_GRAPH_DOCUMENT, fallback: STARTER_GRAPH_FALLBACK },
  },
  {
    id: 'glow',
    name: '光斑流动',
    desc: '多光源柔和光斑，时效动画 + 伽马校正',
    sources: { image: GLOW_IMAGE, common: '', bufferA: '', bufferB: '', bufferC: '', bufferD: '', sound: '' },
    buffers: [],
  },
  {
    id: 'noise',
    name: 'FBM 噪声海洋',
    desc: 'Value 噪声 + 分形叠加（FBM），时变流动',
    sources: { image: NOISE_IMAGE, common: '', bufferA: '', bufferB: '', bufferC: '', bufferD: '', sound: '' },
    buffers: [],
  },
  {
    id: 'mandelbrot',
    name: '曼德博集合',
    desc: '经典分形，递进着色迭代圈',
    sources: { image: MANDEL_IMAGE, common: '', bufferA: '', bufferB: '', bufferC: '', bufferD: '', sound: '' },
    buffers: [],
  },
  {
    id: 'plasma',
    name: '等离子体',
    desc: '多正弦叠加的经典屏幕特效',
    sources: { image: PLASMA_IMAGE, common: '', bufferA: '', bufferB: '', bufferC: '', bufferD: '', sound: '' },
    buffers: [],
  },
  {
    id: 'raymarch',
    name: '光线步进 SDF',
    desc: '球体 SDF + 步进渲染 + 法线光照',
    sources: { image: RAY_IMAGE, common: '', bufferA: '', bufferB: '', bufferC: '', bufferD: '', sound: '' },
    buffers: [],
  },
  {
    id: 'trishader',
    name: '三角波 + 音画律动',
    desc: '三角波扫描场景，含 mainSound 音轨',
    sources: { image: TRI_IMAGE, common: '', bufferA: '', bufferB: '', bufferC: '', bufferD: '', sound: TRI_SOUND },
    buffers: [],
    sound: true,
  },
];