// ============================================================
// CORTEX - Extraction Engine
// Multi-provider LLM extraction (Gemini Free, Claude Haiku, Ollama)
// ============================================================

import type {
  SessionMessage,
  ExtractionResult,
  DecisionEntry,
} from '../../types/index.js';

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

export type LLMProvider = 'gemini' | 'anthropic' | 'ollama';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey?: string;
  model?: string;
  baseUrl?: string; // For Ollama or custom endpoints
}

const DEFAULT_CONFIGS: Record<LLMProvider, { model: string; baseUrl: string }> = {
  gemini:    { model: 'gemini-2.5-flash',              baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  anthropic: { model: 'claude-haiku-4-5-20251001',     baseUrl: 'https://api.anthropic.com/v1' },
  ollama:    { model: 'llama3.2',                      baseUrl: 'http://localhost:11434' },
};

const MAX_INPUT_TOKENS = 8192;
const CHARS_PER_TOKEN = 4;
const RATE_LIMIT_RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n... [truncated to fit token budget]';
}

function buildTranscript(messages: SessionMessage[]): string {
  return messages
    .map((m) => {
      const role = m.type.toUpperCase();
      const toolSuffix =
        m.toolCalls && m.toolCalls.length > 0
          ? `\n  [tools: ${m.toolCalls.map((t) => t.name).join(', ')}]`
          : '';
      return `[${role}] ${m.content}${toolSuffix}`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction engine for an AI coding assistant. Given a conversation transcript, extract structured information and return ONLY valid JSON (no markdown fences, no commentary).

Return JSON matching this exact schema:
{
  "summary": "2-3 sentence summary of what happened in this session",
  "decisions": [
    {
      "title": "short decision title",
      "context": "what problem was being solved",
      "decision": "what was decided",
      "alternatives": ["other options considered"],
      "reason": "why this was chosen",
      "filesAffected": ["file/paths"],
      "timestamp": "ISO timestamp or empty string"
    }
  ],
  "patterns": [
    {
      "type": "decision|bug_pattern|architecture|structural|learning|preference",
      "description": "what pattern was observed",
      "relatedFiles": ["file/paths"]
    }
  ],
  "openProblems": ["unresolved issues or TODOs mentioned"],
  "filesAffected": ["all file paths mentioned in the session"],
  "keyInsights": ["important learnings or discoveries"],
  "nextSteps": ["what should be done next based on the session"]
}

Rules:
- Be concise but precise. Capture the essential decisions and context.
- For decisions, focus on architectural and design choices, not trivial edits.
- File paths should be relative project paths as mentioned in the conversation.
- If a field has no entries, use an empty array or empty string.
- Patterns should capture recurring themes: bug types, architectural styles, preferences.
- The timestamp for decisions should be taken from nearby messages if available.`;

const DECISION_SYSTEM_PROMPT = `You are a decision extraction engine. Given text from a coding session, identify all technical decisions made and return ONLY valid JSON (no markdown fences).

Return a JSON array of decisions:
[
  {
    "title": "short decision title",
    "context": "problem being solved",
    "decision": "what was decided",
    "alternatives": ["other options considered"],
    "reason": "why this was chosen",
    "filesAffected": ["file/paths"],
    "timestamp": ""
  }
]

Focus on architectural, design, and implementation decisions. Ignore trivial changes. If no decisions are found, return an empty array [].`;

const SUMMARY_SYSTEM_PROMPT = `You are a session summarizer for an AI coding assistant's memory system. Given a conversation transcript, write a concise 2-3 sentence summary capturing:
1. What was the main goal or task
2. What was accomplished
3. Any important decisions or unresolved issues

Return ONLY the summary text, no JSON or formatting.`;

// ---------------------------------------------------------------------------
// Empty result helper
// ---------------------------------------------------------------------------

function emptyExtractionResult(): ExtractionResult {
  return {
    summary: '',
    decisions: [],
    patterns: [],
    openProblems: [],
    filesAffected: [],
    keyInsights: [],
    nextSteps: [],
  };
}

// ---------------------------------------------------------------------------
// ExtractionEngine
// ---------------------------------------------------------------------------

export class ExtractionEngine {
  private provider: LLMProvider;
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: LLMConfig) {
    this.provider = config.provider;
    this.apiKey = config.apiKey ?? '';
    this.model = config.model ?? DEFAULT_CONFIGS[config.provider].model;
    this.baseUrl = config.baseUrl ?? DEFAULT_CONFIGS[config.provider].baseUrl;
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  async extractFromSession(messages: SessionMessage[]): Promise<ExtractionResult> {
    if (messages.length === 0) return emptyExtractionResult();

    const transcript = buildTranscript(messages);
    const systemTokens = estimateTokens(EXTRACTION_SYSTEM_PROMPT);
    const responseBuffer = 2048;
    const availableForInput = MAX_INPUT_TOKENS - systemTokens - responseBuffer;
    const trimmedTranscript = truncateToTokenBudget(transcript, availableForInput);

    const rawJson = await this.callLLM(
      EXTRACTION_SYSTEM_PROMPT,
      `Extract structured memories from this coding session:\n\n${trimmedTranscript}`,
    );

    if (!rawJson) return emptyExtractionResult();

    try {
      const parsed = JSON.parse(rawJson);
      return this.validateExtractionResult(parsed);
    } catch {
      const salvaged = this.extractJsonFromText(rawJson);
      if (salvaged) {
        try {
          const parsed = JSON.parse(salvaged);
          return this.validateExtractionResult(parsed);
        } catch {
          return emptyExtractionResult();
        }
      }
      return emptyExtractionResult();
    }
  }

  async extractDecisions(text: string): Promise<DecisionEntry[]> {
    if (!text.trim()) return [];

    const systemTokens = estimateTokens(DECISION_SYSTEM_PROMPT);
    const responseBuffer = 2048;
    const availableForInput = MAX_INPUT_TOKENS - systemTokens - responseBuffer;
    const trimmedText = truncateToTokenBudget(text, availableForInput);

    const rawJson = await this.callLLM(
      DECISION_SYSTEM_PROMPT,
      `Extract decisions from this text:\n\n${trimmedText}`,
    );

    if (!rawJson) return [];

    try {
      const parsed = JSON.parse(this.extractJsonFromText(rawJson) ?? rawJson);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((d: Record<string, unknown>, i: number) =>
        this.normalizeDecision(d, i),
      );
    } catch {
      return [];
    }
  }

  async summarizeSession(messages: SessionMessage[]): Promise<string> {
    if (messages.length === 0) return '';

    const transcript = buildTranscript(messages);
    const systemTokens = estimateTokens(SUMMARY_SYSTEM_PROMPT);
    const responseBuffer = 512;
    const availableForInput = MAX_INPUT_TOKENS - systemTokens - responseBuffer;
    const trimmedTranscript = truncateToTokenBudget(transcript, availableForInput);

    const result = await this.callLLM(
      SUMMARY_SYSTEM_PROMPT,
      `Summarize this coding session:\n\n${trimmedTranscript}`,
    );

    return result?.trim() ?? '';
  }

  // ----------------------------------------------------------------
  // Multi-provider LLM call
  // ----------------------------------------------------------------

  private async callLLM(
    systemPrompt: string,
    userMessage: string,
  ): Promise<string | null> {
    const makeRequest = async (): Promise<string | null> => {
      switch (this.provider) {
        case 'gemini':
          return this.callGemini(systemPrompt, userMessage);
        case 'anthropic':
          return this.callAnthropic(systemPrompt, userMessage);
        case 'ollama':
          return this.callOllama(systemPrompt, userMessage);
        default:
          return null;
      }
    };

    try {
      return await makeRequest();
    } catch (error: unknown) {
      if (this.isRateLimitError(error)) {
        await this.sleep(RATE_LIMIT_RETRY_DELAY_MS);
        try {
          return await makeRequest();
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  // ----------------------------------------------------------------
  // Gemini (FREE)
  // ----------------------------------------------------------------

  private async callGemini(
    systemPrompt: string,
    userMessage: string,
  ): Promise<string | null> {
    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;

    const body = {
      system_instruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: userMessage }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        responseMimeType: 'text/plain',
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 429) throw Object.assign(new Error('Rate limited'), { status: 429 });
      return null;
    }

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  }

  // ----------------------------------------------------------------
  // Anthropic (Claude Haiku)
  // ----------------------------------------------------------------

  private async callAnthropic(
    systemPrompt: string,
    userMessage: string,
  ): Promise<string | null> {
    const url = `${this.baseUrl}/messages`;

    const body = {
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 429) throw Object.assign(new Error('Rate limited'), { status: 429 });
      return null;
    }

    const data = await response.json() as {
      content?: Array<{ type: string; text?: string }>;
    };

    const block = data.content?.[0];
    if (block?.type === 'text') return block.text ?? null;
    return null;
  }

  // ----------------------------------------------------------------
  // Ollama (FREE, fully local)
  // ----------------------------------------------------------------

  private async callOllama(
    systemPrompt: string,
    userMessage: string,
  ): Promise<string | null> {
    const url = `${this.baseUrl}/api/chat`;

    const body = {
      model: this.model,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) return null;

    const data = await response.json() as {
      message?: { content?: string };
    };

    return data.message?.content ?? null;
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  private isRateLimitError(error: unknown): boolean {
    if (
      error instanceof Error &&
      'status' in error &&
      (error as { status: number }).status === 429
    ) {
      return true;
    }
    return false;
  }

  private extractJsonFromText(text: string): string | null {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) return fenceMatch[1].trim();

    const objStart = text.indexOf('{');
    const arrStart = text.indexOf('[');
    if (objStart === -1 && arrStart === -1) return null;

    let start: number;
    let endChar: string;
    if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
      start = arrStart;
      endChar = ']';
    } else {
      start = objStart;
      endChar = '}';
    }

    const end = text.lastIndexOf(endChar);
    if (end <= start) return null;
    return text.slice(start, end + 1);
  }

  private validateExtractionResult(raw: Record<string, unknown>): ExtractionResult {
    return {
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      decisions: Array.isArray(raw.decisions)
        ? raw.decisions.map((d: Record<string, unknown>, i: number) => {
            const normalized = this.normalizeDecision(d, i);
            const { id: _id, sessionId: _sid, ...rest } = normalized;
            return rest;
          })
        : [],
      patterns: Array.isArray(raw.patterns)
        ? raw.patterns.map((p: Record<string, unknown>) => ({
            type: typeof p.type === 'string' ? (p.type as ExtractionResult['patterns'][number]['type']) : 'learning',
            description: typeof p.description === 'string' ? p.description : '',
            occurrences: 1,
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            relatedFiles: Array.isArray(p.relatedFiles)
              ? (p.relatedFiles as string[]).filter((f) => typeof f === 'string')
              : [],
          }))
        : [],
      openProblems: this.toStringArray(raw.openProblems),
      filesAffected: this.toStringArray(raw.filesAffected),
      keyInsights: this.toStringArray(raw.keyInsights),
      nextSteps: this.toStringArray(raw.nextSteps),
    };
  }

  private normalizeDecision(d: Record<string, unknown>, _index: number): DecisionEntry {
    return {
      id: '',
      title: typeof d.title === 'string' ? d.title : '',
      context: typeof d.context === 'string' ? d.context : '',
      decision: typeof d.decision === 'string' ? d.decision : '',
      alternatives: Array.isArray(d.alternatives)
        ? (d.alternatives as string[]).filter((a) => typeof a === 'string')
        : [],
      reason: typeof d.reason === 'string' ? d.reason : '',
      filesAffected: Array.isArray(d.filesAffected)
        ? (d.filesAffected as string[]).filter((f) => typeof f === 'string')
        : [],
      timestamp:
        typeof d.timestamp === 'string' && d.timestamp
          ? d.timestamp
          : new Date().toISOString(),
      sessionId: '',
    };
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v) => typeof v === 'string');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
