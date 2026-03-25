// ============================================================
// CORTEX - Memory Compressor
// ============================================================
// Compresses memory to stay within token budgets. Provides
// utilities for estimating tokens, truncating working memory,
// converting episodic memory to concise markdown, and formatting
// working memory for CLAUDE.md injection.

import type { WorkingMemory, EpisodicMemory } from '../types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rough approximation: 1 token ~ 4 characters. */
const CHARS_PER_TOKEN = 4;

/** Maximum number of recent decisions to keep when compressing. */
const MAX_COMPRESSED_DECISIONS = 3;

/** Maximum number of open problems to keep when compressing. */
const MAX_COMPRESSED_PROBLEMS = 3;

/** Suffix appended to text that has been truncated to fit a budget. */
const TRUNCATION_SUFFIX = '\n... [truncated to fit token budget]';

// ---------------------------------------------------------------------------
// Token Estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the number of tokens in a string.
 *
 * Uses a simple approximation of ~4 characters per token. This is intentionally
 * conservative for Latin-script code/prose. A proper tokenizer (e.g. tiktoken)
 * would be more accurate but adds a heavy dependency.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Working Memory Compression
// ---------------------------------------------------------------------------

/**
 * Compress a WorkingMemory object to fit within a token budget.
 *
 * Strategy (applied in order until under budget):
 *   1. Truncate `lastSessionSummary` to half of `maxTokens`.
 *   2. Keep only the 3 most recent decisions.
 *   3. Trim `openProblems` to 3.
 *   4. If still over, aggressively truncate `lastSessionSummary`.
 *
 * Returns a new WorkingMemory object; the original is not mutated.
 */
export function compressWorkingMemory(
  memory: WorkingMemory,
  maxTokens: number,
): WorkingMemory {
  // Start with a shallow copy.
  let compressed: WorkingMemory = {
    ...memory,
    recentDecisions: [...memory.recentDecisions],
    openProblems: [...memory.openProblems],
  };

  // Check if already within budget.
  if (estimateWorkingMemoryTokens(compressed) <= maxTokens) {
    compressed.tokenCount = estimateWorkingMemoryTokens(compressed);
    return compressed;
  }

  // Step 1: Truncate lastSessionSummary to half the budget.
  const summaryBudget = Math.floor(maxTokens / 2);
  compressed.lastSessionSummary = truncateToTokenBudget(
    compressed.lastSessionSummary,
    summaryBudget,
  );

  // Step 2: Keep only the most recent decisions.
  if (compressed.recentDecisions.length > MAX_COMPRESSED_DECISIONS) {
    compressed.recentDecisions = compressed.recentDecisions.slice(
      -MAX_COMPRESSED_DECISIONS,
    );
  }

  // Step 3: Trim open problems.
  if (compressed.openProblems.length > MAX_COMPRESSED_PROBLEMS) {
    compressed.openProblems = compressed.openProblems.slice(
      0,
      MAX_COMPRESSED_PROBLEMS,
    );
  }

  // Step 4: If still over budget, aggressively truncate the summary further.
  if (estimateWorkingMemoryTokens(compressed) > maxTokens) {
    const remaining = maxTokens - estimateWorkingMemoryTokens({
      ...compressed,
      lastSessionSummary: '',
    });
    const safeBudget = Math.max(remaining, 20);
    compressed.lastSessionSummary = truncateToTokenBudget(
      compressed.lastSessionSummary,
      safeBudget,
    );
  }

  compressed.tokenCount = estimateWorkingMemoryTokens(compressed);
  return compressed;
}

// ---------------------------------------------------------------------------
// Episodic Memory Compression
// ---------------------------------------------------------------------------

/**
 * Convert an episodic memory entry to concise markdown within a token limit.
 *
 * Priority order:
 *   1. Decisions (highest signal value)
 *   2. Patterns
 *   3. Summary
 *
 * Lower-priority content is dropped when the budget is exhausted.
 */
export function compressEpisode(
  episode: EpisodicMemory,
  maxTokens: number,
): string {
  const sections: string[] = [];
  let currentTokens = 0;

  // Header (always included).
  const header = `## ${episode.title}\n_Session: ${episode.sessionId} | ${episode.timestamp}_\n`;
  currentTokens += estimateTokens(header);
  sections.push(header);

  // Decisions — highest priority.
  if (episode.decisions.length > 0) {
    const decisionLines: string[] = ['### Decisions'];
    for (const d of episode.decisions) {
      const line = `- **${d.decision}**: ${d.reason || d.context}`;
      const lineTokens = estimateTokens(line + '\n');

      if (currentTokens + lineTokens > maxTokens) {
        break;
      }
      decisionLines.push(line);
      currentTokens += lineTokens;
    }
    if (decisionLines.length > 1) {
      sections.push(decisionLines.join('\n'));
    }
  }

  // Patterns — second priority.
  if (episode.patterns.length > 0 && currentTokens < maxTokens) {
    const patternLines: string[] = ['### Patterns'];
    for (const p of episode.patterns) {
      const line = `- [${p.type}] ${p.description}`;
      const lineTokens = estimateTokens(line + '\n');

      if (currentTokens + lineTokens > maxTokens) {
        break;
      }
      patternLines.push(line);
      currentTokens += lineTokens;
    }
    if (patternLines.length > 1) {
      sections.push(patternLines.join('\n'));
    }
  }

  // Summary — lowest priority (but still useful context).
  if (episode.summary && currentTokens < maxTokens) {
    const summarySection = `### Summary\n${episode.summary}`;
    const summaryTokens = estimateTokens(summarySection);

    if (currentTokens + summaryTokens <= maxTokens) {
      sections.push(summarySection);
    } else {
      // Fit as much of the summary as possible.
      const availableTokens = maxTokens - currentTokens;
      if (availableTokens > 10) {
        const truncated = truncateToTokenBudget(
          `### Summary\n${episode.summary}`,
          availableTokens,
        );
        sections.push(truncated);
      }
    }
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Injection Formatting
// ---------------------------------------------------------------------------

/**
 * Format working memory as clean markdown suitable for injection into CLAUDE.md.
 *
 * The output is structured with clear section headings so the AI assistant
 * can quickly parse the project context.
 */
export function formatForInjection(
  memory: WorkingMemory,
  maxTokens: number = 800,
): string {
  const lines: string[] = [];

  lines.push('## Project Memory (Cortex)');
  lines.push('');

  // Last session summary.
  lines.push('### Last Session');
  lines.push(memory.lastSessionSummary || '_No session recorded yet._');
  lines.push('');

  // Recent decisions.
  lines.push('### Recent Decisions');
  if (memory.recentDecisions.length > 0) {
    for (const d of memory.recentDecisions) {
      const reason = d.reason ? ` — ${d.reason}` : '';
      lines.push(`- **${d.decision}**: ${d.title}${reason}`);
    }
  } else {
    lines.push('_No decisions recorded yet._');
  }
  lines.push('');

  // Current context.
  if (memory.currentContext) {
    lines.push('### Current Context');
    lines.push(memory.currentContext);
    lines.push('');
  }

  // Open problems.
  lines.push('### Open Problems');
  if (memory.openProblems.length > 0) {
    for (const p of memory.openProblems) {
      lines.push(`- ${p}`);
    }
  } else {
    lines.push('_No open problems._');
  }
  lines.push('');

  // Footer.
  const timestamp = memory.updatedAt || new Date().toISOString();
  lines.push(
    `_Updated: ${timestamp} | Tokens: ~${memory.tokenCount}_`,
  );

  let result = lines.join('\n');

  // Ensure result fits within token budget.
  if (estimateTokens(result) > maxTokens) {
    result = truncateToTokenBudget(result, maxTokens);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Estimate the total token count for a WorkingMemory object by serialising
 * its key fields to text and measuring length.
 */
function estimateWorkingMemoryTokens(memory: WorkingMemory): number {
  const parts: string[] = [
    memory.lastSessionSummary,
    memory.currentContext,
    ...memory.openProblems,
    ...memory.recentDecisions.map(
      (d) => `${d.title} ${d.decision} ${d.reason} ${d.context}`,
    ),
  ];
  const totalChars = parts.reduce((sum, p) => sum + p.length, 0);
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

/**
 * Truncate text to fit within a token budget, appending a truncation notice.
 */
function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;

  const suffixLen = TRUNCATION_SUFFIX.length;
  const cutPoint = Math.max(maxChars - suffixLen, 0);
  return text.slice(0, cutPoint) + TRUNCATION_SUFFIX;
}
