// ============================================================
// CORTEX - CLAUDE.md Injector
// ============================================================
// Automatically injects working memory into CLAUDE.md files
// using atomic writes and section markers for safe updates.

import * as fs from 'fs/promises';
import * as path from 'path';
import type { MemoryStore } from '../memory/memoryStore.js';
import type { WorkingMemory, DecisionEntry } from '../../types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CORTEX_START_MARKER = '<!-- CORTEX:START -->';
const CORTEX_END_MARKER = '<!-- CORTEX:END -->';
const CLAUDE_MD_FILENAME = 'CLAUDE.md';
const WORKING_MD_REL_PATH = '.cortex/working.md';
const MAX_DECISIONS_DISPLAYED = 5;
const MAX_TOKEN_BUDGET = 800;

// Regex that captures the full Cortex section including markers.
// Uses the `s` (dotAll) flag so `.` matches newlines.
const CORTEX_SECTION_RE = new RegExp(
  `${escapeRegex(CORTEX_START_MARKER)}[\\s\\S]*?${escapeRegex(CORTEX_END_MARKER)}`,
);

// ---------------------------------------------------------------------------
// ClaudeMdInjector
// ---------------------------------------------------------------------------

export class ClaudeMdInjector {
  private readonly claudeMdPath: string;
  private readonly tmpPath: string;
  private readonly projectPath: string;
  private readonly memoryStore: MemoryStore;

  // Simple mutex: only one write operation at a time.
  private writeInProgress: Promise<void> = Promise.resolve();

  constructor(projectPath: string, memoryStore: MemoryStore) {
    this.projectPath = projectPath;
    this.memoryStore = memoryStore;
    this.claudeMdPath = path.join(projectPath, CLAUDE_MD_FILENAME);
    this.tmpPath = path.join(projectPath, `.${CLAUDE_MD_FILENAME}.tmp`);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Inject the current working memory into CLAUDE.md.
   *
   * If CLAUDE.md does not exist it will be created. If Cortex markers already
   * exist the content between them is replaced; otherwise the section is
   * appended. The write is atomic (write-to-tmp then rename).
   */
  async inject(): Promise<void> {
    // Serialise concurrent writes through the mutex.
    this.writeInProgress = this.writeInProgress.then(() => this.doInject()).catch(() => {});
    await this.writeInProgress;
  }

  /**
   * Remove the Cortex section (markers included) from CLAUDE.md.
   *
   * If CLAUDE.md does not exist or has no Cortex section this is a no-op.
   */
  async remove(): Promise<void> {
    this.writeInProgress = this.writeInProgress.then(() => this.doRemove()).catch(() => {});
    await this.writeInProgress;
  }

  /**
   * Check whether the Cortex section markers are present in CLAUDE.md.
   */
  async isInjected(): Promise<boolean> {
    try {
      const content = await fs.readFile(this.claudeMdPath, 'utf-8');
      return content.includes(CORTEX_START_MARKER) && content.includes(CORTEX_END_MARKER);
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async doInject(): Promise<void> {
    const workingMemory = await this.memoryStore.getWorkingMemory();
    const section = formatCortexSection(workingMemory);

    let existing: string | null = null;
    try {
      existing = await fs.readFile(this.claudeMdPath, 'utf-8');
    } catch (err: unknown) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw err;
      }
      // File doesn't exist — we'll create it.
    }

    let updated: string;

    if (existing === null) {
      // CLAUDE.md doesn't exist yet — create with just the Cortex section.
      updated = section + '\n';
    } else if (CORTEX_SECTION_RE.test(existing)) {
      // Replace existing section.
      updated = existing.replace(CORTEX_SECTION_RE, section);
    } else {
      // Append to end of file.
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      updated = existing + separator + section + '\n';
    }

    await this.atomicWrite(updated);
  }

  private async doRemove(): Promise<void> {
    let existing: string;
    try {
      existing = await fs.readFile(this.claudeMdPath, 'utf-8');
    } catch {
      // File doesn't exist — nothing to remove.
      return;
    }

    if (!CORTEX_SECTION_RE.test(existing)) {
      return;
    }

    // Remove the section and collapse any resulting excessive blank lines.
    let updated = existing.replace(CORTEX_SECTION_RE, '');
    updated = updated.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

    // If after removal the file is effectively empty, delete it.
    if (updated.trim().length === 0) {
      try {
        await fs.unlink(this.claudeMdPath);
      } catch {
        // Best-effort deletion.
      }
      return;
    }

    await this.atomicWrite(updated);
  }

  /**
   * Write content to a temporary file and atomically rename it into place.
   * This prevents readers from seeing partial writes.
   */
  private async atomicWrite(content: string): Promise<void> {
    try {
      await fs.writeFile(this.tmpPath, content, 'utf-8');
      await fs.rename(this.tmpPath, this.claudeMdPath);
    } catch (err: unknown) {
      // Clean up the temp file on failure — best effort.
      try {
        await fs.unlink(this.tmpPath);
      } catch {
        // Ignore cleanup errors.
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-injection setup
// ---------------------------------------------------------------------------

/**
 * Sets up automatic re-injection of working memory into CLAUDE.md whenever
 * the `.cortex/working.md` file changes.
 *
 * @returns A dispose function that stops the file watcher.
 */
export function setupAutoInjection(
  projectPath: string,
  memoryStore: MemoryStore,
): () => void {
  const injector = new ClaudeMdInjector(projectPath, memoryStore);
  const watchPath = path.join(projectPath, WORKING_MD_REL_PATH);

  let controller: AbortController | null = new AbortController();
  let disposed = false;

  // Debounce: avoid rapid-fire re-injections.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 300;

  const scheduleInject = (): void => {
    if (disposed) return;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      injector.inject().catch(() => {
        // Swallow errors in the background watcher — the next change will
        // trigger a retry automatically.
      });
    }, DEBOUNCE_MS);
  };

  // Start watching in the background. We wrap in an async IIFE so that
  // callers don't need to await the watcher setup.
  const startWatching = async (): Promise<void> => {
    // Ensure the directory containing working.md exists so the watcher
    // doesn't throw ENOENT on startup.
    const watchDir = path.dirname(watchPath);
    try {
      await fs.mkdir(watchDir, { recursive: true });
    } catch {
      // Ignore — directory may already exist.
    }

    try {
      const watcher = fs.watch(watchDir, { signal: controller!.signal });
      for await (const event of watcher) {
        if (disposed) break;
        // Only react to changes affecting the working.md file.
        if (event.filename === path.basename(watchPath)) {
          scheduleInject();
        }
      }
    } catch (err: unknown) {
      // AbortError is expected when dispose() is called.
      if (isNodeError(err) && err.code === 'ABORT_ERR') {
        return;
      }
      // On other errors (e.g. ENOENT if directory was deleted), silently stop.
    }
  };

  // Perform an initial injection, then start the watcher.
  injector.inject().catch(() => {});
  startWatching().catch(() => {});

  // Return a dispose function.
  return () => {
    if (disposed) return;
    disposed = true;

    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    if (controller) {
      controller.abort();
      controller = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Build the Markdown section that will be injected between the Cortex markers.
 */
function formatCortexSection(memory: WorkingMemory): string {
  const lines: string[] = [];

  lines.push(CORTEX_START_MARKER);
  lines.push('## Project Memory (auto-managed by Cortex)');
  lines.push('');

  // --- Last Session ---
  lines.push('### Last Session');
  lines.push(memory.lastSessionSummary || '_No session recorded yet._');
  lines.push('');

  // --- Recent Decisions ---
  lines.push('### Recent Decisions');
  const decisions = (memory.recentDecisions ?? []).slice(0, MAX_DECISIONS_DISPLAYED);
  if (decisions.length > 0) {
    for (const d of decisions) {
      lines.push(formatDecision(d));
    }
  } else {
    lines.push('_No decisions recorded yet._');
  }
  lines.push('');

  // --- Current Context ---
  lines.push('### Current Context');
  lines.push(memory.currentContext || '_No context available._');
  lines.push('');

  // --- Open Problems ---
  lines.push('### Open Problems');
  const problems = memory.openProblems ?? [];
  if (problems.length > 0) {
    for (const p of problems) {
      lines.push(`- ${p}`);
    }
  } else {
    lines.push('_No open problems._');
  }
  lines.push('');

  // --- Footer ---
  const timestamp = memory.updatedAt || new Date().toISOString();
  const tokenCount = memory.tokenCount ?? 0;
  lines.push(`_Last updated: ${timestamp} | Tokens: ${tokenCount}/${MAX_TOKEN_BUDGET}_`);
  lines.push(CORTEX_END_MARKER);

  return lines.join('\n');
}

/**
 * Format a single decision entry as a concise bullet point.
 */
function formatDecision(d: DecisionEntry): string {
  const summary = d.reason ? `${d.title} — ${d.reason}` : d.title;
  return `- **${d.decision}**: ${summary}`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Type guard for Node.js system errors that carry a `code` property. */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
