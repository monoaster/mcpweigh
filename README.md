# mcpweigh

Measure how many tokens your MCP servers' tool definitions cost on every request.

Every MCP tool an agent can call comes with a name, a description and a JSON
schema. The agent sends all of them to the model with each request, before you
type a word. Add a few servers and that is thousands of tokens of context, every
turn. `mcpweigh` starts each server in your config, asks it for its tools and
tells you what each one costs.

## Demo

Four official reference servers from `@modelcontextprotocol` (latest from npm,
November 2026) plus GitHub's hosted server, which needs a login:

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "./files"] },
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },
    "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] },
    "sequential-thinking": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" }
  }
}
```

```
$ npx github:monoaster/mcpweigh --config mcp.json
mcpweigh  5 servers from mcp.json

  server               tools  ~tokens
  filesystem              16    ~2.6k  ████████████  39%
  everything              16    ~1.8k  ████████      27%
  memory                   9    ~1.8k  ████████      26%
  sequential-thinking      1     ~558  ██▌           8%
  github                   -        -  skipped: needs auth (HTTP 401)

  Heaviest tools
     ~558  sequential-thinking  sequentialthinking
     ~332  memory               search_nodes
     ~310  filesystem           edit_file
     ~274  everything           gzip-file-as-resource
     ~262  memory               read_graph
     ~262  memory               open_nodes
     ~246  filesystem           directory_tree
     ~231  filesystem           read_text_file
     ~214  memory               create_entities
     ~194  filesystem           search_files

  Tax per request   ~6.8k tokens  (42 tools)
  Per 100 requests  ~679k tokens
  Estimates: chars/4 of each tool's name, description and input schema.
```

With no `--config` it reads the configs your agents already use.

You can try it without installing any server. The repo ships a fake one:

```
git clone https://github.com/monoaster/mcpweigh && cd mcpweigh
npm run demo
```

## Install

No install needed. Node.js 20 or newer:

```
npx github:monoaster/mcpweigh
```

Or clone it and link the command:

```
git clone https://github.com/monoaster/mcpweigh
cd mcpweigh && npm link
mcpweigh --help
```

It has no dependencies.

## Usage

```
mcpweigh                    measure every server in every config it finds
mcpweigh --list             list configured servers, start nothing
mcpweigh --only github,db   measure just these servers
mcpweigh --config x.json    read only this config (repeatable)
mcpweigh --tools 25         show the 25 heaviest tools
mcpweigh --timeout 60       give slow servers 60s (default 30)
mcpweigh --redact           print server-1, server-2... instead of names
mcpweigh --no-http          skip remote servers
mcpweigh --json             machine-readable output
```

Configs it reads, from the current folder and your home folder:

| Client | File |
| --- | --- |
| Claude Code | `~/.claude.json` (user servers, and local servers for this folder), `.mcp.json` |
| Cursor | `~/.cursor/mcp.json`, `.cursor/mcp.json` |
| Claude Desktop | `claude_desktop_config.json` (macOS, Windows, Linux paths) |
| Codex CLI | `~/.codex/config.toml` (`[mcp_servers.*]`) |
| VS Code | `.vscode/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

A server that shows up in two configs with the same command is measured once.
`${VAR}` and `${VAR:-default}` in configs are expanded like Claude Code does.

## Agent setup

Add this to your `CLAUDE.md` or `AGENTS.md`:

```markdown
## MCP budget
When asked about context use, slow sessions or MCP servers, run
`npx -y github:monoaster/mcpweigh --redact` and suggest turning off servers
that cost a lot of tokens but are not needed for this project.
```

There is also a Claude Code skill in [`skill/mcpweigh/SKILL.md`](skill/mcpweigh/SKILL.md).
Copy the `skill/mcpweigh` folder to `~/.claude/skills/`.

## How it works

1. **Read configs.** It finds MCP servers in the files above and normalizes
   them into stdio servers (a command) or remote servers (a URL).
2. **Start and ask.** For each stdio server it starts the command, sends the
   MCP `initialize` handshake and then `tools/list` over JSON-RPC on stdin and
   stdout, following pagination. For remote servers it does the same over
   streamable HTTP, with JSON or SSE replies and the session header. All
   servers run in parallel, each with its own timeout. Then it stops them, and
   their child processes, with SIGTERM and then SIGKILL.
3. **Weigh.** For each tool it takes the JSON of `{name, description,
   input_schema}`, which is roughly what an agent sends to the model, and
   divides the length by 4. "Tax per request" is the sum over all servers.
   "Per 100 requests" is that times 100.

## Privacy and safety

- It runs the commands in your MCP configs, exactly as your agent would. Only
  run it on configs you trust.
- It never prints env values, headers or command arguments, and never prints
  a server's stderr. Those often hold API keys. The tests check this.
- `--redact` hides server names too, for screenshots.

## Limits

- Token counts are estimates (~4 characters per token). Real tokenizers differ
  by model. Clients also wrap tools in their own text, which this does not count.
- Prompt caching makes repeated tool definitions cheaper to pay for, but they
  still take up the same room in the context window.
- Some clients load tool definitions lazily when you have many tools (Claude
  Code's tool search, for example). Then the per-request cost can be lower than
  shown. Think of the number as the cost when every tool is loaded.
- Remote servers that need OAuth show as "needs auth" and are skipped. Static
  headers from the config (like an `Authorization` header) are used.
- The old SSE transport (`"type": "sse"`) is not supported.
- Only tools are counted. Resource and prompt lists are not sent to the model
  on every request, so they are left out.
- The Codex TOML reader handles the usual `[mcp_servers.*]` tables, not every
  TOML feature.

## License

MIT, see [LICENSE](LICENSE).
