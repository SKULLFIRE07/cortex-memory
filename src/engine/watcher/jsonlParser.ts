// ============================================================
// CORTEX - JSONL Session File Parser
// ============================================================
// Parses individual lines from Claude Code JSONL session files
// into structured SessionMessage objects.

import type { SessionMessage, ToolCallInfo } from '../../types/index.js';

/**
 * Represents the raw shape of a Claude Code JSONL line.
 * The format uses a `type` field ('human'/'user' or 'assistant') and
 * a `message` object containing a `content` array with text blocks.
 */
interface RawJsonlEntry {
  type?: string;
  role?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | RawContentBlock[];
  };
  // Some lines are tool_use or tool_result entries
  content?: string | RawContentBlock[];
}

interface RawContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | RawContentBlock[];
}

/**
 * Parse a single JSONL line from a Claude Code session file.
 *
 * Claude Code session files contain one JSON object per line. Each line
 * represents a conversation turn or system event. This function extracts
 * the user/assistant messages and normalizes them into a SessionMessage.
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
    // Malformed JSON — skip silently
    return null;
  }

  if (typeof entry !== 'object' || entry === null) {
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
 */
function resolveRole(entry: RawJsonlEntry): 'user' | 'assistant' | 'system' | null {
  // Direct type field — Claude Code uses 'human' for user messages
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
 * Content can appear in several shapes:
 *  - entry.message.content as a plain string
 *  - entry.message.content as an array of { type: 'text', text: '...' } blocks
 *  - entry.content (same variations)
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
      }
    }
    const joined = textParts.join('\n');
    return joined || null;
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
