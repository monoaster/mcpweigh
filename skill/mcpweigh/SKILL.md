---
name: mcpweigh
description: Measure how many tokens the configured MCP servers' tool definitions add to every model request, per server and per tool. Use when the user asks why context fills up fast, how expensive their MCP setup is, which MCP servers to turn off, or before adding another MCP server.
---

# mcpweigh

`mcpweigh` starts each MCP server from the user's configs (Claude Code, Cursor,
Claude Desktop, Codex, VS Code, Windsurf), calls `tools/list`, and estimates the
tokens of every tool's name, description and input schema (~4 chars per token).

## How

1. Run `npx -y github:monoaster/mcpweigh --list` first to see which servers are
   configured. This starts nothing.
2. Run `npx -y github:monoaster/mcpweigh --redact` to measure them. Drop
   `--redact` only if the user is fine with server names in the output. Add
   `--json` to parse the result, `--only a,b` to measure some servers,
   `--timeout 60` for slow `npx` servers.
3. Report the "Tax per request" line and the two or three heaviest servers.
   Suggest disabling servers the current project does not need. Do not edit
   MCP configs yourself unless the user asks.

It runs the commands in the user's MCP configs, the same way their agent does.
It never prints env values, headers or arguments. Numbers are estimates; say "~".
