// Find MCP server configs for Claude Code, Cursor, Claude Desktop, Codex,
// VS Code and Windsurf, and normalize them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Expand ${VAR} and ${VAR:-default}, like Claude Code does in .mcp.json.
export function expandEnv(value, env = process.env) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, dflt) =>
      env[name] !== undefined && env[name] !== '' ? env[name] : dflt ?? '',
    );
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env)]));
  }
  return value;
}

// Normalize one server entry. Returns null for entries we can't read.
export function normalizeServer(name, raw, { source, cwd }) {
  if (!raw || typeof raw !== 'object') return null;
  const e = expandEnv(raw);
  const declared = String(e.type ?? e.transport ?? '').toLowerCase();
  const url = e.url ?? e.serverUrl ?? e.httpUrl;
  let transport;
  if (e.command) transport = 'stdio';
  else if (declared === 'sse') transport = 'sse';
  else if (url) transport = 'http';
  else return null;
  return {
    name,
    source,
    transport,
    disabled: e.disabled === true || e.enabled === false,
    command: e.command,
    args: Array.isArray(e.args) ? e.args.map(String) : [],
    env: e.env && typeof e.env === 'object' ? e.env : {},
    cwd: e.cwd ? path.resolve(cwd, e.cwd) : cwd,
    url,
    headers: e.headers && typeof e.headers === 'object' ? e.headers : {},
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Minimal TOML reader for Codex's [mcp_servers.<name>] tables.
// Handles strings, numbers, booleans, string arrays and inline tables.
export function parseCodexToml(text) {
  const servers = {};
  let current = null;
  let sub = null;
  const parseValue = (v) => {
    v = v.trim();
    if (v.startsWith('"') || v.startsWith("'")) {
      const q = v[0];
      const end = v.indexOf(q, 1);
      const s = v.slice(1, end);
      return q === '"' ? s.replace(/\\(["\\nt])/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c) : s;
    }
    if (v.startsWith('[')) {
      const out = [];
      const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
      let m;
      while ((m = re.exec(v))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
      return out;
    }
    if (v.startsWith('{')) {
      const out = {};
      const re = /([A-Za-z0-9_-]+|"[^"]*")\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^,}]+)/g;
      let m;
      while ((m = re.exec(v))) out[m[1].replace(/"/g, '')] = parseValue(m[2]);
      return out;
    }
    if (v === 'true' || v === 'false') return v === 'true';
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const sec = /^\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (sec) {
      const parts = sec[1].split('.').map((p) => p.trim().replace(/^"|"$/g, ''));
      if (parts[0] === 'mcp_servers' && parts[1]) {
        current = servers[parts[1]] ??= {};
        sub = parts[2] ?? null;
        if (sub) current[sub] ??= {};
      } else {
        current = null;
      }
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z0-9_"-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    let val = kv[2];
    // Multi-line arrays.
    if (val.trim().startsWith('[') && !val.includes(']')) {
      while (i + 1 < lines.length && !val.includes(']')) val += ' ' + lines[++i].trim();
    }
    const key = kv[1].replace(/"/g, '');
    (sub ? current[sub] : current)[key] = parseValue(val);
  }
  return servers;
}

// Where each tool keeps its config. Labels never include the home path.
export function configSources({ home = os.homedir(), cwd = process.cwd(), platform = process.platform, env = process.env } = {}) {
  const desktop =
    platform === 'darwin'
      ? path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json')
      : platform === 'win32'
        ? path.join(env.APPDATA ?? path.join(home, 'AppData/Roaming'), 'Claude/claude_desktop_config.json')
        : path.join(home, '.config/Claude/claude_desktop_config.json');
  return [
    { label: 'claude-code (user)', file: path.join(home, '.claude.json'), kind: 'claude-user' },
    { label: 'claude-code (local)', file: path.join(home, '.claude.json'), kind: 'claude-local' },
    { label: 'claude-code (.mcp.json)', file: path.join(cwd, '.mcp.json'), kind: 'json', projectDir: cwd },
    { label: 'cursor (user)', file: path.join(home, '.cursor/mcp.json'), kind: 'json' },
    { label: 'cursor (project)', file: path.join(cwd, '.cursor/mcp.json'), kind: 'json', projectDir: cwd },
    { label: 'claude-desktop', file: desktop, kind: 'json' },
    { label: 'codex', file: path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'config.toml'), kind: 'codex' },
    { label: 'vscode (project)', file: path.join(cwd, '.vscode/mcp.json'), kind: 'json', projectDir: cwd },
    { label: 'windsurf', file: path.join(home, '.codeium/windsurf/mcp_config.json'), kind: 'json' },
  ];
}

function serversFromJson(data) {
  if (!data || typeof data !== 'object') return {};
  return data.mcpServers ?? data.servers ?? data.mcp?.servers ?? {};
}

// Read one source. Returns list of normalized servers.
export function readSource(src, { cwd = process.cwd() } = {}) {
  if (!fs.existsSync(src.file)) return [];
  let entries = {};
  if (src.kind === 'codex') {
    try {
      entries = parseCodexToml(fs.readFileSync(src.file, 'utf8'));
    } catch {
      return [];
    }
  } else {
    const data = readJson(src.file);
    if (!data) return [];
    if (src.kind === 'claude-user') entries = data.mcpServers ?? {};
    else if (src.kind === 'claude-local') entries = data.projects?.[cwd]?.mcpServers ?? {};
    else entries = serversFromJson(data);
  }
  const spawnCwd = src.projectDir ?? (src.kind === 'config' ? path.dirname(src.file) : cwd);
  return Object.entries(entries)
    .map(([name, raw]) => normalizeServer(name, raw, { source: src.label, cwd: spawnCwd }))
    .filter(Boolean);
}

export function loadServers({ configFiles = [], home, cwd = process.cwd(), platform, env } = {}) {
  const sources = configFiles.length
    ? configFiles.map((f) => ({ label: path.basename(f), file: path.resolve(f), kind: f.endsWith('.toml') ? 'codex' : 'config' }))
    : configSources({ home, cwd, platform, env });
  const found = [];
  const seenFiles = [];
  for (const src of sources) {
    const servers = readSource(src, { cwd });
    if (servers.length) seenFiles.push(src.label);
    found.push(...servers);
  }
  return { servers: dedupe(found), sources: seenFiles };
}

// The same server configured in two places is measured once.
export function dedupe(servers) {
  const byKey = new Map();
  for (const s of servers) {
    const key = s.transport === 'stdio' ? `${s.name}\0${s.command}\0${s.args.join('\0')}` : `${s.name}\0${s.url}`;
    const prev = byKey.get(key);
    if (prev) prev.sources.push(s.source);
    else byKey.set(key, { ...s, sources: [s.source] });
  }
  return [...byKey.values()];
}
