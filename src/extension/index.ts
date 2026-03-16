// ============================================================
// CORTEX - VSCode Extension Entry Point
// Registers tree views, webview providers, commands, and
// background watchers that power the Cortex memory system.
// ============================================================

import * as vscode from 'vscode';

import { MemoryTreeProvider } from './providers/memoryTreeProvider';
import { HealthViewProvider } from './providers/healthViewProvider';
import { SessionWatcher } from '../engine/watcher/sessionWatcher';
import { ClaudeMdInjector, setupAutoInjection } from '../engine/injector/claudeMdInjector';
import { MemoryStore } from '../engine/memory/memoryStore';
import type { CortexConfig } from '../types/index';

let sessionWatcher: SessionWatcher | null = null;
let disposeInjector: (() => void) | null = null;

// Shared output channel for extension-wide logging.
let outputChannel: vscode.OutputChannel;

/**
 * Called by VS Code when the extension is activated.
 * Sets up all providers, commands, and background processes.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('Cortex');
  outputChannel.appendLine('Cortex extension activating...');

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

  // ---- Sidebar tree view (memory layers) ----
  // MUST be registered synchronously before anything async,
  // otherwise VSCode shows "no data provider registered".
  const memoryTreeProvider = new MemoryTreeProvider();
  context.subscriptions.push(
    vscode.window.createTreeView('cortex-memory-tree', {
      treeDataProvider: memoryTreeProvider,
      showCollapseAll: true,
    }),
  );

  // ---- Health webview panel ----
  const healthViewProvider = new HealthViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('cortex-health', healthViewProvider),
  );

  // ---- Commands ----
  registerCommands(context, memoryTreeProvider, healthViewProvider);

  outputChannel.appendLine('Sidebar and commands registered.');

  // ---- Background processes (non-blocking) ----
  // These run after the UI is ready so they never block sidebar registration.
  if (workspaceRoot) {
    setImmediate(() => {
      try {
        sessionWatcher = new SessionWatcher(workspaceRoot);
        sessionWatcher.start();
        outputChannel.appendLine('Session watcher started.');
      } catch (err) {
        outputChannel.appendLine(`Failed to start session watcher: ${err}`);
      }
    });

    setImmediate(async () => {
      try {
        const store = new MemoryStore(workspaceRoot);
        disposeInjector = await setupAutoInjection(workspaceRoot, store);
        outputChannel.appendLine('CLAUDE.md injector started.');
      } catch (err) {
        outputChannel.appendLine(`Failed to start CLAUDE.md injector: ${err}`);
      }
    });
  }

  // ---- Ready ----
  outputChannel.appendLine('Cortex extension activated successfully.');
}

/**
 * Called by VS Code when the extension is deactivated.
 * Tears down background watchers and releases resources.
 */
export function deactivate(): void {
  if (sessionWatcher) {
    sessionWatcher.stop();
    sessionWatcher = null;
  }
  if (disposeInjector) {
    disposeInjector();
    disposeInjector = null;
  }

  if (outputChannel) {
    outputChannel.appendLine('Cortex extension deactivated.');
    outputChannel.dispose();
  }
}

// ------------------------------------------------------------------
// Command registration
// ------------------------------------------------------------------

function registerCommands(
  context: vscode.ExtensionContext,
  memoryTreeProvider: MemoryTreeProvider,
  healthViewProvider: HealthViewProvider,
): void {
  const commands: Array<{ id: string; handler: (...args: unknown[]) => unknown }> = [
    {
      id: 'cortex.init',
      handler: () => initializeProject(context),
    },
    {
      id: 'cortex.status',
      handler: () => showMemoryStatus(context),
    },
    {
      id: 'cortex.sync',
      handler: () => syncTeamMemory(context),
    },
    {
      id: 'cortex.search',
      handler: () => searchMemories(context),
    },
    {
      id: 'cortex.refresh',
      handler: () => {
        memoryTreeProvider.refresh();
        healthViewProvider.refresh();
        outputChannel.appendLine('Memory view refreshed.');
      },
    },
    {
      id: 'cortex.pinMemory',
      handler: (item: unknown) => pinMemory(item),
    },
    {
      id: 'cortex.unpinMemory',
      handler: (item: unknown) => unpinMemory(item),
    },
  ];

  for (const { id, handler } of commands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, handler),
    );
  }

  outputChannel.appendLine(`Registered ${commands.length} commands.`);
}

// ------------------------------------------------------------------
// Command implementations (stubs -- will be filled out as the
// corresponding engine modules are built)
// ------------------------------------------------------------------

async function initializeProject(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('Cortex: Open a workspace folder first.');
    return;
  }

  outputChannel.appendLine(`Initializing Cortex for ${workspaceFolders[0].uri.fsPath}`);
  vscode.window.showInformationMessage('Cortex: Project memory initialized.');
}

async function showMemoryStatus(_context: vscode.ExtensionContext): Promise<void> {
  outputChannel.appendLine('Showing memory status...');
  vscode.window.showInformationMessage('Cortex: Memory status shown in sidebar.');
}

async function syncTeamMemory(_context: vscode.ExtensionContext): Promise<void> {
  outputChannel.appendLine('Syncing team memory...');
  vscode.window.showInformationMessage('Cortex: Team memory synced.');
}

async function searchMemories(_context: vscode.ExtensionContext): Promise<void> {
  const query = await vscode.window.showInputBox({
    prompt: 'Search your project memory',
    placeHolder: 'e.g. "auth flow decision" or "why we chose Postgres"',
  });

  if (!query) {
    return;
  }

  outputChannel.appendLine(`Searching memories for: ${query}`);
  vscode.window.showInformationMessage(`Cortex: Searching for "${query}"...`);
}

async function pinMemory(item: unknown): Promise<void> {
  outputChannel.appendLine(`Pinning memory: ${JSON.stringify(item)}`);
  vscode.window.showInformationMessage('Cortex: Memory pinned.');
}

async function unpinMemory(item: unknown): Promise<void> {
  outputChannel.appendLine(`Unpinning memory: ${JSON.stringify(item)}`);
  vscode.window.showInformationMessage('Cortex: Memory unpinned.');
}
