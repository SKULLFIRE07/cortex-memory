// ============================================================
// CORTEX - Claude Code Hooks Manager
// ============================================================
// Manages installation and monitoring of Claude Code hooks that
// fire shell commands at lifecycle events (SessionStart, SessionEnd,
// PreCompact, Stop). Hooks write signal files to .cortex/.hooks/
// which this module watches to trigger memory operations.
//
// Claude Code hooks config format (in .claude/settings.json):
//   "hooks": {
//     "PreToolUse": [{ "type": "command", "command": "..." }],
//     "PostToolUse": [{ "type": "command", "command": "..." }],
//     "Notification": [{ "type": "command", "command": "..." }],
//     "Stop": [{ "type": "command", "command": "..." }]
//   }
//
// Available hook events in Claude Code:
//   - PreToolUse, PostToolUse, Notification, Stop
//
// Note: Claude Code passes hook context via stdin as JSON, including
// session_id and other metadata.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { HookEvent } from '../../types/index.js';

/** Claude Code hook event names that Cortex integrates with. */
const HOOK_EVENTS = ['Notification', 'Stop'] as const;
type HookEventName = (typeof HOOK_EVENTS)[number];

/** Map from Claude Code hook name to our HookEvent type string. */
const EVENT_TYPE_MAP: Record<HookEventName, HookEvent['type']> = {
  Notification: 'pre_compact',
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
 * Build the shell command that a hook executes.
 * Reads session context from stdin (Claude Code passes JSON to hooks via stdin)
 * and writes a signal file to .cortex/.hooks/
 */
function buildHookCommand(projectPath: string, eventType: HookEvent['type']): string {
  const hooksDir = path.join(projectPath, '.cortex', '.hooks');
  // Use a Node one-liner that reads stdin for session context
  return (
    `node -e "` +
    `const fs=require('fs');` +
    `let input='';` +
    `process.stdin.on('data',d=>input+=d);` +
    `process.stdin.on('end',()=>{` +
    `let sid='unknown';` +
    `try{const ctx=JSON.parse(input);sid=ctx.session_id||ctx.sessionId||'unknown';}catch(e){}` +
    `fs.mkdirSync('${hooksDir.replace(/'/g, "\\'")}',{recursive:true});` +
    `fs.writeFileSync('${hooksDir.replace(/'/g, "\\'")}/${eventType}_'+Date.now()+'.json',` +
    `JSON.stringify({type:'${eventType}',sessionId:sid,timestamp:new Date().toISOString()}));` +
    `});"`
  );
}

/**
 * Manages Claude Code hooks integration for Cortex.
 */
export class HooksManager {
  private readonly projectPath: string;
  private readonly settingsPath: string;
  private readonly hooksDir: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    // Claude Code project settings are at <project>/.claude/settings.json
    this.settingsPath = path.join(projectPath, '.claude', 'settings.json');
    this.hooksDir = path.join(projectPath, '.cortex', '.hooks');
  }

  // ------------------------------------------------------------------
  // Installation
  // ------------------------------------------------------------------

  async installHooks(): Promise<void> {
    const settings = await this.readSettings();

    if (!settings.hooks) {
      settings.hooks = {};
    }

    for (const event of HOOK_EVENTS) {
      const eventType = EVENT_TYPE_MAP[event];
      const command = buildHookCommand(this.projectPath, eventType);
      const entry: ClaudeHookEntry = { type: 'command', command };

      const existing = settings.hooks[event] ?? [];

      const alreadyInstalled = existing.some(
        (h) => h.command.includes('.cortex'),
      );
      if (!alreadyInstalled) {
        settings.hooks[event] = [...existing, entry];
      }
    }

    await this.writeSettings(settings);
  }

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

    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    await this.writeSettings(settings);
  }

  // ------------------------------------------------------------------
  // Signal Watching
  // ------------------------------------------------------------------

  async watchHookSignals(
    callback: (event: HookEvent) => void,
  ): Promise<() => void> {
    await fs.mkdir(this.hooksDir, { recursive: true });
    await this.processSignalFiles(callback);

    let stopped = false;

    const pollIntervalMs = 1000;
    const intervalId = setInterval(async () => {
      if (stopped) return;
      try {
        await this.processSignalFiles(callback);
      } catch {
        // Ignore transient errors
      }
    }, pollIntervalMs);

    // Also try native fs.watch for lower latency
    let watcher: ReturnType<typeof import('fs').watch> | null = null;
    try {
      const fsSync = await import('fs');
      watcher = fsSync.watch(this.hooksDir, async (eventType, filename) => {
        if (stopped || !filename || !filename.endsWith('.json')) return;
        try {
          await this.processSignalFiles(callback);
        } catch {
          // Ignore
        }
      });
      watcher.on('error', () => {});
    } catch {
      // fs.watch not available
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

  private async writeSettings(settings: ClaudeSettings): Promise<void> {
    const dir = path.dirname(this.settingsPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      this.settingsPath,
      JSON.stringify(settings, null, 2) + '\n',
      'utf-8',
    );
  }

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
      .sort();

    for (const file of jsonFiles) {
      const filePath = path.join(this.hooksDir, file);
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<HookEvent>;

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

        await fs.unlink(filePath);
      } catch {
        try {
          await fs.unlink(filePath);
        } catch {
          // Ignore
        }
      }
    }
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
