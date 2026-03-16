// ============================================================
// CORTEX - Claude Code Hooks Manager
// ============================================================
// Manages installation and monitoring of Claude Code hooks that
// fire shell commands at lifecycle events (SessionStart, SessionEnd,
// PreCompact, Stop). Hooks write signal files to .cortex/.hooks/
// which this module watches to trigger memory operations.

import * as fs from 'fs/promises';
import * as path from 'path';
import type { HookEvent } from '../../types/index.js';

/** Claude Code hook event names that Cortex integrates with. */
const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'PreCompact', 'Stop'] as const;
type HookEventName = (typeof HOOK_EVENTS)[number];

/** Map from Claude Code hook name to our HookEvent type string. */
const EVENT_TYPE_MAP: Record<HookEventName, HookEvent['type']> = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  PreCompact: 'pre_compact',
  Stop: 'stop',
};

/** Shape of a single hook entry in Claude Code settings.json. */
interface ClaudeHookEntry {
  type: 'command';
  command: string;
}

/** Shape of Claude Code settings.json (partial). */
interface ClaudeSettings {
  hooks?: Partial<Record<string, ClaudeHookEntry[]>>;
  [key: string]: unknown;
}

/**
 * Build the Node one-liner command that a hook executes.
 * It creates the .cortex/.hooks/ directory and writes a signal JSON file.
 */
function buildHookCommand(eventType: HookEvent['type']): string {
  return (
    `node -e "const fs=require('fs');` +
    `fs.mkdirSync('.cortex/.hooks',{recursive:true});` +
    `fs.writeFileSync('.cortex/.hooks/${eventType}_'+Date.now()+'.json',` +
    `JSON.stringify({type:'${eventType}',` +
    `sessionId:process.env.SESSION_ID||'unknown',` +
    `timestamp:new Date().toISOString()}))"`
  );
}

/**
 * Manages Claude Code hooks integration for Cortex.
 *
 * Claude Code hooks are configured in `.claude/settings.json` and fire shell
 * commands at lifecycle events. This manager installs commands that write
 * signal files, then watches for those files to drive memory operations.
 */
export class HooksManager {
  private readonly projectPath: string;
  private readonly settingsPath: string;
  private readonly hooksDir: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.settingsPath = path.join(projectPath, '.claude', 'settings.json');
    this.hooksDir = path.join(projectPath, '.cortex', '.hooks');
  }

  // ------------------------------------------------------------------
  // Installation
  // ------------------------------------------------------------------

  /**
   * Install Cortex hooks into the project's `.claude/settings.json`.
   *
   * Reads (or creates) the settings file and merges Cortex hook commands
   * into the existing configuration without overwriting other hooks.
   */
  async installHooks(): Promise<void> {
    const settings = await this.readSettings();

    if (!settings.hooks) {
      settings.hooks = {};
    }

    for (const event of HOOK_EVENTS) {
      const eventType = EVENT_TYPE_MAP[event];
      const command = buildHookCommand(eventType);
      const entry: ClaudeHookEntry = { type: 'command', command };

      const existing = settings.hooks[event] ?? [];

      // Only add if Cortex's hook isn't already present.
      const alreadyInstalled = existing.some(
        (h) => h.command.includes('.cortex'),
      );
      if (!alreadyInstalled) {
        settings.hooks[event] = [...existing, entry];
      }
    }

    await this.writeSettings(settings);
  }

  /**
   * Remove only Cortex's hooks from `.claude/settings.json`.
   *
   * Other hooks (not containing '.cortex' in the command) are preserved.
   * If a hook event array becomes empty after removal it is deleted from
   * the hooks object entirely.
   */
  async uninstallHooks(): Promise<void> {
    const settings = await this.readSettings();

    if (!settings.hooks) {
      return;
    }

    for (const event of HOOK_EVENTS) {
      const entries = settings.hooks[event];
      if (!entries) {
        continue;
      }

      const filtered = entries.filter(
        (h) => !h.command.includes('.cortex'),
      );

      if (filtered.length === 0) {
        delete settings.hooks[event];
      } else {
        settings.hooks[event] = filtered;
      }
    }

    // Clean up empty hooks object.
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    await this.writeSettings(settings);
  }

  // ------------------------------------------------------------------
  // Signal Watching
  // ------------------------------------------------------------------

  /**
   * Watch the `.cortex/.hooks/` directory for new signal files.
   *
   * Uses polling via `fs.watch` (or a manual interval when `fs.watch` is
   * unreliable) to detect new JSON signal files written by hooks. Each
   * file is parsed, the callback is invoked, and the file is deleted.
   *
   * Returns a cleanup function that stops the watcher.
   */
  async watchHookSignals(
    callback: (event: HookEvent) => void,
  ): Promise<() => void> {
    // Ensure the hooks directory exists before watching.
    await fs.mkdir(this.hooksDir, { recursive: true });

    // Process any signal files already present.
    await this.processSignalFiles(callback);

    let stopped = false;

    // Use a polling interval because fs.watch is unreliable on some
    // platforms (especially for newly-created directories / network fs).
    const pollIntervalMs = 1000;
    const intervalId = setInterval(async () => {
      if (stopped) {
        return;
      }
      try {
        await this.processSignalFiles(callback);
      } catch {
        // Directory may have been removed; ignore transient errors.
      }
    }, pollIntervalMs);

    // Also attempt native fs.watch for lower latency on supported OSes.
    let watcher: ReturnType<typeof import('fs').watch> | null = null;
    try {
      // Dynamic require so the module works even if fs.watch throws.
      const fsSync = await import('fs');
      watcher = fsSync.watch(this.hooksDir, async (eventType, filename) => {
        if (stopped || !filename || !filename.endsWith('.json')) {
          return;
        }
        try {
          await this.processSignalFiles(callback);
        } catch {
          // Ignore transient errors.
        }
      });

      // Prevent unhandled 'error' events from crashing the process.
      watcher.on('error', () => {});
    } catch {
      // fs.watch not available; polling will handle it.
    }

    return () => {
      stopped = true;
      clearInterval(intervalId);
      if (watcher) {
        watcher.close();
      }
    };
  }

  // ------------------------------------------------------------------
  // Status
  // ------------------------------------------------------------------

  /**
   * Check whether Cortex hooks are currently installed in settings.json.
   */
  async isInstalled(): Promise<boolean> {
    try {
      const settings = await this.readSettings();
      if (!settings.hooks) {
        return false;
      }

      return HOOK_EVENTS.some((event) => {
        const entries = settings.hooks?.[event];
        return entries?.some((h) => h.command.includes('.cortex')) ?? false;
      });
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /**
   * Read and parse `.claude/settings.json`, returning an empty object
   * if the file doesn't exist yet.
   */
  private async readSettings(): Promise<ClaudeSettings> {
    try {
      const raw = await fs.readFile(this.settingsPath, 'utf-8');
      return JSON.parse(raw) as ClaudeSettings;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return {};
      }
      throw err;
    }
  }

  /**
   * Write settings back to `.claude/settings.json`, creating the
   * directory if necessary.
   */
  private async writeSettings(settings: ClaudeSettings): Promise<void> {
    const dir = path.dirname(this.settingsPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      this.settingsPath,
      JSON.stringify(settings, null, 2) + '\n',
      'utf-8',
    );
  }

  /**
   * Scan the hooks directory for signal JSON files, parse each one,
   * invoke the callback, and delete the processed file.
   */
  private async processSignalFiles(
    callback: (event: HookEvent) => void,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.hooksDir);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return;
      }
      throw err;
    }

    const jsonFiles = entries
      .filter((f) => f.endsWith('.json'))
      .sort(); // Process in chronological order.

    for (const file of jsonFiles) {
      const filePath = path.join(this.hooksDir, file);
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<HookEvent>;

        // Validate minimal required fields.
        if (parsed.type && parsed.timestamp) {
          const event: HookEvent = {
            type: parsed.type as HookEvent['type'],
            sessionId: parsed.sessionId ?? 'unknown',
            timestamp: parsed.timestamp,
            source: 'hook',
            projectPath: this.projectPath,
          };
          callback(event);
        }

        // Delete after successful processing.
        await fs.unlink(filePath);
      } catch {
        // If the file can't be parsed (partial write, etc.), attempt
        // removal so it doesn't block future processing.
        try {
          await fs.unlink(filePath);
        } catch {
          // Ignore – file may already be gone.
        }
      }
    }
  }
}

// ------------------------------------------------------------------
// Utility
// ------------------------------------------------------------------

/** Type guard for Node.js system errors with a `code` property. */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
