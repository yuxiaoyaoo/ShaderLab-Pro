export type ChannelBindingPhase = 'buffer-before-flip' | 'image-after-flip';
export type ChannelTiming = 'current' | 'previous';
export type PingPongIndex = 0 | 1;
export type ChannelTextureRole = 'previous' | 'write' | 'current';

/** Single semantic source used by both frame planning and WebGL texture binding. */
export function channelTextureRole(
  phase: ChannelBindingPhase,
  timing: ChannelTiming,
): ChannelTextureRole {
  if (timing === 'previous') return 'previous';
  return phase === 'buffer-before-flip' ? 'write' : 'current';
}

/**
 * `readIndex` is the source buffer's read pointer in the supplied phase: before
 * the global flip for Buffer passes and after the flip for Image.
 */
export function selectChannelTexture(
  phase: ChannelBindingPhase,
  timing: ChannelTiming,
  readIndex: PingPongIndex,
): { role: ChannelTextureRole; textureIndex: PingPongIndex } {
  const role = channelTextureRole(phase, timing);
  const previousIndex = phase === 'buffer-before-flip'
    ? readIndex
    : (readIndex ^ 1) as PingPongIndex;
  const currentIndex = phase === 'buffer-before-flip'
    ? (readIndex ^ 1) as PingPongIndex
    : readIndex;
  return {
    role,
    textureIndex: timing === 'previous' ? previousIndex : currentIndex,
  };
}

/** Pure capture replay boundary shared with captureAt and no-WebGL tests. */
export function captureFrameNeedsReset(
  simulationValid: boolean,
  simulatedFrame: number,
  requestedFrame: number,
): boolean {
  const frame = Math.max(0, Math.floor(requestedFrame));
  return !simulationValid || frame <= simulatedFrame;
}
