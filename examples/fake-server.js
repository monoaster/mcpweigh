#!/usr/bin/env node
// A tiny fake MCP server over stdio, for tests and the demo.
// It answers initialize and tools/list (with pagination) and nothing else.
//
//   node fake-server.js [--tools N] [--page-size N] [--profile small|big]
//                       [--hang] [--crash] [--noisy]
//
// --hang   never answers (tests the timeout)
// --crash  exits right away (tests error handling)
// --noisy  prints a non-JSON log line to stdout first (some servers do)

import readline from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};

if (flag('--crash')) process.exit(3);

const profile = opt('--profile', 'small');
const pageSize = Number(opt('--page-size', '0')) || Infinity;

// A few realistic tool shapes. "big" ones look like the long, schema-heavy
// tools that real servers ship.
const SMALL = [
  {
    name: 'get_time',
    description: 'Get the current time in a time zone.',
    inputSchema: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'IANA zone, e.g. Europe/Paris' } },
      required: ['timezone'],
    },
  },
  {
    name: 'echo',
    description: 'Echo back the input text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

function bigTool(i) {
  const verbs = ['create', 'update', 'list', 'get', 'delete', 'search', 'merge', 'comment_on'];
  const nouns = ['issue', 'pull_request', 'branch', 'file', 'release', 'workflow_run', 'label', 'project'];
  const verb = verbs[i % verbs.length];
  const noun = nouns[Math.floor(i / verbs.length) % nouns.length];
  return {
    name: `${verb}_${noun}${i >= 64 ? '_' + i : ''}`,
    description:
      `Use this tool to ${verb.replace('_', ' ')} a ${noun.replace('_', ' ')} in a repository. ` +
      'Returns the full object as JSON, including metadata, timestamps and links. ' +
      'Requires the repository owner and name. Respects the caller permissions and ' +
      'returns a clear error if the object does not exist or access is denied.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (user or organization)' },
        repo: { type: 'string', description: 'Repository name' },
        id: { type: 'number', description: `The ${noun.replace('_', ' ')} number` },
        title: { type: 'string', description: 'Title, when creating or updating' },
        body: { type: 'string', description: 'Body text in Markdown' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state' },
        per_page: { type: 'number', minimum: 1, maximum: 100, description: 'Results per page' },
        page: { type: 'number', minimum: 1, description: 'Page number' },
      },
      required: ['owner', 'repo'],
    },
  };
}

const count = Number(opt('--tools', profile === 'big' ? '24' : '2'));
const TOOLS =
  profile === 'big'
    ? Array.from({ length: count }, (_, i) => bigTool(i))
    : Array.from({ length: count }, (_, i) => {
        const t = structuredClone(SMALL[i % SMALL.length]);
        if (i >= SMALL.length) t.name += '_' + i;
        return t;
      });

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

if (flag('--noisy')) process.stdout.write('fake-server starting up\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (flag('--hang')) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notification
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-server', version: '1.0.0' },
      },
    });
  } else if (msg.method === 'tools/list') {
    const start = Number(msg.params?.cursor ?? 0);
    const end = Math.min(start + pageSize, TOOLS.length);
    const result = { tools: TOOLS.slice(start, end) };
    if (end < TOOLS.length) result.nextCursor = String(end);
    send({ jsonrpc: '2.0', id: msg.id, result });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
rl.on('close', () => process.exit(0));
