import type { AudioPCM } from '../shadertoy/runtime';

export function pcmToWav(pcm: AudioPCM): Blob {
  const numChannels = 2;
  const sampleRate = pcm.sampleRate;
  const n = pcm.left.length;
  const bytesPerSample = 2;
  const dataSize = n * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  dv.setUint16(32, numChannels * bytesPerSample, true);
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);
  let offset = 44;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  for (let i = 0; i < n; i++) {
    const l = clamp(pcm.left[i]);
    const r = clamp(pcm.right[i]);
    dv.setInt16(offset, l < 0 ? l * 32768 : l * 32767, true);
    dv.setInt16(offset + 2, r < 0 ? r * 32768 : r * 32767, true);
    offset += 4;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}