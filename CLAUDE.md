# Cortex

## Project Overview
Cortex is a VSCode extension that gives AI coding assistants persistent memory across sessions. It auto-captures decisions, patterns, and context from Claude Code, Cursor, and Cline sessions.

## Architecture
- `src/extension/` — VSCode extension entry point, sidebar providers
- `src/engine/` — Core memory system (orchestrator, watcher, extractor, injector, memory store)
- `src/cli/` — CLI tool (`cortex init`, `cortex status`, `cortex query`)
- `src/mcp/` — MCP server for Cursor/Cline integration
- `src/types/` — Shared TypeScript types

## Build
```
npm run build        # Extension
npm run build:cli    # CLI
npm run build:mcp    # MCP server
```

## Key Design Decisions
- 3-layer memory: working (hot), episodic (warm), semantic (cold)
- Real-time: updates every 15s with local extraction, LLM extraction every 20 messages
- Zero-config: auto-initializes .cortex/ on first activation
- Multi-provider: Gemini (free), Anthropic, Ollama

<!-- CORTEX:START -->
## Project Memory (auto-managed by Cortex)

### Last Session
[tool: Bash `# Stash changes first, rewrite history, then unstash
git stash 2>&1`]. I see the extension reverted several of our source files. Let me unstash our changes, rewrite history to remove co-author, then push everything:. Your branch is up to date with 'origin/master'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "g

### Recent Decisions
- **The description was set to 'Persistent AI memory for coding assistants. Auto-captures decisions, patterns, and context from Claude Code, Cursor, and Cline sessions. Never re-explain your codebase again.'**: Update Extension Description — To accurately describe the extension's functionality for the marketplace.
- **The logo was set to `media/icon.png` from the project folder.**: Update Extension Logo — To provide a visual identity for the extension in the marketplace.
- **The source code repository URL was set to `https://github.com/aryan-budukh/cortex` (or the user's actual GitHub repo URL).**: Update Source Code Repository URL — To link the extension to its public source code repository.
- **The assistant redesigned the `brain.svg` icon and created a new `icon.svg` for marketplace conversion, aiming for a clean, modern look.**: Redesign Cortex Icon — To improve the visual appeal of the extension based on user feedback and prepare a suitable icon for the marketplace.
- **The `package.json` file was updated to reflect the correct GitHub repository URL: `github.com/SKULLFIRE07/cortex-memory`.**: Update package.json Repository URL — To ensure consistency and correctness of metadata for publishing and GitHub integration.

### Current Context
Publish Cortex to the VSCode Marketplace.; Tag the GitHub repository with relevant topics (e.g., `vscode-extension`, `claude`, `mcp`, `ai-tools`, `llm`, `memory`, `claude-code`).; Submit pull requests to the top 5 high-impact GitHub Awesome lists.; Write and publish an article on Dev.to.; Post a 'Show HN' on Hacker News.; Submit Cortex to DevHunt.; Create and post about Cortex in relevant Reddit communities.; Prepare for and execute a Product Hunt launch.; Submit Cortex to MCP and AI tool directories.; Submit to the remaining GitHub Awesome lists.; Pitch Cortex to developer newsletters.; Consider participating in relevant hackathons.

### Open Problems
- Saved working directory and index state WIP on master: b8cfb2d Fix token budget display and remaining Recall references

_Last updated: 2026-03-25T22:30:54.586Z | Tokens: 745/800_
<!-- CORTEX:END -->
