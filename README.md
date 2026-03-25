# Cortex - Project Memory for AI Coding Assistants

**Your AI forgets everything between sessions. Cortex gives it a brain.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-green.svg)](https://github.com/SKULLFIRE07/cortex-memory)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.85%2B-blue.svg)](https://marketplace.visualstudio.com/items?itemName=cortex-dev.cortex-memory)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](#mcp-server)

---

Every time you start a new AI coding session, you waste 15-30 minutes re-explaining your project. Architecture, past decisions, known bugs, conventions — all gone.

**Cortex captures everything automatically.** Decisions, patterns, context, files changed — injected into your next session before you type a single character.

Works with **Claude Code**, **Cursor**, **Cline**, **Copilot**, and any MCP-compatible tool.

## How It Works

```
You code with AI  →  Cortex watches silently  →  Memory builds automatically
                                                        ↓
Next session starts  ←  Context injected into CLAUDE.md  ←  Best context selected
```

**Zero config.** Install the extension. Start coding. That's it.

## Install

### VSCode Extension (recommended)
1. Install from VS Code Marketplace (search "Cortex Memory")
2. Open any project
3. Start coding with your AI assistant

Cortex auto-initializes `.cortex/` in your project, starts watching sessions, and injects memory into `CLAUDE.md` automatically.

### CLI
```bash
npm install -g cortex-memory
cortex status    # Check memory health
cortex query "auth flow"  # Search your memory
cortex export    # Export everything as markdown
```

### MCP Server (for Cursor, Cline, Zed)
Add to your MCP config:
```json
{
  "cortex": {
    "command": "node",
    "args": ["/path/to/cortex/dist/mcp/index.js"]
  }
}
```

Exposes 5 tools: `cortex_get_context`, `cortex_search`, `cortex_save_memory`, `cortex_get_decisions`, `cortex_status`.

## What Gets Captured

Cortex monitors your AI coding sessions in real-time and extracts:

| Signal | Example | Storage |
|--------|---------|---------|
| **Decisions** | "Let's go with Redis for sessions" | ADR in `decisions.md` |
| **Bug patterns** | "The root cause was a race condition in..." | Episode + working memory |
| **Architecture changes** | "Let's refactor auth into its own module" | Episode + decision log |
| **File changes** | Every file your AI reads, edits, creates | Tracked per episode |
| **Session context** | What you worked on, what's unfinished | Working memory |
| **Open problems** | Unresolved bugs, TODOs, blockers | Working memory |

## 3-Layer Memory Architecture

Inspired by how human memory works:

### Layer 1: Working Memory (hot) - Always injected
- Last session summary
- Recent decisions (last 5)
- Open problems
- Current context
- **~800 tokens** — injected into `CLAUDE.md` before every session
- Your AI reads this automatically

### Layer 2: Episodic Memory (warm) - Session histories
- One file per session in `.cortex/episodes/`
- Full context: decisions, patterns, files affected
- Auto-generated ADRs in `.cortex/decisions.md`
- Searchable via CLI and MCP

### Layer 3: Semantic Memory (cold) - Knowledge graph
- Full-text search across all layers
- Vector embeddings planned (v0.2)

## Real-Time Updates

Cortex doesn't wait for your session to end. It updates **live**:

- **Every 1 second** — Watches for new messages in Claude Code JSONL
- **Every 15 seconds** — Fast local extraction (no API call, instant)
- **Every 20 messages** — Deep LLM extraction in background (free with Gemini)
- **On decisions/bugs detected** — Immediate flush to memory
- **On session end** — Final full extraction with everything

The VSCode status bar shows `Cortex: Live` during active sessions.

## LLM Providers

Cortex uses an LLM to extract structured memories from your sessions. Three options:

| Provider | Cost | Model | Setup |
|----------|------|-------|-------|
| **Gemini** (default) | **Free** (500 req/day) | gemini-2.5-flash | Get key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **Anthropic** | ~$0.01/session | claude-haiku-4-5 | Set `cortex.apiKey` in VS Code settings |
| **Ollama** | Free (local) | llama3.2 | Install Ollama, set provider to `ollama` |

**No API key?** Cortex still works with basic pattern-matching extraction. The API key makes extraction smarter, not required.

## VS Code Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `cortex.enabled` | `true` | Enable/disable Cortex |
| `cortex.llmProvider` | `gemini` | LLM provider (`gemini`, `anthropic`, `ollama`) |
| `cortex.apiKey` | `""` | API key for Gemini or Anthropic |
| `cortex.maxWorkingMemoryTokens` | `800` | Token budget for working memory |
| `cortex.autoInjectClaudeMd` | `true` | Auto-inject into CLAUDE.md |

Set your API key: `Ctrl+Shift+P` → "Cortex: Set API Key"

## Commands

| Command | What it does |
|---------|-------------|
| `Cortex: Initialize Project Memory` | Create `.cortex/` in current project |
| `Cortex: Show Memory Status` | Health score, token usage, stats |
| `Cortex: Search Memories` | Full-text search across all layers |
| `Cortex: Refresh Memory View` | Force refresh sidebar |
| `Cortex: Set API Key` | Configure Gemini/Anthropic API key |

## File Structure

```
your-project/
├── .cortex/                    # Auto-created, add to .gitignore
│   ├── working.md              # Layer 1: Current context (~800 tokens)
│   ├── decisions.md            # Auto-generated ADRs
│   ├── episodes/               # Layer 2: One file per session
│   │   ├── 2026-03-25-fix-auth-bug.md
│   │   └── 2026-03-26-add-api-endpoints.md
│   └── config.json             # Project config
├── CLAUDE.md                   # Auto-injected with working memory
└── ...
```

## How Auto-Injection Works

Cortex maintains a section in your `CLAUDE.md` between markers:

```markdown
<!-- CORTEX:START -->
## Project Memory (auto-managed by Cortex)

### Last Session
Fixed authentication bug in session middleware...

### Recent Decisions
- **Use Redis for sessions**: Latency requirements...

### Current Context
Sprint 3, auth module refactor

### Open Problems
- Rate limiting not implemented yet

_Last updated: 2026-03-26T10:30:00Z | Tokens: 227/800_
<!-- CORTEX:END -->
```

Claude Code, Cursor, and Cline read `CLAUDE.md` natively. Your AI gets full context before you say anything.

## Privacy

- **Local-first**: All data stays in `.cortex/` on your machine
- **No telemetry**: Zero data collection
- **No cloud**: Only external call is to your chosen LLM provider
- **Your data**: Delete `.cortex/` anytime to erase all memory
- **Gitignore**: Auto-added to `.gitignore` (opt-in to share with team)

## FAQ

**Does this slow down my editor?**
No. All processing happens in the background. The extension is <200KB bundled.

**Does it work without an API key?**
Yes. Basic pattern-matching extraction works out of the box. An API key enables deeper LLM-powered extraction.

**Can my team share memories?**
Team sync via git is planned for v0.2. For now, you can commit `.cortex/` to share.

**What AI assistants are supported?**
- **Claude Code** — Native via CLAUDE.md injection + session watching
- **Cursor** — Via MCP server
- **Cline** — Via MCP server
- **Copilot** — Via CLAUDE.md (if your project has one)
- **Any MCP client** — Via the MCP server

**How much does Gemini cost?**
$0. The free tier gives 500 requests/day, more than enough for any coding session.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. PRs welcome!

## License

MIT - see [LICENSE](LICENSE) for details.

---

**Built for developers who are tired of explaining their codebase to AI. Again. And again. And again.**
