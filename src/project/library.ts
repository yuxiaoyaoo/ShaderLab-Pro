import { readBinaryFile } from './bridge';
import { joinPath } from './types';

export const THUMBNAIL_FILE = 'thumbnail.png';

/** 项目目录名：可读 slug（保留中文）+ base36 时间戳，避免重名冲突。 */
export function libraryDirName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${slug || 'project'}-${Date.now().toString(36)}`;
}

/** 读取项目缩略图为 dataURL；缺失或读取失败返回 null（画廊显示占位）。 */
export async function readThumbnailDataUrl(dir: string): Promise<string | null> {
  try {
    const base64 = await readBinaryFile(joinPath(dir, THUMBNAIL_FILE));
    return `data:image/png;base64,${base64}`;
  } catch {
    return null;
  }
}
