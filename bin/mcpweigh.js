#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadServers } from '../src/config.js';
import { listTools } from '../src/client.js';
import { weighTools, fmtTokens, bar } from '../src/weigh.js';

const HELP = `mcpweigh - how many tokens your MCP tool definitions cost on every request

Usage: mcpweigh [options]

Reads MCP configs from Claude Code (~/.claude.json, .mcp.json), Cursor,
Claude Desktop, Codex, VS Code (.vscode/mcp.json) and Windsurf, starts each
server, asks it for its tools and weighs them.

Options:
  --config FILE     read only this config file (repeatable)
  --only NAMES      only these servers (comma separated)
  --timeout SECS    per-server timeout (default 30)
  --tools N         how many of the heaviest tools to show (default 10)
  --redact          show servers as server-1, server-2, ... instead of names
  --list            list configured servers without starting them
  --no-http         skip HTTP servers
  --json            machine-readable output
  -h, --help        show this help
  -v, --version     show version

mcpweigh runs the commands in your MCP configs, the same way your agent does.
It never prints env values, headers or command arguments.
Token counts are estimates (~4 characters per token).`;

async function main(argv) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        config: { type: 'string', multiple: true, default: [] },
        only: { type: 'string' },
        timeout: { type: 'string', default: '30' },
        tools: { type: 'string', default: '10' },
        redact: { type: 'boolean', default: false },
        list: { type: 'boolean', default: false },
        'no-http': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (e) {
    console.error(`mcpweigh: ${e.message}\n\n${HELP}`);
    return 2;
  }
  const o = args.values;
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  if (o.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return 0;
  }
  for (const f of o.config) {
    if (!fs.existsSync(f)) {
      console.error(`mcpweigh: config not found: ${f}`);
      return 2;
    }
  }

  let { servers, sources } = loadServers({ configFiles: o.config });
  if (o.only) {
    const want = new Set(o.only.split(',').map((s) => s.trim()));
    servers = servers.filter((s) => want.has(s.name));
  }
  if (o.redact) servers.forEach((s, i) => (s.display = `server-${i + 1}`));
  else servers.forEach((s) => (s.display = s.name));

  if (!servers.length) {
    if (o.json) console.log(JSON.stringify({ servers: [], totalTokens: 0 }, null, 2));
    else console.log('No MCP servers found. Use --config FILE to point at a config.');
    return 0;
  }

  if (o.list) {
    for (const s of servers) {
      const what = s.transport === 'stdio' ? s.command.split(/[\\/]/).pop() : s.transport;
      console.log(`${s.display.padEnd(24)} ${what.padEnd(10)} ${s.disabled ? 'disabled  ' : ''}${s.sources.join(', ')}`);
    }
    return 0;
  }

  const timeout = (Number(o.timeout) || 30) * 1000;
  if (!o.json) process.stderr.write(`Measuring ${servers.length} MCP server${servers.length === 1 ? '' : 's'}...\n`);

  const results = await Promise.all(
    servers.map(async (s) => {
      const base = { name: s.display, transport: s.transport, sources: s.sources };
      if (s.disabled) return { ...base, status: 'skipped', reason: 'disabled in config' };
      if (s.transport === 'sse') return { ...base, status: 'skipped', reason: 'legacy SSE transport not supported' };
      if (s.transport === 'http' && o['no-http']) return { ...base, status: 'skipped', reason: '--no-http' };
      const t0 = Date.now();
      try {
        const r = await listTools(s, { timeout });
        const w = weighTools(r.tools);
        return { ...base, status: 'ok', ms: Date.now() - t0, toolCount: r.tools.length, tokens: w.tokens, tools: w.tools };
      } catch (e) {
        const status = e.kind === 'auth' || e.kind === 'unsupported' ? 'skipped' : 'failed';
        return { ...base, status, reason: e.message };
      }
    }),
  );

  const ok = results.filter((r) => r.status === 'ok');
  const total = ok.reduce((s, r) => s + r.tokens, 0);
  const toolCount = ok.reduce((s, r) => s + r.toolCount, 0);

  if (o.json) {
    console.log(
      JSON.stringify(
        {
          estimate: 'chars/4 of JSON {name, description, input_schema}',
          sources,
          totalTokens: total,
          toolCount,
          per100Requests: total * 100,
          servers: results,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  print(results, total, toolCount, sources, Number(o.tools) || 10);
  return 0;
}

function print(results, total, toolCount, sources, topN) {
  const L = (s = '') => console.log(s);
  const ok = results.filter((r) => r.status === 'ok').sort((a, b) => b.tokens - a.tokens);
  const rest = results.filter((r) => r.status !== 'ok');
  const max = ok[0]?.tokens ?? 0;
  const nameW = Math.min(22, Math.max(6, ...results.map((r) => r.name.length)));

  L(`mcpweigh  ${results.length} server${results.length === 1 ? '' : 's'} from ${sources.join(', ')}`);
  L();
  L(`  ${'server'.padEnd(nameW)}  tools  ~tokens`);
  for (const r of ok) {
    L(`  ${r.name.slice(0, nameW).padEnd(nameW)}  ${String(r.toolCount).padStart(5)}  ${('~' + fmtTokens(r.tokens)).padStart(7)}  ${bar(r.tokens, max)}  ${pctOf(r.tokens, total)}`.trimEnd());
  }
  for (const r of rest) {
    L(`  ${r.name.slice(0, nameW).padEnd(nameW)}      -        -  ${r.status}: ${r.reason}`);
  }
  L();

  const all = ok.flatMap((r) => r.tools.map((t) => ({ ...t, server: r.name }))).sort((a, b) => b.tokens - a.tokens);
  if (all.length) {
    L('  Heaviest tools');
    for (const t of all.slice(0, topN)) {
      L(`  ${('~' + fmtTokens(t.tokens)).padStart(7)}  ${t.server.slice(0, nameW).padEnd(nameW)}  ${t.name}`);
    }
    L();
  }

  L(`  Tax per request   ~${fmtTokens(total)} tokens  (${toolCount} tools)`);
  L(`  Per 100 requests  ~${fmtTokens(total * 100)} tokens`);
  L('  Estimates: chars/4 of each tool\'s name, description and input schema.');
}

function pctOf(part, whole) {
  if (!whole) return '';
  return Math.round((part / whole) * 100) + '%';
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(`mcpweigh: ${e.message}`);
    process.exitCode = 1;
  },
);
