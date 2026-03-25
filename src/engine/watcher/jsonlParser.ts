// ============================================================
// CORTEX - JSONL Session File Parser
// ============================================================
// Parses individual lines from Claude Code JSONL session files
// into structured SessionMessage objects.
//
// Claude Code JSONL format (observed):
//   - type: "user"       → user message with message.content array
//   - type: "assistant"  → assistant message with thinking/text/tool_use blocks
//   - type: "queue-operation" | "file-history-snapshot" | "ai-title" → system events (skip)
//   - message.content can contain: {type:"text"}, {type:"thinking"}, {type:"tool_use"}, {type:"tool_result"}

import type { SessionMessage, ToolCallInfo } from '../../types/index.js';

/**
 * Represents the raw shape of a Claude Code JSONL line.
 */
interface RawJsonlEntry {
  type?: string;
  role?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    role?: string;
    type?: string;
    content?: string | RawContentBlock[];
  };
  content?: string | RawContentBlock[];
}

interface RawContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | RawContentBlock[];
  tool_use_id?: string;
}

// System event types that should be silently skipped
const SKIP_TYPES = new Set([
  'queue-operation',
  'file-history-snapshot',
  'ai-title',
  'summary',
  'lock',
  'unlock',
]);

/**
 * Parse a single JSONL line from a Claude Code session file.
 *
 * @param line - A single line from a .jsonl session file
 * @returns Parsed SessionMessage, or null if the line is not a parseable message
 */
export function parseSessionLine(line: string): SessionMessage | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let entry: RawJsonlEntry;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof entry !== 'object' || entry === null) {
    return null;
  }

  // Skip known system event types
  if (entry.type && SKIP_TYPES.has(entry.type)) {
    return null;
  }

  const role = resolveRole(entry);
  if (!role) {
    return null;
  }

  const content = extractContent(entry);
  if (!content) {
    return null;
  }

  const toolCalls = extractToolCalls(entry);
  const timestamp = entry.timestamp ?? new Date().toISOString();

  const message: SessionMessage = {
    type: role,
    content,
    timestamp,
  };

  if (entry.uuid) {
    message.uuid = entry.uuid;
  }
  if (entry.parentUuid) {
    message.parentUuid = entry.parentUuid;
  }
  if (toolCalls.length > 0) {
    message.toolCalls = toolCalls;
  }

  return message;
}

/**
 * Resolve the message role from various JSONL field conventions.
 *
 * Claude Code uses:
 *   - root `type: "user"` for user messages
 *   - root `type: "assistant"` for assistant messages
 *   - `message.role` as a secondary indicator
 */
function resolveRole(entry: RawJsonlEntry): 'user' | 'assistant' | 'system' | null {
  const rawType = entry.type ?? entry.message?.role ?? entry.role;

  if (!rawType || typeof rawType !== 'string') {
    return null;
  }

  const normalized = rawType.toLowerCase();

  if (normalized === 'human' || normalized === 'user') {
    return 'user';
  }
  if (normalized === 'assistant') {
    return 'assistant';
  }
  if (normalized === 'system') {
    return 'system';
  }

  return null;
}

/**
 * Extract text content from a JSONL entry.
 *
 * Handles Claude Code's content blocks:
 *   - {type: "text", text: "..."} → main text content
 *   - {type: "thinking", thinking: "..."} → assistant reasoning (include as context)
 *   - {type: "tool_use", name: "...", input: {...}} → tool call (captured separately)
 *   - {type: "tool_result", content: "..."} → tool output
 */
function extractContent(entry: RawJsonlEntry): string | null {
  const raw = entry.message?.content ?? entry.content;

  if (!raw) {
    return null;
  }

  if (typeof raw === 'string') {
    return raw || null;
  }

  if (Array.isArray(raw)) {
    const textParts: string[] = [];

    for (const block of raw) {
      if (typeof block === 'string') {
        textParts.push(block);
      } else if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        // Include thinking as it contains decision reasoning and context
        // But mark it so extraction can weight it differently
        textParts.push(`[thinking] ${block.thinking}`);
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        // Summarize tool usage inline so extraction sees what tools were called
        const inputSummary = block.input
          ? summarizeToolInput(block.name, block.input)
          : '';
        textParts.push(`[tool: ${block.name}${inputSummary}]`);
      } else if (block.type === 'tool_result') {
        // Tool results can contain nested content
        const resultText = extractToolResultContent(block);
        if (resultText) {
          textParts.push(`[tool_result] ${resultText}`);
        }
      }
    }

    const joined = textParts.join('\n');
    return joined || null;
  }

  return null;
}

/**
 * Summarize tool input for inline display.
 * Keep it concise - just the key parameters.
 */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  // For file operations, show the path
  if ('file_path' in input || 'path' in input) {
    const p = (input.file_path ?? input.path) as string;
    return ` ${p}`;
  }
  // For search operations, show the query
  if ('pattern' in input) {
    return ` "${input.pattern}"`;
  }
  // For bash, show a truncated command
  if ('command' in input && typeof input.command === 'string') {
    const cmd = input.command.length > 80 ? input.command.slice(0, 77) + '...' : input.command;
    return ` \`${cmd}\``;
  }
  return '';
}

/**
 * Extract text from tool_result content blocks (can be nested).
 */
function extractToolResultContent(block: RawContentBlock): string | null {
  if (typeof block.content === 'string') {
    // Truncate large tool outputs
    return block.content.length > 500
      ? block.content.slice(0, 497) + '...'
      : block.content;
  }
  if (Array.isArray(block.content)) {
    const parts: string[] = [];
    for (const sub of block.content) {
      if (typeof sub === 'string') {
        parts.push(sub);
      } else if (sub.type === 'text' && typeof sub.text === 'string') {
        parts.push(sub.text);
      }
    }
    const joined = parts.join('\n');
    return joined.length > 500 ? joined.slice(0, 497) + '...' : joined || null;
  }
  return null;
}

/**
 * Extract tool call information from assistant message content blocks.
 */
function extractToolCalls(entry: RawJsonlEntry): ToolCallInfo[] {
  const raw = entry.message?.content ?? entry.content;

  if (!Array.isArray(raw)) {
    return [];
  }

  const calls: ToolCallInfo[] = [];
  for (const block of raw) {
    if (
      typeof block === 'object' &&
      block !== null &&
      block.type === 'tool_use' &&
      typeof block.name === 'string'
    ) {
      calls.push({
        name: block.name,
        input: block.input ?? {},
      });
    }
  }

  return calls;
}
