const CODE_BLOCK_MAX = 1000;

export function truncateCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (match) => {
    if (match.length <= CODE_BLOCK_MAX) return match;
    const lines = match.split("\n");
    const lang = lines[0];
    const codeLines = lines.slice(1, -1);
    const truncated = codeLines.slice(0, 30).join("\n");
    return `${lang}\n${truncated}\n... (truncated, ${codeLines.length} lines total)\n\`\`\``;
  });
}

export function toolUseSummary(toolsUsed: string[]): string {
  if (toolsUsed.length === 0) return "";

  const counts = new Map<string, number>();
  for (const tool of toolsUsed) {
    counts.set(tool, (counts.get(tool) || 0) + 1);
  }

  const parts = [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name}(x${count})` : name))
    .join(", ");

  return `[Tools: ${parts}]`;
}

export function formatResponse(
  text: string,
  toolsUsed: string[],
  isError: boolean,
): string {
  let output = text;

  output = truncateCodeBlocks(output);

  const summary = toolUseSummary(toolsUsed);
  if (summary) {
    output = `${output}\n\n${summary}`;
  }

  if (isError) {
    output = `[Error] ${output}`;
  }

  return output;
}
