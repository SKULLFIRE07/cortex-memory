// ============================================================
// CORTEX - Session Watcher
// ============================================================
// Watches Claude Code session JSONL files under ~/.claude/projects/
// for the current project. Detects session lifecycle events and
// emits semantic signals (decisions, bugs, architecture changes).

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as chokidar from 'chokidar';
import { parseSessionLine } from './jsonlParser.js';
import type { SessionMessage } from '../../types/index.js';

// ---- Signal detection patterns ------------------------------------------------

const DECISION_PATTERNS = [
  /I've decided/i,
  /Let's go with/i,
  /The approach will be/i,
  /We(?:'ll| will) use/i,
  /I(?:'ll| will) go with/i,
  /Decision:/i,
  /Going with/i,
];

const BUG_PATTERNS = [
  /The bug was/i,
  /The issue was caused by/i,
  /Root cause:/i,
  /The problem was/i,
  /The error (?:was|is) (?:caused|due)/i,
  /Found the bug/i,
];

const ARCHITECTURE_PATTERNS = [
  /Let's refactor/i,
  /restructure/i,
  /new module/i,
  /Let's reorganize/i,
  /architecture change/i,
  /move .+ into (?:its own|a separate|a new)/i,
  /split .+ into/i,
  /extract .+ (?:into|to) /i,
];

// ---- Types --------------------------------------------------------------------

export interface SessionWatcherEvents {
  'session:start': (info: { sessionId: string; filePath: string }) => void;
  'session:message': (message: SessionMessage & { sessionId: string }) => void;
  'session:end': (info: { sessionId: string; filePath: string }) => void;
  'signal:decision': (info: { sessionId: string; message: SessionMessage }) => void;
  'signal:bug': (info: { sessionId: string; message: SessionMessage }) => void;
  'signal:architecture': (info: { sessionId: string; message: SessionMessage }) => void;
}

interface TrackedSession {
  filePath: string;
  sessionId: string;
  byteOffset: number;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
}

// ---- Constants ----------------------------------------------------------------

/** Seconds of inactivity before a session is considered ended. */
const SESSION_END_TIMEOUT_MS = 60_000;

// ---- SessionWatcher -----------------------------------------------------------

/**
 * Watches the Claude Code session directory for the given project and emits
 * events for session lifecycle transitions and semantic signals.
 *
 * Usage:
 * ```ts
 * const watcher = new SessionWatcher('/home/user/myproject');
 * watcher.on('session:start', ({ sessionId }) => { ... });
 * watcher.on('signal:decision', ({ sessionId, message }) => { ... });
 * watcher.start();
 * ```
 */
export class SessionWatcher extends EventEmitter {
  private readonly projectPath: string;
  private readonly claudeProjectDir: string;
  private watcher: ReturnType<typeof chokidar.watch> | null = null;
  private sessions: Map<string, TrackedSession> = new Map();
  private running = false;

  constructor(projectPath: string) {
    super();
    this.projectPath = path.resolve(projectPath);
    this.claudeProjectDir = this.resolveClaudeProjectDir();
  }

  // ---- Public API -------------------------------------------------------------

  /**
   * Begin watching for session file changes. Safe to call multiple times —
   * subsequent calls are no-ops while already running.
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;

    // Ensure the directory exists before watching
    try {
      fs.mkdirSync(this.claudeProjectDir, { recursive: true });
    } catch {
      // Best-effort — chokidar can handle a missing directory if configured
    }

    const globPattern = path.join(this.claudeProjectDir, '*.jsonl');

    this.watcher = chokidar.watch(globPattern, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: false,
      // Use polling as a fallback for network-mounted home dirs
      usePolling: false,
    });

    this.watcher.on('add', (filePath: string) => this.handleNewFile(filePath));
    this.watcher.on('change', (filePath: string) => this.handleFileChange(filePath));
    this.watcher.on('error', (error: unknown) => this.emit('error', error));
  }

  /**
   * Stop watching and clean up all timers and tracked sessions.
   */
  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;

    // Close chokidar watcher
    if (this.watcher) {
      this.watcher.close().catch(() => {});
      this.watcher = null;
    }

    // Clear all inactivity timers
    for (const session of this.sessions.values()) {
      if (session.inactivityTimer) {
        clearTimeout(session.inactivityTimer);
      }
    }
    this.sessions.clear();
  }

  // ---- Internal ---------------------------------------------------------------

  /**
   * Resolve the Claude Code projects directory for the current project.
   *
   * Claude Code stores sessions at:
   *   ~/.claude/projects/<encoded-path>/
   *
   * where <encoded-path> replaces every `/` in the absolute project path
   * with `-`. e.g. `/home/user/myproject` -> `-home-user-myproject`
   */
  private resolveClaudeProjectDir(): string {
    const encoded = this.projectPath.replace(/\//g, '-');
    return path.join(os.homedir(), '.claude', 'projects', encoded);
  }

  /**
   * Derive a human-friendly session ID from a JSONL filename.
   * e.g. `abc123.jsonl` -> `abc123`
   */
  private sessionIdFromPath(filePath: string): string {
    return path.basename(filePath, '.jsonl');
  }

  /**
   * Handle a newly detected JSONL file (new session).
   */
  private handleNewFile(filePath: string): void {
    const sessionId = this.sessionIdFromPath(filePath);

    if (this.sessions.has(filePath)) {
      return;
    }

    const tracked: TrackedSession = {
      filePath,
      sessionId,
      byteOffset: 0,
      inactivityTimer: null,
    };

    this.sessions.set(filePath, tracked);
    this.emit('session:start', { sessionId, filePath });

    // Read any existing content in the file
    this.readNewLines(tracked);
    this.resetInactivityTimer(tracked);
  }

  /**
   * Handle a change event on an existing JSONL file (new messages appended).
   */
  private handleFileChange(filePath: string): void {
    let tracked = this.sessions.get(filePath);

    if (!tracked) {
      // File changed but we never saw the 'add' event — treat as new session
      const sessionId = this.sessionIdFromPath(filePath);
      tracked = {
        filePath,
        sessionId,
        byteOffset: 0,
        inactivityTimer: null,
      };
      this.sessions.set(filePath, tracked);
      this.emit('session:start', { sessionId, filePath });
    }

    this.readNewLines(tracked);
    this.resetInactivityTimer(tracked);
  }

  /**
   * Tail the file: read only bytes after our last known offset, split into
   * lines, and process each one.
   */
  private readNewLines(tracked: TrackedSession): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(tracked.filePath);
    } catch {
      return; // File may have been deleted
    }

    const fileSize = stat.size;
    if (fileSize <= tracked.byteOffset) {
      return; // No new data
    }

    const bytesToRead = fileSize - tracked.byteOffset;
    const buffer = Buffer.alloc(bytesToRead);

    let fd: number | null = null;
    try {
      fd = fs.openSync(tracked.filePath, 'r');
      fs.readSync(fd, buffer, 0, bytesToRead, tracked.byteOffset);
    } catch {
      return; // Read error — skip this round
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
    }

    tracked.byteOffset = fileSize;

    const chunk = buffer.toString('utf-8');
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const message = parseSessionLine(line);
      if (!message) {
        continue;
      }

      this.emit('session:message', { ...message, sessionId: tracked.sessionId });
      this.detectSignals(tracked.sessionId, message);
    }
  }

  /**
   * Reset the inactivity timer for a tracked session. If no new writes
   * arrive within SESSION_END_TIMEOUT_MS, emit 'session:end'.
   */
  private resetInactivityTimer(tracked: TrackedSession): void {
    if (tracked.inactivityTimer) {
      clearTimeout(tracked.inactivityTimer);
    }

    tracked.inactivityTimer = setTimeout(() => {
      this.emit('session:end', {
        sessionId: tracked.sessionId,
        filePath: tracked.filePath,
      });
      this.sessions.delete(tracked.filePath);
    }, SESSION_END_TIMEOUT_MS);
  }

  /**
   * Run signal pattern detection on a parsed message and emit matching events.
   */
  private detectSignals(sessionId: string, message: SessionMessage): void {
    const { content } = message;

    if (matchesAny(content, DECISION_PATTERNS)) {
      this.emit('signal:decision', { sessionId, message });
    }
    if (matchesAny(content, BUG_PATTERNS)) {
      this.emit('signal:bug', { sessionId, message });
    }
    if (matchesAny(content, ARCHITECTURE_PATTERNS)) {
      this.emit('signal:architecture', { sessionId, message });
    }
  }
}

// ---- Helpers ------------------------------------------------------------------

/**
 * Test whether a string matches any pattern in the provided list.
 */
function matchesAny(text: string, patterns: RegExp[]): boolean {
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}
