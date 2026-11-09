// A tiny MCP client: initialize + tools/list, over stdio or streamable HTTP.
import { spawn } from 'node:child_process';

export const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'mcpweigh', version: '0.1.0' };

export class McpError extends Error {
  constructor(message, kind = 'error') {
    super(message);
    this.kind = kind; // 'error' | 'timeout' | 'auth' | 'unsupported'
  }
}

async function listAllTools(request) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 100; page++) {
    const res = await request('tools/list', cursor ? { cursor } : {});
    tools.push(...(res?.tools ?? []));
    cursor = res?.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

const initParams = () => ({
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: CLIENT_INFO,
});

// ---------- stdio ----------

export function listToolsStdio(server, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    let child;
    try {
      child = spawn(server.command, server.args ?? [], {
        cwd: server.cwd,
        env: { ...process.env, ...(server.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: win,
        detached: !win, // own process group, so we can kill npx and its children
        windowsHide: true,
      });
    } catch (e) {
      reject(new McpError(`could not start: ${e.code ?? e.message}`));
      return;
    }

    let done = false;
    let nextId = 1;
    const pending = new Map();
    let buf = '';

    const kill = () => {
      try {
        child.stdin.end();
      } catch {}
      const sig = (s) => {
        try {
          if (!win && child.pid) process.kill(-child.pid, s);
          else child.kill(s);
        } catch {}
      };
      sig('SIGTERM');
      const t = setTimeout(() => sig('SIGKILL'), 1000);
      t.unref();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      kill();
      for (const p of pending.values()) p.reject(err ?? new McpError('closed'));
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new McpError(`no answer within ${Math.round(timeout / 1000)}s`, 'timeout')),
      timeout,
    );

    const write = (msg) => {
      try {
        child.stdin.write(JSON.stringify(msg) + '\n');
      } catch {}
    };

    const request = (method, params) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        write({ jsonrpc: '2.0', id, method, params });
      });

    child.on('error', (e) =>
      finish(new McpError(e.code === 'ENOENT' ? `command not found: ${server.command}` : `could not start: ${e.code ?? e.message}`)),
    );
    child.on('exit', (code, signal) => {
      if (!done) finish(new McpError(`exited early (${signal ?? 'code ' + code})`));
    });
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {}); // drain; never printed (may hold secrets)

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue; // stray log output
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        handle(msg);
      }
    });

    function handle(msg) {
      if (msg.method && msg.id !== undefined) {
        // A request from the server (ping, roots/list, ...).
        if (msg.method === 'ping') write({ jsonrpc: '2.0', id: msg.id, result: {} });
        else write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
        return;
      }
      if (msg.id === undefined) return; // notification
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new McpError(`server error: ${String(msg.error.message ?? msg.error.code).slice(0, 120)}`));
      else p.resolve(msg.result);
    }

    (async () => {
      const init = await request('initialize', initParams());
      write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const tools = await listAllTools(request);
      return { tools, serverInfo: init?.serverInfo, protocolVersion: init?.protocolVersion };
    })().then(
      (v) => finish(null, v),
      (e) => finish(e instanceof McpError ? e : new McpError(e.message)),
    );
  });
}

// ---------- streamable HTTP ----------

async function readSseFor(res, id, signal) {
  const decoder = new TextDecoder();
  let buf = '';
  let data = [];
  for await (const chunk of res.body) {
    if (signal.aborted) break;
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        if (data.length) {
          try {
            const msg = JSON.parse(data.join('\n'));
            if (msg.id === id) return msg;
          } catch {}
        }
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  throw new McpError('stream ended without a reply');
}

export async function listToolsHttp(server, { timeout = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let sessionId;
  let nextId = 1;
  const baseHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(server.headers ?? {}),
  };

  const post = async (body) => {
    const headers = { ...baseHeaders };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (body.method !== 'initialize') headers['mcp-protocol-version'] = PROTOCOL_VERSION;
    const res = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new McpError(`needs auth (HTTP ${res.status})`, 'auth');
    }
    if (res.status === 404 || res.status === 405) {
      throw new McpError(`HTTP ${res.status}; not a streamable HTTP endpoint?`, 'unsupported');
    }
    if (!res.ok && res.status !== 202) throw new McpError(`HTTP ${res.status}`);
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    return res;
  };

  const request = async (method, params) => {
    const id = nextId++;
    const res = await post({ jsonrpc: '2.0', id, method, params });
    const type = res.headers.get('content-type') ?? '';
    let msg;
    if (type.includes('text/event-stream')) {
      msg = await readSseFor(res, id, ctrl.signal);
      res.body?.cancel?.().catch(() => {});
    } else {
      msg = await res.json();
      if (Array.isArray(msg)) msg = msg.find((m) => m.id === id);
    }
    if (!msg) throw new McpError('empty reply');
    if (msg.error) throw new McpError(`server error: ${String(msg.error.message ?? msg.error.code).slice(0, 120)}`);
    return msg.result;
  };

  try {
    const init = await request('initialize', initParams());
    const n = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await n.body?.cancel?.().catch(() => {});
    const tools = await listAllTools(request);
    if (sessionId) {
      fetch(server.url, {
        method: 'DELETE',
        headers: { ...(server.headers ?? {}), 'mcp-session-id': sessionId },
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
    }
    return { tools, serverInfo: init?.serverInfo, protocolVersion: init?.protocolVersion };
  } catch (e) {
    if (ctrl.signal.aborted) throw new McpError(`no answer within ${Math.round(timeout / 1000)}s`, 'timeout');
    if (e instanceof McpError) throw e;
    throw new McpError(`could not connect (${e.cause?.code ?? e.message})`);
  } finally {
    clearTimeout(timer);
  }
}

export function listTools(server, opts) {
  if (server.transport === 'stdio') return listToolsStdio(server, opts);
  if (server.transport === 'http') return listToolsHttp(server, opts);
  return Promise.reject(new McpError(`${server.transport} transport not supported`, 'unsupported'));
}
