# Gemini MCP Server — Session Handoff

## What This Is

An MCP (Model Context Protocol) server that exposes Google Gemini as a tool inside Claude Code. It wraps the `gemini` CLI (`@google/gemini-cli`) which is already authenticated via OAuth with your Google AI Ultra subscription. No API key needed — it piggybacks on your existing auth.

## Current State: WORKING

All tests pass. The server is registered with Claude Code at user scope and available in every project.

```
✓ Server initialized: gemini 1.0.0
✓ Found 1 tool(s): gemini
✓ Gemini 2.5 Flash — responds correctly
✓ Gemini 2.5 Pro — responds correctly
```

## File Locations

| Path | Purpose |
|------|---------|
| `/Users/meldridge/mcp/` | Standalone copy of the MCP server (this directory) |
| `/Users/meldridge/.claude/mcp-servers/gemini/` | Live installation (what Claude Code actually runs) |
| `~/.claude.json` | Claude Code config — has the MCP server registration |
| `~/.gemini/` | Gemini CLI config — OAuth creds, settings |

## GitHub Repo

https://github.com/meldridge-wm/gemini-mcp-server

## How It Works

1. Claude Code starts the MCP server process (`node server.mjs`) on session launch
2. When Claude calls the `gemini` tool, the server receives an MCP `tools/call` request
3. The server shells out to: `gemini -p "<prompt>" -m gemini-2.5-pro -o json`
4. The `gemini` CLI uses your cached OAuth token (Google AI Ultra plan)
5. Response is parsed from JSON and returned to Claude

## Architecture

```
Claude Code ──MCP protocol──> server.mjs ──child_process──> gemini CLI ──OAuth──> Gemini API
                (stdio)                    (execFile)        (cached)     (Ultra)
```

## Tool Schema

```json
{
  "name": "gemini",
  "inputSchema": {
    "properties": {
      "prompt": { "type": "string", "required": true },
      "model": { "enum": ["gemini-2.5-pro", "gemini-2.5-flash"], "default": "gemini-2.5-pro" },
      "context": { "type": "string", "description": "Optional code/file context" }
    }
  }
}
```

## Claude Code Registration

The server is registered in `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "gemini": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/meldridge/.claude/mcp-servers/gemini/server.mjs"]
    }
  }
}
```

## Dependencies

- `@google/gemini-cli` (v0.28.2) — installed globally via npm, authed via OAuth
- `@modelcontextprotocol/sdk` (v1.26.0) — MCP protocol SDK
- Node.js v25.6.1

## Gemini 3 Pro Upgrade Path

Gemini 3 Pro is available in the interactive CLI but NOT yet in headless mode (`-p` flag). When Google enables it:

1. Edit `server.mjs` line 21: change `'gemini-2.5-pro'` to `'gemini-3-pro'`
2. Update the `enum` in the tool schema (line 47)
3. That's it. Same auth, same flow.

Your WBD enterprise engineer said full Gemini 3 deployment is coming soon.

## Testing

```bash
cd /Users/meldridge/mcp
npm install   # if node_modules not present
node test.mjs # runs all 4 tests
```

## Key Gotchas

- The `gemini` CLI writes to stderr (credential loading, extension loading) — the server filters this noise
- Headless mode (`-p`) has a 120-second timeout per call
- The `gemini` CLI must be in PATH (installed at `/opt/homebrew/bin/gemini`)
- If OAuth token expires, run `gemini` interactively once to re-auth
