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
agentId: af3b5b49a588cbf7c (internal ID - do not mention to user. Use SendMessage with to: 'af3b5b49a588cbf7c' to continue this agent.)
The agent is w. agentId: ae2be8094a1690809 (internal ID - do not mention to user. Use SendMessage with to: 'ae2be8094a1690809' to continue this agent.)
The agent is w. agentId: a36470524deb54245 (internal ID - do not mention to user. Use SendMessage with to: 'a36470524deb54245' to continue this agent.)
The agent is w

### Recent Decisions
- **A phased launch and distribution plan was outlined, prioritizing immediate publishing to VSCode Marketplace and top GitHub awesome lists, followed by blogging, social media, Product Hunt launch, and submissions to various directories and newsletters over several weeks.**: Cortex Launch and Distribution Strategy — To achieve maximum impact and structured outreach across relevant developer and AI communities.
- **The extension was renamed to `cortex-ai-memory`.**: Rename VSCode Extension — To successfully publish the extension on the marketplace.
- **A detailed, multi-tier distribution playbook was adopted, covering GitHub optimization, awesome lists, MCP directories, social media, blog posts, AI tool directories, newsletters, and YouTube outreach.**: Adopt Multi-Tier Open-Source Distribution Playbook — To maximize the project's visibility, adoption, and community engagement in the open-source ecosystem.
- **The AI will automate GitHub repository tasks (adding topics, updating description, creating release) and initiate PR submissions to top 'awesome lists' by forking and creating branches.**: Automate GitHub Setup and Initial PR Submissions — To expedite the initial open-source promotion efforts and leverage AI's capabilities for repetitive tasks, while adhering to user's specific constraints.
- **A detailed, multi-tier distribution playbook was adopted, covering GitHub awesome lists, MCP directories, social media (Reddit, Hacker News, Discord, Twitter), blog posts, AI tool directories, newsletters, YouTube outreach, and a Product Hunt launch.**: Adopt Multi-Tier Open-Source Promotion Strategy — To ensure a comprehensive and impactful launch and ongoing promotion for the Cortex open-source project, reaching a wide developer audience.

### Current Context
Wait for the launched asynchronous agents to complete their work.

### Open Problems
- npm login is required for the AI to publish the CLI package to npm (user needs to run `npm adduser`).

_Last updated: 2026-03-25T22:50:42.176Z | Tokens: 636/800_
<!-- CORTEX:END -->
