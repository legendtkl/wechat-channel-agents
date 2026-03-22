const DEFAULT_BODY_MAX_LEN = 200;
const DEFAULT_TOKEN_PREFIX_LEN = 6;

export function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(len=${s.length})`;
}

export function redactToken(
  token: string | undefined,
  prefixLen = DEFAULT_TOKEN_PREFIX_LEN,
): string {
  if (!token) return "(none)";
  if (token.length <= prefixLen) return `****(len=${token.length})`;
  return `${token.slice(0, prefixLen)}…(len=${token.length})`;
}

export function redactBody(
  body: string | undefined,
  maxLen = DEFAULT_BODY_MAX_LEN,
): string {
  if (!body) return "(empty)";
  if (body.length <= maxLen) return body;
  return `${body.slice(0, maxLen)}…(truncated, totalLen=${body.length})`;
}

export function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const base = `${u.origin}${u.pathname}`;
    return u.search ? `${base}?<redacted>` : base;
  } catch {
    return truncate(rawUrl, 80);
  }
}

export function redactUserId(id: string): string {
  if (id.length <= 8) return "***";
  return id.slice(0, 4) + "..." + id.slice(-4);
}
