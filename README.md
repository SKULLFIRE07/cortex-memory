# Cortex - AI Memory for Your Codebase

Cortex gives AI coding assistants (Claude, Cursor, Cline) a persistent memory layer so they remember your codebase context across sessions. Stop re-explaining architecture, conventions, and decisions every time you start a new conversation.

## Features

- **Automatic memory extraction** -- learns from your coding sessions and stores key context (architecture decisions, conventions, gotchas) in a local knowledge base.
- **Working memory injection** -- surfaces the most relevant memories directly into CLAUDE.md so your AI assistant has the right context before you even ask.
- **Sidebar overview** -- browse memory layers and monitor memory health from the VS Code activity bar.
- **Team sync** -- optionally share project memories with your team via git.
- **Search** -- full-text search across all stored memories.
- **Pin/unpin** -- promote critical memories so they always appear in context.

## Getting Started

1. Install the extension from the VS Code marketplace.
2. Open the Command Palette and run **Cortex: Initialize Project Memory** (`cortex.init`).
3. Start coding with your AI assistant as usual. Cortex runs in the background.

## Commands

| Command | Description |
|---------|-------------|
| `Cortex: Initialize Project Memory` | Set up Cortex in the current workspace |
| `Cortex: Show Memory Status` | View memory layer statistics |
| `Cortex: Sync Team Memory` | Push/pull shared memories via git |
| `Cortex: Search Memories` | Full-text search across all memories |
| `Cortex: Refresh Memory View` | Refresh the sidebar tree view |
| `Cortex: Pin Memory` | Pin a memory so it always appears in context |
| `Cortex: Unpin Memory` | Remove a pinned memory from always-on context |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `cortex.enabled` | `true` | Enable or disable the memory system |
| `cortex.anthropicApiKey` | `""` | Anthropic API key (uses Haiku for extraction) |
| `cortex.maxWorkingMemoryTokens` | `800` | Token budget for injected working memory |
| `cortex.autoInjectClaudeMd` | `true` | Auto-inject working memory into CLAUDE.md |
| `cortex.extractionModel` | `claude-haiku-4-5-20251001` | Model used for memory extraction |
| `cortex.teamSyncEnabled` | `false` | Enable git-based team memory sync |

## Requirements

- VS Code 1.85.0 or later
- An Anthropic API key (for memory extraction via Claude Haiku)
- Node.js 18+ (for the optional CLI)

## License

MIT
