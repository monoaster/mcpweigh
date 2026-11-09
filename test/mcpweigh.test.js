import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listToolsStdio, listToolsHttp } from '../src/client.js';
import { expandEnv, normalizeServer, parseCodexToml, loadServers, dedupe } from '../src/config.js';
import { toolTokens, weighTools, fmtTokens } from '../src/weigh.js';

const BIN = fileURLToPath(new URL('../bin/mcpweigh.js', import.meta.url));
const FAKE = fileURLToPath(new URL('../examples/fake-server.js', import.meta.url));
const DEMO = fileURLToPath(new URL('../examples/demo.json', import.meta.url));
const fake = (...args) => ({ name: 'fake', transport: 'stdio', command: process.execPath, args: [FAKE, ...args], env: {} });

const tmpDirs = [];
after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpweigh-'));
  tmpDirs.push(d);
  return d;
}

// ---------- token math ----------

test('toolTokens counts name, description and schema at ~4 chars/token', () => {
  const t = { name: 'x', description: 'abcd', inputSchema: { type: 'object' } };
  const json = JSON.stringify({ name: 'x', description: 'abcd', input_schema: { type: 'object' } });
  assert.equal(toolTokens(t), Math.ceil(json.length / 4));
});

test('weighTools sorts heaviest first and sums', () => {
  const w = weighTools([
    { name: 'a', description: 'short' },
    { name: 'b', description: 'a much longer description '.repeat(10) },
  ]);
  assert.equal(w.tools[0].name, 'b');
  assert.equal(w.tokens, w.tools[0].tokens + w.tools[1].tokens);
  assert.equal(fmtTokens(6400), '6.4k');
  assert.equal(fmtTokens(643000), '643k');
});

// ---------- stdio client ----------

test('stdio: lists tools across pages', async () => {
  const r = await listToolsStdio(fake('--profile', 'big', '--tools', '23', '--page-size', '5'), { timeout: 10000 });
  assert.equal(r.tools.length, 23);
  assert.equal(r.serverInfo.name, 'fake-server');
  assert.equal(new Set(r.tools.map((t) => t.name)).size, 23);
});

test('stdio: ignores non-JSON log lines on stdout', async () => {
  const r = await listToolsStdio(fake('--noisy'), { timeout: 10000 });
  assert.equal(r.tools.length, 2);
});

test('stdio: reports a crash', async () => {
  await assert.rejects(listToolsStdio(fake('--crash'), { timeout: 10000 }), /exited early/);
});

test('stdio: reports a missing command', async () => {
  const s = { name: 'x', transport: 'stdio', command: 'definitely-not-a-real-cmd-123', args: [], env: {} };
  await assert.rejects(listToolsStdio(s, { timeout: 5000 }), /command not found|exited early|could not start/);
});

test('stdio: times out a hung server and kills it', async () => {
  await assert.rejects(listToolsStdio(fake('--hang'), { timeout: 800 }), /no answer within/);
  if (process.platform !== 'win32') {
    let left;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const out = spawnSync('ps', ['-eo', 'command'], { encoding: 'utf8' }).stdout;
      left = out.split('\n').filter((l) => l.includes(FAKE + ' --hang'));
      if (!left.length) break;
    }
    assert.deepEqual(left, [], 'hung server should be killed');
  }
});

test('stdio: passes config env to the server', async () => {
  const d = tmp();
  const script = path.join(d, 'envcheck.js');
  fs.writeFileSync(
    script,
    `import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (l) => { const m = JSON.parse(l); if (m.id === undefined) return;
  const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'e', version: '1' } }
    : { tools: [{ name: 'has_' + (process.env.MY_TOKEN === 's3cret' ? 'token' : 'nothing'), inputSchema: { type: 'object' } }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); });`,
  );
  const r = await listToolsStdio(
    { name: 'e', transport: 'stdio', command: process.execPath, args: [script], env: { MY_TOKEN: 's3cret' } },
    { timeout: 10000 },
  );
  assert.equal(r.tools[0].name, 'has_token');
});

// ---------- HTTP client ----------

function startHttpServer({ sse = false, auth = false } = {}) {
  const seen = { sessionOnList: null, deleted: false };
  const tools = [
    { name: 'search_docs', description: 'Search the docs.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    { name: 'fetch_page', description: 'Fetch one page.', inputSchema: { type: 'object' } },
  ];
  const server = http.createServer((req, res) => {
    if (auth && req.headers.authorization !== 'Bearer ok') {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'DELETE') {
      seen.deleted = true;
      res.writeHead(200).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result;
      if (msg.method === 'initialize') {
        result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'h', version: '1' } };
      } else if (msg.method === 'tools/list') {
        seen.sessionOnList = req.headers['mcp-session-id'];
        const page = msg.params?.cursor ? 1 : 0;
        result = { tools: [tools[page]], ...(page === 0 ? { nextCursor: 'p2' } : {}) };
      }
      const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      const headers = { 'mcp-session-id': 'sess-1' };
      if (sse) {
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
        res.write(': keepalive\n\n');
        res.write(`event: message\ndata: ${reply}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { ...headers, 'content-type': 'application/json' });
        res.end(reply);
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/mcp` })),
  );
}

for (const sse of [false, true]) {
  test(`http: lists tools with ${sse ? 'SSE' : 'JSON'} replies and keeps the session`, async () => {
    const { server, seen, url } = await startHttpServer({ sse });
    try {
      const r = await listToolsHttp({ transport: 'http', url, headers: {} }, { timeout: 5000 });
      assert.deepEqual(r.tools.map((t) => t.name), ['search_docs', 'fetch_page']);
      assert.equal(seen.sessionOnList, 'sess-1');
    } finally {
      server.close();
    }
  });
}

test('http: 401 is reported as needing auth; headers are sent', async () => {
  const { server, url } = await startHttpServer({ auth: true });
  try {
    await assert.rejects(listToolsHttp({ transport: 'http', url, headers: {} }, { timeout: 5000 }), (e) => e.kind === 'auth');
    const r = await listToolsHttp({ transport: 'http', url, headers: { authorization: 'Bearer ok' } }, { timeout: 5000 });
    assert.equal(r.tools.length, 2);
  } finally {
    server.close();
  }
});

test('http: unreachable server fails cleanly', async () => {
  await assert.rejects(
    listToolsHttp({ transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: {} }, { timeout: 3000 }),
    /could not connect|no answer/,
  );
});

// ---------- config ----------

test('expandEnv handles ${VAR} and ${VAR:-default}', () => {
  const env = { HOME_DIR: '/h', EMPTY: '' };
  assert.equal(expandEnv('${HOME_DIR}/x', env), '/h/x');
  assert.equal(expandEnv('${NOPE:-fallback}', env), 'fallback');
  assert.equal(expandEnv('${EMPTY:-d}', env), 'd');
  assert.deepEqual(expandEnv(['${HOME_DIR}'], env), ['/h']);
});

test('normalizeServer detects transports', () => {
  const o = { source: 's', cwd: '/w' };
  assert.equal(normalizeServer('a', { command: 'npx', args: ['x'] }, o).transport, 'stdio');
  assert.equal(normalizeServer('b', { type: 'http', url: 'https://x' }, o).transport, 'http');
  assert.equal(normalizeServer('c', { url: 'https://x' }, o).transport, 'http');
  assert.equal(normalizeServer('d', { type: 'sse', url: 'https://x' }, o).transport, 'sse');
  assert.equal(normalizeServer('e', { serverUrl: 'https://x' }, o).transport, 'http');
  assert.equal(normalizeServer('f', {}, o), null);
  assert.equal(normalizeServer('g', { command: 'x', disabled: true }, o).disabled, true);
});

test('parseCodexToml reads mcp_servers tables', () => {
  const toml = `
model = "gpt-5"
[mcp_servers.docs]
command = "npx"
args = ["-y", "some-server",
  "--flag"]
env = { API_KEY = "abc", MODE = "x" }

[mcp_servers.other]
url = "https://example.com/mcp"

[mcp_servers.other.env]
TOKEN = "t"

[profiles.fast]
command = "nope"
`;
  const s = parseCodexToml(toml);
  assert.deepEqual(Object.keys(s), ['docs', 'other']);
  assert.equal(s.docs.command, 'npx');
  assert.deepEqual(s.docs.args, ['-y', 'some-server', '--flag']);
  assert.equal(s.docs.env.API_KEY, 'abc');
  assert.equal(s.other.url, 'https://example.com/mcp');
  assert.equal(s.other.env.TOKEN, 't');
});

test('loadServers finds Claude user, local and project configs, Cursor and Codex', () => {
  const home = tmp();
  const cwd = tmp();
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: { userA: { command: 'a' } },
      projects: { [cwd]: { mcpServers: { localB: { command: 'b' } } }, '/other': { mcpServers: { nope: { command: 'z' } } } },
    }),
  );
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { projC: { type: 'http', url: 'https://c' } } }));
  fs.mkdirSync(path.join(home, '.cursor'));
  fs.writeFileSync(path.join(home, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { userA: { command: 'a' }, curD: { command: 'd' } } }));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex/config.toml'), '[mcp_servers.codexE]\ncommand = "e"\n');
  const { servers, sources } = loadServers({ home, cwd, platform: 'linux', env: {} });
  const names = servers.map((s) => s.name).sort();
  assert.deepEqual(names, ['codexE', 'curD', 'localB', 'projC', 'userA']);
  assert.deepEqual(servers.find((s) => s.name === 'userA').sources, ['claude-code (user)', 'cursor (user)']);
  assert.ok(sources.includes('codex'));
  assert.equal(servers.find((s) => s.name === 'projC').cwd, cwd);
});

test('dedupe keeps servers with the same name but different commands', () => {
  const a = { name: 'x', transport: 'stdio', command: 'a', args: [], source: 's1' };
  const b = { name: 'x', transport: 'stdio', command: 'b', args: [], source: 's2' };
  assert.equal(dedupe([a, b]).length, 2);
  assert.equal(dedupe([a, { ...a, source: 's3' }]).length, 1);
});

// ---------- CLI ----------

test('CLI measures the demo config', () => {
  const out = execFileSync(process.execPath, [BIN, '--config', DEMO], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.match(out, /repo-tools\s+24\s+~[\d.]+k/);
  assert.match(out, /broken .*failed: exited early/);
  assert.match(out, /remote-docs .*skipped: legacy SSE/);
  assert.match(out, /Tax per request\s+~[\d.]+k tokens\s+\(26 tools\)/);
  assert.match(out, /Per 100 requests/);
});

test('CLI --json totals add up', () => {
  const j = JSON.parse(execFileSync(process.execPath, [BIN, '--config', DEMO, '--json'], { encoding: 'utf8' }));
  const ok = j.servers.filter((s) => s.status === 'ok');
  assert.equal(ok.length, 2);
  assert.equal(j.totalTokens, ok.reduce((s, x) => s + x.tokens, 0));
  assert.equal(j.per100Requests, j.totalTokens * 100);
  assert.equal(j.toolCount, 26);
});

test('CLI never prints env values, headers or arguments', () => {
  const d = tmp();
  const cfg = path.join(d, 'mcp.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      mcpServers: {
        secretive: { command: process.execPath, args: [FAKE, '--api-key-arg', 'ARG-SECRET-123'], env: { API_KEY: 'ENV-SECRET-456' } },
        remote: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer HDR-SECRET-789' } },
      },
    }),
  );
  for (const extra of [[], ['--json'], ['--list']]) {
    const r = spawnSync(process.execPath, [BIN, '--config', cfg, '--timeout', '5', ...extra], { encoding: 'utf8' });
    const all = r.stdout + r.stderr;
    for (const secret of ['ARG-SECRET-123', 'ENV-SECRET-456', 'HDR-SECRET-789']) {
      assert.ok(!all.includes(secret), `${secret} leaked with ${extra.join(' ') || 'default'} output`);
    }
  }
});

test('CLI --redact hides names; --only filters', () => {
  const red = execFileSync(process.execPath, [BIN, '--config', DEMO, '--redact', '--only', 'clock,repo-tools'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.ok(!red.includes('repo-tools') && !red.includes('clock'));
  assert.match(red, /server-1/);
  assert.match(red, /server-2/);
  assert.ok(!red.includes('server-3'));
});

test('CLI --list does not start servers', () => {
  const out = execFileSync(process.execPath, [BIN, '--config', DEMO, '--list'], { encoding: 'utf8' });
  assert.match(out, /repo-tools\s+node/);
  assert.match(out, /remote-docs\s+sse/);
});

test('CLI errors on a missing config file', () => {
  const r = spawnSync(process.execPath, [BIN, '--config', '/no/such/file.json'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
