import type { GeneratedUniform } from '../graph/compiler/types';
import { passGraphFromLegacy, resolvePassGraph, type ResolvedPassGraph } from '../project/passGraph';
import { BUFFER_IDS, sourcesWithDefaults, type ProjectSources, type ShaderlabProject } from '../project/types';
import { buildRuntimeUniformContract } from './uniformContract';
import type { UniformDecl, UniformValue } from './uniforms';
import type { GraphPassId } from '../graph/model';
import type { RuntimeChannelCfg, RuntimeTextureAsset, RuntimeSetup } from './runtime';

/** Runtime/export-facing sources. M1 can replace individual Code sources with generated Graph GLSL. */
export type EffectiveSources = ProjectSources;

export function buildEffectiveSources(
  codeSources: ProjectSources,
  generatedSources?: Partial<ProjectSources>,
): EffectiveSources {
  return sourcesWithDefaults({ ...codeSources, ...generatedSources });
}

export function buildRuntimeSetup(
  meta: ShaderlabProject,
  effectiveSources: EffectiveSources,
  uniformDecls: UniformDecl[],
  uniformValues: Record<string, UniformValue>,
  graphUniforms: readonly GeneratedUniform[] = [],
  timingPlan?: ResolvedPassGraph,
  graphTextureChannels: Partial<Record<GraphPassId, ReadonlyArray<Extract<RuntimeChannelCfg, { type: 'texture' }>>>> = {},
  textures: RuntimeTextureAsset[] = [],
): RuntimeSetup {
  const fallbackPlan = timingPlan ?? resolvePassGraph(passGraphFromLegacy(meta), meta).resolved;
  const resolved = fallbackPlan ?? {
    revision: 'invalid-pass-graph',
    edges: [],
    bufferOrder: BUFFER_IDS.filter((pass) => meta.passes[pass].enabled),
    channelEnvironment: {},
  };
  const bufferChannels = (pass: 'image' | (typeof BUFFER_IDS)[number]) =>
    resolved.edges
      .filter((edge) => edge.target === pass)
      .map((edge) => ({
        index: edge.slot,
        type: 'buffer' as const,
        src: edge.source,
        timing: edge.timing,
        filter: edge.filter,
        wrap: edge.wrap,
      }));
  const textureChannels = (pass: GraphPassId): Extract<RuntimeChannelCfg, { type: 'texture' }>[] => {
    const legacy = (meta.passes[pass].authoring?.kind === 'graph' ? [] : (meta.passes[pass].channels ?? [])).filter((channel) => channel.type === 'texture').map((channel) => ({
      index: channel.index,
      type: 'texture' as const,
      src: channel.src,
      filter: channel.filter,
      wrap: channel.wrap,
    }));
    // Preserve declared channels even when an asset is missing. Runtime validates each
    // requested domain and rejects only that domain instead of silently binding dummy data.
    return [...legacy, ...(graphTextureChannels[pass] ?? [])];
  };

  const options: RuntimeSetup['options'] = {
    image: { channels: [...bufferChannels('image'), ...textureChannels('image')] },
  };
  for (const buffer of BUFFER_IDS) {
    const config = meta.passes[buffer];
    if (!config?.enabled) continue;
    options[buffer] = { channels: [...bufferChannels(buffer), ...textureChannels(buffer)] };
  }
  if (meta.passes.sound.enabled) options.sound = { channels: textureChannels('sound') };

  return {
    sources: {
      common: effectiveSources.common,
      image: effectiveSources.image,
      bufferA: meta.passes.bufferA.enabled ? effectiveSources.bufferA : undefined,
      bufferB: meta.passes.bufferB.enabled ? effectiveSources.bufferB : undefined,
      bufferC: meta.passes.bufferC.enabled ? effectiveSources.bufferC : undefined,
      bufferD: meta.passes.bufferD.enabled ? effectiveSources.bufferD : undefined,
      sound: meta.passes.sound.enabled ? effectiveSources.sound : undefined,
    },
    options,
    timingPlan: { bufferOrder: resolved.bufferOrder, revision: resolved.revision },
    textures,
    uniforms: buildRuntimeUniformContract(
      uniformDecls.filter((decl) => decl.pass !== 'sound'),
      graphUniforms.filter((uniform) => uniform.pass !== 'sound'),
      uniformValues,
    ),
    soundUniforms: buildRuntimeUniformContract(
      uniformDecls.filter((decl) => decl.pass === 'common' || decl.pass === 'sound'),
      graphUniforms.filter((uniform) => uniform.pass === 'sound'),
      uniformValues,
    ),
  };
}
