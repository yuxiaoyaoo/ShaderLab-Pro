export interface SafeProductMessageDetail {
  text: string;
  redacted: boolean;
  truncated: boolean;
}

const REDACTED = '[REDACTED]';
const MAX_DETAIL_CHARS = 8_000;
const MAX_DETAIL_LINES = 40;
const MAX_LINE_CHARS = 500;

function redactUrls(value: string): { text: string; redacted: boolean } {
  let redacted = false;
  const text = value.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, (candidate) => {
    const trailingMatch = candidate.match(/[),.;!?]+$/);
    const trailing = trailingMatch?.[0] ?? '';
    const rawUrl = trailing ? candidate.slice(0, -trailing.length) : candidate;
    try {
      const url = new URL(rawUrl);
      if (url.username || url.password) {
        url.username = REDACTED;
        url.password = '';
        redacted = true;
      }
      if ([...url.searchParams.keys()].length) {
        for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, REDACTED);
        redacted = true;
      }
      if (url.hash) {
        url.hash = '';
        redacted = true;
      }
      return `${url.toString()}${trailing}`;
    } catch {
      return candidate;
    }
  });
  return { text, redacted };
}

/** 在详情进入 DOM、日志复制或剪贴板前进行确定性脱敏和尺寸约束。 */
export function sanitizeProductMessageDetail(value: string): SafeProductMessageDetail {
  let text = value.replace(/\r\n?/g, '\n');
  let redacted = false;

  const replaceAndMark = (pattern: RegExp, replacement: string | ((...args: string[]) => string)) => {
    const next = text.replace(pattern, replacement as never);
    if (next !== text) redacted = true;
    text = next;
  };

  replaceAndMark(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ');
  replaceAndMark(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  replaceAndMark(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]');
  replaceAndMark(/\b(sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/gi, REDACTED);
  replaceAndMark(
    /\b(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth(?:orization)?|token|password|passwd|client[-_ ]?secret|secret|set-cookie|cookie)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (_match: string, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  );
  replaceAndMark(/\b[A-Za-z]:\\Users\\[^\\/\s]+/gi, (match: string) => `${match.slice(0, match.lastIndexOf('\\') + 1)}${REDACTED}`);
  replaceAndMark(/\/(Users|home)\/[^/\s]+/g, (_match: string, root: string) => `/${root}/${REDACTED}`);

  const urlResult = redactUrls(text);
  text = urlResult.text;
  redacted ||= urlResult.redacted;

  let truncated = false;
  let lines = text.split('\n');
  if (lines.length > MAX_DETAIL_LINES) {
    lines = lines.slice(0, MAX_DETAIL_LINES);
    truncated = true;
  }
  lines = lines.map((line) => {
    if (line.length <= MAX_LINE_CHARS) return line;
    truncated = true;
    return `${line.slice(0, MAX_LINE_CHARS)}…`;
  });
  text = lines.join('\n').trim();
  if (text.length > MAX_DETAIL_CHARS) {
    text = `${text.slice(0, MAX_DETAIL_CHARS)}…`;
    truncated = true;
  } else if (truncated && text) {
    text = `${text}\n…`;
  }

  return { text, redacted, truncated };
}
