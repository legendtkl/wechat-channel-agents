const DEFAULT_CHUNK_SIZE = 4000;

/**
 * Split a long text into chunks that fit within WeChat message limits.
 * Splits at newlines when possible to preserve readability.
 */
export function chunkText(
  text: string,
  maxLen = DEFAULT_CHUNK_SIZE,
): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point: last newline within maxLen
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) {
      // No newline found, try space
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt <= 0) {
      // No good split point, hard cut
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  return chunks;
}
