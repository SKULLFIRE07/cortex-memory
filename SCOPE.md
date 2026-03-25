# CORTEX - Product Scope Document

## What Is Cortex?

**Cortex is a Project Memory OS that gives AI coding assistants a permanent, layered brain for your codebase.**

It ensures Claude (and eventually Cursor, Cline, Windsurf) never forgets what you built, why you built it, what you decided, and what went wrong -- across sessions, across team members, across projects.

It ships as a **VSCode extension** + **CLI tool**, runs **100% locally**, and integrates with Claude Code via its native hooks system.

---

## The Problem We Solve

| Pain Point | Cost |
|---|---|
| Re-explaining project context every session | 15-30 min wasted per session |
| "Why did we build it this way?" -- nobody remembers | Architecture drift, repeated mistakes |
| New team member onboarding | $7,500-$28,000 per hire, 3-9 months to productivity |
| AI makes decisions that contradict past ones | Bugs, rework, wasted cycles |
| Senior devs context-switching across 5+ projects | Each project needs fresh re-onboarding |

**Every AI coding tool today has amnesia. Cortex gives them a brain.**

---

## Why Cortex Wins (Competitive Moat)

### What Exists Today (Competitors)

| Tool | What It Does | What It Lacks |
|---|---|---|
| **Anthropic MEMORY.md** | Auto-saves notes, flat file, 200 lines | No layers, no team sync, no decisions, no search |
| **Recall MCP (recallmcp.com)** | MCP memory server, hooks | No layers, no IDE UI, no team, no cross-project |
| **claude-mem** | 2-layer within-session compression | No cross-session intelligence, no team, no ADRs |
| **Recallium** | Cross-IDE memory clustering | No decision logs, no team sync, no knowledge graph |
| **Cline Memory Bank** | Manual markdown methodology | Manual! Not automated. No extraction. |
| **Pieces.app** | Smart clipboard for snippets | Not project memory, no session awareness |

### What Makes Cortex Different (Our 5 Weapons)

**1. 3-Layer Memory Architecture (Nobody Has This)**
```
LAYER 1: WORKING MEMORY (hot)     -- Always injected, ~800 tokens
   Last 3 sessions, current sprint, recent decisions

LAYER 2: EPISODIC MEMORY (warm)   -- Injected when relevant
   Feature histories, bug patterns, architectural decisions with WHY

LAYER 3: SEMANTIC MEMORY (cold)   -- Queryable on demand
   Full knowledge graph, all decisions ever, searchable via embeddings
```
Every competitor uses a flat file or single layer. We use the same architecture as human memory.

**2. Auto-Generated Decision Logs (ADRs)**
Every architectural decision captured automatically with context:
```
Decision: Use Redis over Postgres for sessions
Date: 2026-03-10
Context: Scaling issues with session queries >10k users
Alternatives: Postgres JSONB, Memcached
Reason: Latency requirements, team Redis familiarity
Files affected: /auth/session.ts, /config/cache.ts
```
No existing tool does this. Manual ADR tools exist (adr-tools, Log4brains) but none auto-capture from AI conversations.

**3. Team Sync via Git**
```bash
cortex sync --team
```
- Memory commits to a shared branch
- New team member runs `cortex init` -> instant full project context
- Onboarding time: months -> hours
- No competitor has team-shared AI memory

**4. Cross-Project Intelligence**
If you work on 5 projects, Cortex learns:
- Your personal coding patterns across all projects
- Mistakes you repeat
- Solutions from Project A that apply to Project B
- No competitor does cross-project learning

**5. Visual Memory Browser (VSCode Sidebar)**
- Every competitor is CLI-only or MCP-only (invisible)
- Cortex has a real UI: browse memories, pin/unpin, edit, see memory health
- Developers can SEE and TRUST what their AI remembers

---

## Who Will Use It

### Primary Users (Month 1-6)
- **Solo developers using Claude Code** (2M+ Cursor users, growing Claude Code base)
- Pain: Re-explaining context every session
- Value: "Claude remembers everything from yesterday"
- Price sensitivity: $9/mo is impulse buy

### Growth Users (Month 3-12)
- **Small teams (2-10 devs)** using AI coding tools
- Pain: Onboarding new devs, knowledge silos, architecture drift
- Value: "New engineer gets context of a 2-year veteran on day one"
- Price sensitivity: $29/seat/mo justified by onboarding savings

### Enterprise Users (Month 6+)
- **Engineering orgs (10-100+ devs)**
- Pain: $7,500-$28,000 per hire onboarding cost, 3-9 months ramp
- Value: Cut onboarding time by 50%+, auto-generated ADRs for compliance
- Price sensitivity: $49/seat/mo trivial vs onboarding costs

### Why They Pay (Not Use Free Alternatives)

| Free Alternative | Why Cortex Wins |
|---|---|
| MEMORY.md (Anthropic) | Flat file, 200 lines, no search, no team, no decisions |
| claude-mem (OSS) | Within-session only, no cross-session, no team, AGPL license |
| Manual CLAUDE.md | Takes 15-30 min/session to maintain manually |
| Recall MCP (free) | No UI, no layers, no team sync, no cross-project |

**The lock-in moat**: After 6 months of Cortex, switching means losing your entire project brain. That's real retention.

---

## Can It Be a VSCode Extension? YES.

### Technical Proof (From Research)

| Capability | How It Works | Feasibility |
|---|---|---|
| Detect Claude Code sessions | Claude Code hooks (`SessionStart`, `SessionEnd`, `PreCompact`) + `~/.claude/ide/*.lock` files | Proven, documented API |
| Monitor conversations | Tail JSONL files at `~/.claude/projects/{project}/{session}.jsonl` | Append-only, easy to tail |
| Sidebar memory browser | VSCode TreeView API + WebviewView for dashboard | Standard extension API |
| Auto-inject into CLAUDE.md | File write with `<!-- CORTEX:START -->` section markers | Simple, atomic writes |
| Semantic search | LanceDB (embedded) + Transformers.js (local embeddings) | No server needed, runs in-process |
| File watching | VSCode FileSystemWatcher (workspace) + chokidar (outside workspace) | Battle-tested |

### What the Extension Looks Like

```
[Activity Bar Icon: Brain]

CORTEX SIDEBAR
├── Working Memory (hot)
│   ├── Last session summary
│   ├── Current sprint context
│   └── Recent decisions (3)
├── Episodes (warm)
│   ├── Feature: Auth system (12 sessions)
│   ├── Bug: Memory leak fix (3 sessions)
│   └── Refactor: API layer (8 sessions)
├── Decisions (auto ADRs)
│   ├── Use Redis for sessions
│   ├── Switch to functional patterns
│   └── Drop microservices approach
├── Memory Health: 87/100
│   ├── Token budget: 743/800
│   ├── Stale warnings: 1
│   └── Last updated: 2 hours ago
└── [Search memories...]
```

### Integration Architecture

```
Claude Code Session
    │
    ├── SessionStart hook ──> Cortex injects context into CLAUDE.md
    │
    ├── During session ──> Cortex tails JSONL, detects signals
    │   ("I decided to...", "The bug was...", file changes)
    │
    ├── PreCompact hook ──> Cortex extracts before context loss
    │
    └── SessionEnd hook ──> Cortex processes, updates all 3 layers
         │
         ├── Layer 1: Update working.md (~800 tokens)
         ├── Layer 2: Create/update episode in episodes/
         ├── Layer 3: Update knowledge graph + embeddings
         └── Auto-generate ADR if decision detected
```

---

## Tech Stack

| Component | Technology | Why |
|---|---|---|
| Extension | VSCode Extension API (TypeScript) | Native integration, 14M users, 75% IDE market |
| File watching | chokidar v4 + VSCode FileSystemWatcher | Battle-tested, 308M weekly npm downloads |
| Embeddings | Transformers.js + all-MiniLM-L6-v2 | 100% local, no API key, ~23MB model |
| Vector store | LanceDB (embedded) | Serverless, in-process, production-ready |
| Extraction LLM | Claude Haiku API | ~$0.01/session, fast, same family |
| CLI | Commander.js | Zero deps, fastest, 308M downloads |
| Billing | Lemon Squeezy | Merchant of record, handles taxes |
| Sync | Git (under the hood) | Devs already trust it |

**Everything runs locally. No servers. No cloud. No privacy concerns.**
(Except Haiku API calls for extraction -- optional, can use local models as fallback)

---

## Pricing

| Tier | Price | What They Get |
|---|---|---|
| **Free** | $0 | 1 project, Layer 1 only (working memory), no sync |
| **Solo** | $9/month | 5 projects, all 3 layers, auto-ADRs, cross-project |
| **Team** | $29/seat/month | Unlimited projects, team sync, onboarding packs, shared memory |
| **Enterprise** | Custom | Self-hosted, SSO, audit logs, priority support |

**Billing**: License key validated in extension. Purchase on cortex website via Lemon Squeezy. VSCode Marketplace does not support paid extensions, so distribute free extension with premium features gated.

---

## MVP Scope (What We Build First)

### Phase 1: Core (Weeks 1-3)
- [ ] VSCode extension scaffold with sidebar (TreeView)
- [ ] Claude Code hooks integration (SessionStart, PreCompact, SessionEnd)
- [ ] JSONL session file tailing and parsing
- [ ] Haiku API extraction (decisions, patterns, state summary)
- [ ] Auto-updating `working.md` injected into CLAUDE.md
- [ ] `.cortex/` directory structure (working.md, episodes/, decisions.md)

### Phase 2: Intelligence (Weeks 3-5)
- [ ] LanceDB + Transformers.js for semantic memory (Layer 3)
- [ ] Smart context injection (inject only what's relevant to today's changed files)
- [ ] Auto ADR generation from detected decisions
- [ ] Memory health score in sidebar
- [ ] `cortex init` and `cortex status` CLI commands

### Phase 3: Team & Polish (Weeks 5-7)
- [ ] Git-based team sync (`cortex sync --team`)
- [ ] Onboarding pack export (`cortex export`)
- [ ] Cross-project intelligence (personal patterns)
- [ ] License key gating for premium features
- [ ] Marketplace publishing (VSCode + Open VSX for Cursor)

### Phase 4: Launch (Week 7-8)
- [ ] Landing page + Lemon Squeezy billing
- [ ] 60-second demo video (problem -> solution)
- [ ] Show HN post (Monday, link to GitHub)
- [ ] Reddit posts (r/ClaudeAI, r/SideProject, r/cursor)
- [ ] Discord community for beta users

---

## Timeline

| Milestone | Target |
|---|---|
| Working MVP (Phase 1+2) | 5 weeks |
| Beta launch (500 users) | Week 7-8 |
| First paying customers | Week 8-10 |
| $1K MRR | Month 4-6 |
| $10K MRR | Month 8-12 |

---

## The One-Liner

**Cortex: The memory your AI coding assistant should have had from day one.**
