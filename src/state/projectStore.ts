import type { ProjectSources, ShaderlabProject } from '../project/types';
import { buildEffectiveSources, type EffectiveSources } from '../shadertoy/setupBuilder';

export interface ProjectStoreState {
  meta: ShaderlabProject;
  codeSources: ProjectSources;
  effectiveSources: EffectiveSources;
}

/** Creates the project-domain snapshot consumed by preview and export code. */
export function createProjectStoreState(
  meta: ShaderlabProject,
  codeSources: ProjectSources,
  generatedSources?: Partial<ProjectSources>,
): ProjectStoreState {
  return {
    meta,
    codeSources,
    effectiveSources: buildEffectiveSources(codeSources, generatedSources),
  };
}
