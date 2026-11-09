// Token estimates for tool definitions.
// What an agent sends to the model per tool is roughly its name, description
// and JSON input schema. We count the JSON of exactly that, at ~4 chars/token.

export const CHARS_PER_TOKEN = 4;

export function toolText(tool) {
  return JSON.stringify({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? { type: 'object' },
  });
}

export const toolTokens = (tool) => Math.ceil(toolText(tool).length / CHARS_PER_TOKEN);

export function weighTools(tools) {
  const rows = tools
    .map((t) => ({
      name: String(t.name),
      tokens: toolTokens(t),
      descriptionTokens: Math.ceil((t.description ?? '').length / CHARS_PER_TOKEN),
      schemaTokens: Math.ceil(JSON.stringify(t.inputSchema ?? {}).length / CHARS_PER_TOKEN),
    }))
    .sort((a, b) => b.tokens - a.tokens);
  return { tools: rows, tokens: rows.reduce((s, r) => s + r.tokens, 0) };
}

export function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

export function bar(value, max, width = 12) {
  if (max <= 0) return ''.padEnd(width);
  const cells = (value / max) * width;
  const full = Math.floor(cells);
  return ('█'.repeat(full) + (cells - full >= 0.5 ? '▌' : '')).padEnd(width);
}
