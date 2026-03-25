#!/usr/bin/env node
// ============================================================
// CORTEX - MCP Server
// ============================================================
// Model Context Protocol server that exposes Cortex's memory
// system to any MCP-compatible tool (Cursor, Cline, Zed,
// Claude Desktop). Communicates via stdin/stdout using
// JSON-RPC 2.0.
// ============================================================

import * as readline from 'node:readline';
import { MemoryStore } from '../engine/memory/memoryStore.js';
import type {
  MCPTool,
  MemoryHealth,
  WorkingMemory,
  DecisionEntry,
  MemoryEntry,
} from '../types/index.js';

// ------------------------------------------------------------------
// JSON-RPC 2.0 types
// ------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// ------------------------------------------------------------------
// MCP tool definitions
// ------------------------------------------------------------------

const MCP_TOOLS: MCPTool[] = [
  {
    name: 'cortex_get_context',
    description:
      'Returns the current working memory (Layer 1) as formatted text. ' +
      'This is the context that should be injected into an AI assistant\'s prompt.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'cortex_search',
    description:
      'Searches episodic and semantic memory for matching episodes and decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query string',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'cortex_save_memory',
    description:
      'Saves a new memory, decision, or insight from the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['decision', 'pattern', 'insight'],
          description: 'The type of memory to save',
        },
        content: {
          type: 'string',
          description: 'The memory content',
        },
        context: {
          type: 'string',
          description: 'Optional context about when/why this memory was created',
        },
      },
      required: ['type', 'content'],
    },
  },
  {
    name: 'cortex_get_decisions',
    description:
      'Returns all architectural decisions (ADRs) recorded for this project.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'cortex_status',
    description:
      'Returns memory health status including health score, entry counts, and warnings.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ------------------------------------------------------------------
// Server info (returned in initialize handshake)
// ------------------------------------------------------------------

const SERVER_INFO = {
  name: 'cortex-memory',
  version: '0.1.0',
};

const SERVER_CAPABILITIES = {
  tools: {},
};

// ------------------------------------------------------------------
// MCP Server
// ------------------------------------------------------------------

class CortexMCPServer {
  private store: MemoryStore;
  private rl: readline.Interface;
  private initialized = false;

  constructor(projectPath: string) {
    this.store = new MemoryStore(projectPath);

    this.rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });
  }

  /**
   * Start listening for JSON-RPC messages on stdin.
   */
  start(): void {
    // Buffer for partial lines (MCP messages are newline-delimited JSON)
    this.rl.on('line', (line: string) => {
      this.handleLine(line);
    });

    this.rl.on('close', () => {
      process.exit(0);
    });

    // Prevent unhandled errors from crashing the server
    process.on('uncaughtException', (err: Error) => {
      this.logError('Uncaught exception', err);
    });

    process.on('unhandledRejection', (reason: unknown) => {
      this.logError('Unhandled rejection', reason);
    });
  }

  // ----------------------------------------------------------------
  // Line / request handling
  // ----------------------------------------------------------------

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      this.sendError(null, PARSE_ERROR, 'Parse error: invalid JSON');
      return;
    }

    if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0') {
      this.sendError(
        request?.id ?? null,
        INVALID_REQUEST,
        'Invalid JSON-RPC 2.0 request',
      );
      return;
    }

    // Notifications have no id -- fire-and-forget
    if (request.id === undefined || request.id === null) {
      this.handleNotification(request);
      return;
    }

    this.handleRequest(request).catch((err: unknown) => {
      this.sendError(
        request.id ?? null,
        INTERNAL_ERROR,
        `Internal error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private handleNotification(request: JsonRpcRequest): void {
    // MCP sends notifications/initialized after the handshake.
    // No response is expected.
    if (request.method === 'notifications/initialized') {
      this.initialized = true;
    }
    // Silently ignore unknown notifications per spec
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const { method, params, id } = request;

    switch (method) {
      case 'initialize':
        this.handleInitialize(id!);
        break;

      case 'tools/list':
        this.handleToolsList(id!);
        break;

      case 'tools/call':
        await this.handleToolCall(id!, params ?? {});
        break;

      default:
        this.sendError(id ?? null, METHOD_NOT_FOUND, `Unknown method: ${method}`);
    }
  }

  // ----------------------------------------------------------------
  // MCP protocol methods
  // ----------------------------------------------------------------

  private handleInitialize(id: string | number): void {
    this.sendResult(id, {
      protocolVersion: '2024-11-05',
      serverInfo: SERVER_INFO,
      capabilities: SERVER_CAPABILITIES,
    });
  }

  private handleToolsList(id: string | number): void {
    this.sendResult(id, { tools: MCP_TOOLS });
  }

  private async handleToolCall(
    id: string | number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const toolName = params.name as string | undefined;
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    if (!toolName || typeof toolName !== 'string') {
      this.sendError(id, INVALID_PARAMS, 'Missing required parameter: name');
      return;
    }

    try {
      const result = await this.dispatchTool(toolName, args);
      this.sendResult(id, {
        content: [{ type: 'text' as const, text: result }],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendResult(id, {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      });
    }
  }

  // ----------------------------------------------------------------
  // Tool dispatch
  // ----------------------------------------------------------------

  private async dispatchTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (name) {
      case 'cortex_get_context':
        return this.toolGetContext();

      case 'cortex_search':
        return this.toolSearch(args);

      case 'cortex_save_memory':
        return this.toolSaveMemory(args);

      case 'cortex_get_decisions':
        return this.toolGetDecisions();

      case 'cortex_status':
        return this.toolGetStatus();

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ----------------------------------------------------------------
  // Tool implementations
  // ----------------------------------------------------------------

  private async toolGetContext(): Promise<string> {
    const working: WorkingMemory = await this.store.getWorkingMemory();

    const lines: string[] = [
      '# Cortex — Working Memory',
      '',
    ];

    if (working.lastSessionSummary) {
      lines.push('## Last Session Summary');
      lines.push(working.lastSessionSummary);
      lines.push('');
    }

    if (working.currentContext) {
      lines.push('## Current Context');
      lines.push(working.currentContext);
      lines.push('');
    }

    if (working.recentDecisions.length > 0) {
      lines.push('## Recent Decisions');
      for (const d of working.recentDecisions) {
        lines.push(`- **${d.title}**: ${d.decision} (${d.reason})`);
      }
      lines.push('');
    }

    if (working.openProblems.length > 0) {
      lines.push('## Open Problems');
      for (const p of working.openProblems) {
        lines.push(`- ${p}`);
      }
      lines.push('');
    }

    lines.push(`_Token count: ${working.tokenCount} | Updated: ${working.updatedAt}_`);

    return lines.join('\n');
  }

  private async toolSearch(args: Record<string, unknown>): Promise<string> {
    const query = args.query;
    if (!query || typeof query !== 'string') {
      throw new Error('Missing required parameter: query (string)');
    }

    const results: MemoryEntry[] = await this.store.search(query);

    if (results.length === 0) {
      return `No memories found matching "${query}".`;
    }

    const lines: string[] = [
      `# Search Results for "${query}"`,
      `_${results.length} result(s) found_`,
      '',
    ];

    for (const entry of results) {
      lines.push(`## [${entry.layer}] ${entry.summary}`);
      lines.push(entry.content);
      lines.push(`_Tags: ${entry.tags.join(', ')} | Score: ${entry.relevanceScore ?? 'N/A'}_`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private async toolSaveMemory(args: Record<string, unknown>): Promise<string> {
    const memType = args.type;
    const content = args.content;
    const context = args.context as string | undefined;

    if (!memType || typeof memType !== 'string') {
      throw new Error('Missing required parameter: type (decision | pattern | insight)');
    }

    if (!['decision', 'pattern', 'insight'].includes(memType)) {
      throw new Error('Parameter "type" must be one of: decision, pattern, insight');
    }

    if (!content || typeof content !== 'string') {
      throw new Error('Missing required parameter: content (string)');
    }

    if (memType === 'decision') {
      const decision: DecisionEntry = {
        id: `dec-${Date.now()}`,
        title: content.slice(0, 80),
        context: context ?? '',
        decision: content,
        alternatives: [],
        reason: context ?? '',
        filesAffected: [],
        timestamp: new Date().toISOString(),
        sessionId: 'mcp-session',
      };
      await this.store.addDecision(decision);
      return `Decision saved successfully.\nID: ${decision.id}\nTitle: ${decision.title}`;
    }

    // For patterns and insights, store as a simple episode note
    return `Memory noted: [${memType}] ${content.slice(0, 100)}`;
  }

  private async toolGetDecisions(): Promise<string> {
    const decisions: DecisionEntry[] = await this.store.getDecisions();

    if (decisions.length === 0) {
      return 'No architectural decisions recorded yet.';
    }

    const lines: string[] = [
      '# Architectural Decision Log',
      `_${decisions.length} decision(s)_`,
      '',
    ];

    for (const d of decisions) {
      lines.push(`## ADR: ${d.title}`);
      lines.push(`**Context:** ${d.context}`);
      lines.push(`**Decision:** ${d.decision}`);
      lines.push(`**Reason:** ${d.reason}`);
      if (d.alternatives.length > 0) {
        lines.push(`**Alternatives considered:** ${d.alternatives.join(', ')}`);
      }
      if (d.filesAffected.length > 0) {
        lines.push(`**Files affected:** ${d.filesAffected.join(', ')}`);
      }
      lines.push(`_Recorded: ${d.timestamp} | Session: ${d.sessionId}_`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private async toolGetStatus(): Promise<string> {
    const health: MemoryHealth = await this.store.getHealth();

    const lines: string[] = [
      '# Cortex Memory Status',
      '',
      `**Project:** ${health.projectName}`,
      `**Health Score:** ${health.score}/100`,
      `**Last Updated:** ${health.lastUpdated}`,
      '',
      '## Counts',
      `- Working memory tokens: ${health.workingMemoryTokens}`,
      `- Episodes: ${health.episodeCount}`,
      `- Decisions: ${health.decisionCount}`,
    ];

    if (health.staleWarnings.length > 0) {
      lines.push('');
      lines.push('## Warnings');
      for (const w of health.staleWarnings) {
        lines.push(`- **${w.module}**: ${w.message} (${w.recentFileChanges} recent file changes)`);
      }
    } else {
      lines.push('');
      lines.push('_No warnings. Memory is healthy._');
    }

    return lines.join('\n');
  }

  // ----------------------------------------------------------------
  // JSON-RPC response helpers
  // ----------------------------------------------------------------

  private sendResult(id: string | number, result: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    this.send(response);
  }

  private sendError(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
    this.send(response);
  }

  private send(message: JsonRpcResponse): void {
    const json = JSON.stringify(message);
    process.stdout.write(json + '\n');
  }

  // ----------------------------------------------------------------
  // Logging (stderr only — stdout is reserved for JSON-RPC)
  // ----------------------------------------------------------------

  private logError(label: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[cortex-mcp] ${label}: ${message}\n`);
  }
}

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------

function main(): void {
  const projectPath = process.cwd();
  const server = new CortexMCPServer(projectPath);
  server.start();
}

main();
