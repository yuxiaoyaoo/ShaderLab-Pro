export type CodeApplyBoundary = { allowed: true } | { allowed: false; reason: string };

export function codeApplyBoundary(authoring: 'code' | 'graph'): CodeApplyBoundary {
  return authoring === 'code'
    ? { allowed: true }
    : { allowed: false, reason: 'Image 当前为节点图；M4 的 AI/代码模板只能应用到 Code authoring' };
}

export function shouldDetachGraph(confirmed: boolean, hasAcceptedArtifact: boolean): boolean {
  return confirmed && hasAcceptedArtifact;
}
