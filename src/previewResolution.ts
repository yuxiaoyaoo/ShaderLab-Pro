export type PreviewResolution =
  | Readonly<{ mode: 'auto' }>
  | Readonly<{ mode: 'fixed'; width: number; height: number }>;

export const PREVIEW_RESOLUTION_STORAGE_KEY = 'shaderlab-preview-resolution-v1';
export const DEFAULT_PREVIEW_RESOLUTION: PreviewResolution = { mode: 'auto' };

export const PREVIEW_RESOLUTION_PRESETS = [
  { width: 1280, height: 720, ratio: '16:9' },
  { width: 1920, height: 1080, ratio: '16:9' },
  { width: 2560, height: 1440, ratio: '16:9' },
  { width: 3840, height: 2160, ratio: '16:9' },
  { width: 1440, height: 1080, ratio: '4:3' },
  { width: 1024, height: 1024, ratio: '1:1' },
  { width: 1080, height: 1920, ratio: '9:16' },
] as const;

export function normalizePreviewResolution(value: unknown): PreviewResolution {
  if (!value || typeof value !== 'object') return DEFAULT_PREVIEW_RESOLUTION;
  const candidate = value as Partial<{ mode: unknown; width: unknown; height: unknown }>;
  if (candidate.mode === 'auto') return DEFAULT_PREVIEW_RESOLUTION;
  if (candidate.mode !== 'fixed') return DEFAULT_PREVIEW_RESOLUTION;
  const width = Number(candidate.width);
  const height = Number(candidate.height);
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    return DEFAULT_PREVIEW_RESOLUTION;
  }
  return { mode: 'fixed', width, height };
}

export function readPreviewResolution(): PreviewResolution {
  try {
    const raw = localStorage.getItem(PREVIEW_RESOLUTION_STORAGE_KEY);
    return raw ? normalizePreviewResolution(JSON.parse(raw)) : DEFAULT_PREVIEW_RESOLUTION;
  } catch {
    return DEFAULT_PREVIEW_RESOLUTION;
  }
}

export function persistPreviewResolution(value: PreviewResolution): void {
  try {
    localStorage.setItem(PREVIEW_RESOLUTION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // The live setting still works when storage is unavailable.
  }
}

export function previewResolutionKey(value: PreviewResolution): string {
  return value.mode === 'auto' ? 'auto' : `${value.width}x${value.height}`;
}
