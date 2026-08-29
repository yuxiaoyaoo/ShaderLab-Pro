const MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

const MIME_CANDIDATES_AUDIO = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=opus',
  'video/webm;codecs=vp9,vorbis',
  'video/webm;codecs=vp8,vorbis',
];

export function pickVideoMime(withAudio = false): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = withAudio
    ? [...MIME_CANDIDATES_AUDIO, ...MIME_CANDIDATES]
    : MIME_CANDIDATES;
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      // 继续尝试下一种浏览器支持的编码组合。
    }
  }
  return null;
}

export function isVideoExportSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && !!pickVideoMime();
}

export function isMp4ExportSupported(): boolean {
  return (
    typeof VideoEncoder !== 'undefined'
    && typeof VideoFrame !== 'undefined'
    && typeof AudioEncoder !== 'undefined'
  );
}

export function describeMime(mime: string): string {
  if (mime.includes('vp9')) return 'WebM · VP9';
  if (mime.includes('vp8')) return 'WebM · VP8';
  return 'WebM';
}
