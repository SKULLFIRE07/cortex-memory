# Cortex - Project Memory for AI Coding Assistants

> **Your AI forgets everything between sessions. Cortex gives it a brain.**

Every time you start a new AI coding session, you waste 15-30 minutes re-explaining your project. Architecture, past decisions, known bugs, conventions — all gone.

**Cortex captures everything automatically** and injects it into your next session before you type a single character.

Works with **Claude Code** | **Cursor** | **Cline** | **Copilot** | **Any MCP client**

---

## Why Cortex?

| Without Cortex | With Cortex |
|---|---|
| "Here's my project structure again..." | AI already knows your architecture |
| "We decided to use Redis because..." | Decision auto-captured with full context |
| "The bug was in the auth middleware..." | Bug pattern recorded, never repeated |
| "Don't touch that file, it's..." | Convention remembered across sessions |
| 15-30 min context loading per session | **0 min.** Full context injected automatically |

---

## How It Works

```
You code with AI  -->  Cortex watches silently  -->  Memory builds automatically
                                                           |
Next session starts  <--  Context injected into CLAUDE.md  <--  Best context selected
```

**Install. Code. That's it.** Zero configuration needed.

---

## Features

### Real-Time Memory Capture
Cortex monitors your AI sessions live — not just at the end:
- **Every 1 second** — Watches for new messages
- **Every 15 seconds** — Fast local extraction (no API call)
- **Every 20 messages** — Deep LLM extraction in background
- **On decisions/bugs detected** — Immediate capture
- Status bar shows `Cortex: Live` during active sessions

### 3-Layer Memory Architecture
Inspired by how human memory works:

**Layer 1: Working Memory (hot)** — Always injected (~800 tokens)
- Last session summary, recent decisions, open problems
- Auto-injected into `CLAUDE.md` before every session
- Your AI reads this automatically

**Layer 2: Episodic Memory (warm)** — Session histories
- One file per session with full context
- Auto-generated Architectural Decision Records (ADRs)
- Searchable via CLI and MCP

**Layer 3: Semantic Memory (cold)** — Knowledge graph
- Full-text search across all layers
- Vector embeddings (coming in v0.2)

### Auto-Generated Decision Logs
Every architectural decision captured with:
- What was decided and why
- Alternatives considered
- Files affected
- Full session context

### VSCode Sidebar
- Memory Layers tree view (Working, Episodes, Decisions)
- Memory Health dashboard (0-100 score)
- Token budget tracking
- Live updates during sessions

### CLAUDE.md Auto-Injection
```markdown
<!-- CORTEX:START -->
## Project Memory (auto-managed by Cortex)

### Last Session
Fixed authentication bug in session middleware...

### Recent Decisions
- **Use Redis for sessions**: Latency requirements...

### Open Problems
- Rate limiting not implemented yet

_Last updated: 2026-03-26T10:30:00Z | Tokens: 227/800_
<!-- CORTEX:END -->
```
Claude Code, Cursor, and Cline read `CLAUDE.md` natively.

---

## Quick Start

### 1. Install
Search **"Cortex Memory"** in VS Code Extensions, or:
```
ext install cortex-dev.cortex-memory
```

### 2. (Optional) Add a free API key for smarter extraction
- Get a free Gemini key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- Run `Ctrl+Shift+P` → **Cortex: Set API Key** → paste key

### 3. Code
Start coding with your AI assistant. Cortex runs silently in the background.

> Works without an API key too — basic pattern-matching extraction runs locally.

---

## What Gets Captured

| Signal | Example | Where It's Stored |
|--------|---------|-------------------|
| **Decisions** | "Let's go with Redis for sessions" | `decisions.md` (ADR format) |
| **Bug patterns** | "Root cause was a race condition" | Episode + working memory |
| **Architecture** | "Refactor auth into its own module" | Episode + decision log |
| **File changes** | Every file read, edited, created | Tracked per episode |
| **Session context** | What you worked on, what's next | Working memory |
| **Open problems** | Unresolved bugs, TODOs | Working memory |

---

## LLM Providers

| Provider | Cost | Setup |
|----------|------|-------|
| **Gemini** (default) | **Free** (500 req/day) | Get key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **Anthropic** | ~$0.01/session | Set `cortex.apiKey` in settings |
| **Ollama** | Free (local) | Install Ollama, set provider to `ollama` |
| **No API key** | Free | Works with basic pattern matching |

---

## CLI Tool

```bash
npm install -g cortex-memory

cortex status              # Memory health score
cortex query "auth flow"   # Search across all layers
cortex export              # Export as single markdown
```

## MCP Server (Cursor, Cline, Zed)

```json
{
  "cortex": {
    "command": "node",
    "args": ["path/to/cortex/dist/mcp/index.js"]
  }
}
```

Tools: `cortex_get_context` | `cortex_search` | `cortex_save_memory` | `cortex_get_decisions` | `cortex_status`

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `cortex.llmProvider` | `gemini` | Provider: `gemini`, `anthropic`, `ollama` |
| `cortex.apiKey` | — | API key for Gemini or Anthropic |
| `cortex.maxWorkingMemoryTokens` | `800` | Token budget for working memory |
| `cortex.autoInjectClaudeMd` | `true` | Auto-inject into CLAUDE.md |

## Commands

| Command | Description |
|---------|-------------|
| **Cortex: Set API Key** | Configure your LLM API key |
| **Cortex: Show Memory Status** | Health score, token usage, stats |
| **Cortex: Search Memories** | Full-text search |
| **Cortex: Refresh Memory View** | Force refresh sidebar |
| **Cortex: Initialize Project Memory** | Manual init (usually automatic) |

---

## Privacy

- **100% local** — All data in `.cortex/` on your machine
- **No telemetry** — Zero data collection, zero tracking
- **No cloud** — Only external call is to your chosen LLM
- **Your data** — Delete `.cortex/` to erase everything
- **Git-safe** — Auto-added to `.gitignore`

---

## Supported AI Assistants

| Assistant | Integration | How |
|-----------|------------|-----|
| **Claude Code** | Native | CLAUDE.md injection + session watching |
| **Cursor** | MCP | Via MCP server |
| **Cline** | MCP | Via MCP server |
| **Copilot** | Passive | Reads CLAUDE.md if present |
| **Zed** | MCP | Via MCP server |
| **Continue** | MCP | Via MCP server |

---

## FAQ

**Does this slow down my editor?**
No. <200KB bundle. All processing in background.

**Does it work without an API key?**
Yes. Basic extraction works out of the box. API key enables deeper LLM-powered extraction.

**How much does Gemini cost?**
$0. Free tier = 500 requests/day. More than enough.

**Can my team share memories?**
Team sync via git planned for v0.2. You can commit `.cortex/` to share now.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome.

## License

MIT

---

**Stop explaining your codebase to AI. Let Cortex remember it for you.**
