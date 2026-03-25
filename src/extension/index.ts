// ============================================================
// CORTEX - VSCode Extension Entry Point
// Zero-config: Install → works. No setup needed.
// ============================================================

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

import { MemoryTreeProvider } from './providers/memoryTreeProvider';
import { HealthViewProvider } from './providers/healthViewProvider';
import { CortexOrchestrator } from '../engine/orchestrator';
import type { CortexConfig } from '../types/index';

let orchestrator: CortexOrchestrator | null = null;
let outputChannel: vscode.OutputChannel;

// ================================================================
// Activation
// ================================================================

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('Cortex');
  outputChannel.appendLine('Cortex extension activating...');

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

  // ---- Register UI synchronously (MUST happen before any async) ----
  const memoryTreeProvider = new MemoryTreeProvider();
  context.subscriptions.push(
    vscode.window.createTreeView('cortex-memory-tree', {
      treeDataProvider: memoryTreeProvider,
      showCollapseAll: true,
    }),
  );

  const healthViewProvider = new HealthViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('cortex-health', healthViewProvider),
  );

  registerCommands(context, memoryTreeProvider, healthViewProvider);

  // ---- Status bar (always visible) ----
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBar.text = '$(brain) Cortex';
  statusBar.tooltip = 'Cortex Memory System';
  statusBar.command = 'cortex.status';
  statusBar.show();
  context.subscriptions.push(statusBar);

  outputChannel.appendLine('UI registered.');

  // ---- Background setup (non-blocking) ----
  if (!workspaceRoot) {
    outputChannel.appendLine('No workspace open, skipping Cortex setup.');
    return;
  }

  setImmediate(async () => {
    try {
      await setupCortex(
        context, workspaceRoot, memoryTreeProvider, healthViewProvider, statusBar,
      );
    } catch (err) {
      outputChannel.appendLine(`Cortex setup failed: ${err}`);
    }
  });

  outputChannel.appendLine('Cortex extension activated.');
}

export async function deactivate(): Promise<void> {
  if (orchestrator) {
    await orchestrator.shutdown();
    orchestrator = null;
  }
  if (outputChannel) {
    outputChannel.appendLine('Cortex extension deactivated.');
    outputChannel.dispose();
  }
}

// ================================================================
// Core Setup — runs in background, handles everything automatically
// ================================================================

async function setupCortex(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  memoryTreeProvider: MemoryTreeProvider,
  healthViewProvider: HealthViewProvider,
  statusBar: vscode.StatusBarItem,
): Promise<void> {
  const cortexDir = path.join(workspaceRoot, '.cortex');
  const isFirstRun = context.globalState.get<boolean>('cortex.welcomed') !== true;
  const projectName = path.basename(workspaceRoot);

  // ---- Step 1: Auto-initialize .cortex/ silently ----
  await silentInit(cortexDir, projectName, workspaceRoot);
  outputChannel.appendLine('.cortex/ directory ready.');

  // ---- Step 2: Migrate old formats if needed ----
  await migrateOldTemplate(cortexDir);

  // ---- Step 3: File watcher for .cortex/ changes ----
  setupFileWatcher(context, cortexDir, memoryTreeProvider, healthViewProvider);

  // ---- Step 4: Refresh views ----
  memoryTreeProvider.refresh();
  healthViewProvider.refresh();

  // ---- Step 5: Read config ----
  const config = vscode.workspace.getConfiguration('cortex');
  const llmProvider = config.get<'gemini' | 'anthropic' | 'ollama'>('llmProvider', 'gemini');
  const apiKey = config.get<string>('apiKey', '');
  const llmModel = config.get<string>('llmModel', '');
  const maxTokens = config.get<number>('maxWorkingMemoryTokens', 800);

  // ---- Step 6: Start orchestrator ----
  orchestrator = new CortexOrchestrator({
    projectPath: workspaceRoot,
    apiKey: apiKey || undefined,
    llmProvider,
    llmModel: llmModel || undefined,
    maxTokens,
  });

  wireOrchestratorEvents(orchestrator, memoryTreeProvider, healthViewProvider, statusBar);
  await orchestrator.initialize();
  outputChannel.appendLine(`Orchestrator running (provider: ${llmProvider}).`);

  // ---- Step 7: First-run welcome ----
  if (isFirstRun) {
    showWelcome(context, apiKey, llmProvider);
  } else if (!apiKey && llmProvider !== 'ollama') {
    // Gentle nudge for API key (not on first run — welcome handles it)
    statusBar.tooltip = 'Cortex - Running (basic mode, set API key for full extraction)';
  }
}

// ================================================================
// Silent auto-init — creates .cortex/ without bothering the user
// ================================================================

async function silentInit(
  cortexDir: string,
  projectName: string,
  workspaceRoot: string,
): Promise<void> {
  // Create directories
  await fs.mkdir(path.join(cortexDir, 'episodes'), { recursive: true });

  // Create working.md if missing
  const workingPath = path.join(cortexDir, 'working.md');
  if (!await fileExists(workingPath)) {
    await fs.writeFile(workingPath, `# Working Memory

> Last updated: ${new Date().toISOString()}

## Last Session

_No sessions recorded yet. Start coding with an AI assistant and Cortex will capture context automatically._

## Current Context

- Project: ${projectName}
- Status: Ready
`, 'utf-8');
  }

  // Create decisions.md if missing
  const decisionsPath = path.join(cortexDir, 'decisions.md');
  if (!await fileExists(decisionsPath)) {
    await fs.writeFile(decisionsPath, `# Decision Log

> Architectural and design decisions are recorded here automatically.

---

_No decisions recorded yet._
`, 'utf-8');
  }

  // Create config.json if missing
  const configPath = path.join(cortexDir, 'config.json');
  if (!await fileExists(configPath)) {
    const config: CortexConfig = {
      version: '0.1.0',
      projectName,
      projectPath: workspaceRoot,
      createdAt: new Date().toISOString(),
      maxWorkingMemoryTokens: 800,
      autoInject: true,
      extractionModel: 'claude-haiku-4-5-20251001',
      teamSyncEnabled: false,
      ignorePaths: ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'],
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  // Add .cortex/ to .gitignore if not already there
  await ensureGitignore(path.dirname(cortexDir));
}

// ================================================================
// Welcome flow — friendly, not annoying
// ================================================================

async function showWelcome(
  context: vscode.ExtensionContext,
  apiKey: string,
  llmProvider: string,
): Promise<void> {
  // Mark as welcomed so we don't show this again
  await context.globalState.update('cortex.welcomed', true);

  if (apiKey || llmProvider === 'ollama') {
    // They already have an API key — just confirm it's working
    vscode.window.showInformationMessage(
      'Cortex is ready! Your AI sessions will be remembered automatically.',
      'Open Sidebar',
    ).then(choice => {
      if (choice === 'Open Sidebar') {
        vscode.commands.executeCommand('cortex-sidebar.focus');
      }
    });
  } else {
    // No API key — guide them
    const choice = await vscode.window.showInformationMessage(
      'Cortex installed! It works out of the box with basic memory. ' +
      'Add a free Gemini API key for full AI-powered extraction.',
      'Get Free API Key',
      'Set API Key',
      'Skip (use basic mode)',
    );

    if (choice === 'Get Free API Key') {
      vscode.env.openExternal(vscode.Uri.parse('https://aistudio.google.com/apikey'));
      // After they get the key, prompt to set it
      setTimeout(() => {
        vscode.window.showInformationMessage(
          'Got your Gemini API key? Set it now:',
          'Set API Key',
        ).then(c => {
          if (c === 'Set API Key') {
            promptForApiKey();
          }
        });
      }, 5000);
    } else if (choice === 'Set API Key') {
      promptForApiKey();
    }
    // "Skip" — do nothing, basic mode works fine
  }
}

async function promptForApiKey(): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: 'Enter your Gemini API key (free from aistudio.google.com/apikey)',
    placeHolder: 'AIza...',
    password: true,
    ignoreFocusOut: true,
  });

  if (key && key.trim()) {
    const config = vscode.workspace.getConfiguration('cortex');
    await config.update('apiKey', key.trim(), vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      'Cortex: API key saved! Reload window to activate full extraction.',
      'Reload Now',
    ).then(choice => {
      if (choice === 'Reload Now') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
  }
}

// ================================================================
// Wire orchestrator events to UI
// ================================================================

function wireOrchestratorEvents(
  orch: CortexOrchestrator,
  memoryTreeProvider: MemoryTreeProvider,
  healthViewProvider: HealthViewProvider,
  statusBar: vscode.StatusBarItem,
): void {
  orch.on('error', (err: Error) => {
    outputChannel.appendLine(`Error: ${err.message}`);
  });

  orch.on('extraction:complete', () => {
    outputChannel.appendLine('LLM extraction complete.');
    memoryTreeProvider.refresh();
    healthViewProvider.refresh();
  });

  orch.on('injection:complete', () => {
    memoryTreeProvider.refresh();
  });

  // Real-time updates — debounced
  let refreshDebounce: ReturnType<typeof setTimeout> | null = null;
  orch.on('memory:updated', () => {
    if (refreshDebounce) clearTimeout(refreshDebounce);
    refreshDebounce = setTimeout(() => {
      memoryTreeProvider.refresh();
      healthViewProvider.refresh();
      refreshDebounce = null;
    }, 2000);
  });

  orch.on('session:started', (sessionId: string) => {
    outputChannel.appendLine(`Session started: ${sessionId.slice(0, 8)}...`);
    statusBar.text = '$(sync~spin) Cortex: Live';
    statusBar.tooltip = 'Cortex — Session Active (Real-Time Updates)';
    memoryTreeProvider.refresh();
    healthViewProvider.refresh();
  });

  orch.on('session:ended', (sessionId: string) => {
    outputChannel.appendLine(`Session ended: ${sessionId.slice(0, 8)}...`);
    statusBar.text = '$(brain) Cortex';
    statusBar.tooltip = 'Cortex Memory System — Idle';
    vscode.window.setStatusBarMessage('$(check) Cortex: Memory saved', 3000);
    memoryTreeProvider.refresh();
    healthViewProvider.refresh();
  });
}

// ================================================================
// File watcher
// ================================================================

function setupFileWatcher(
  context: vscode.ExtensionContext,
  cortexDir: string,
  memoryTreeProvider: MemoryTreeProvider,
  healthViewProvider: HealthViewProvider,
): void {
  let debounce: ReturnType<typeof setTimeout> | null = null;

  (async () => {
    try {
      const { watch } = await import('chokidar');
      const watcher = watch(cortexDir, {
        ignoreInitial: true,
        depth: 1,
        ignorePermissionErrors: true,
        ignored: [/(^|[/\\])\../], // ignore dotfiles like .hooks/
      });
      watcher.on('all', () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = null;
          memoryTreeProvider.refresh();
          healthViewProvider.refresh();
        }, 500);
      });
      context.subscriptions.push({ dispose: () => watcher.close() });
    } catch (err) {
      outputChannel.appendLine(`File watcher failed (non-critical): ${err}`);
    }
  })();
}

// ================================================================
// Commands
// ================================================================

function registerCommands(
  context: vscode.ExtensionContext,
  memoryTreeProvider: MemoryTreeProvider,
  healthViewProvider: HealthViewProvider,
): void {
  const commands: Array<{ id: string; handler: (...args: unknown[]) => unknown }> = [
    {
      id: 'cortex.init',
      handler: async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
          vscode.window.showWarningMessage('Cortex: Open a workspace folder first.');
          return;
        }
        await silentInit(
          path.join(root, '.cortex'),
          path.basename(root),
          root,
        );
        memoryTreeProvider.refresh();
        healthViewProvider.refresh();
        vscode.window.showInformationMessage('Cortex: Project memory initialized.');
      },
    },
    {
      id: 'cortex.status',
      handler: () => showMemoryStatus(),
    },
    {
      id: 'cortex.sync',
      handler: () => {
        vscode.window.showInformationMessage('Cortex: Team sync coming soon.');
      },
    },
    {
      id: 'cortex.search',
      handler: () => searchMemories(),
    },
    {
      id: 'cortex.refresh',
      handler: () => {
        memoryTreeProvider.refresh();
        healthViewProvider.refresh();
        vscode.window.setStatusBarMessage('$(check) Cortex: Refreshed', 2000);
      },
    },
    {
      id: 'cortex.setApiKey',
      handler: () => promptForApiKey(),
    },
    {
      id: 'cortex.pinMemory',
      handler: () => vscode.window.showInformationMessage('Cortex: Pin memory — coming soon.'),
    },
    {
      id: 'cortex.unpinMemory',
      handler: () => vscode.window.showInformationMessage('Cortex: Unpin memory — coming soon.'),
    },
  ];

  for (const { id, handler } of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }
}

// ================================================================
// Command implementations
// ================================================================

async function showMemoryStatus(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showWarningMessage('Cortex: Open a workspace folder first.');
    return;
  }

  const cortexDir = path.join(workspaceRoot, '.cortex');
  let workingTokens = 0;
  let maxTokens = 800;
  let episodeCount = 0;
  let decisionCount = 0;

  try {
    const raw = await fs.readFile(path.join(cortexDir, 'working.md'), 'utf-8');
    workingTokens = Math.ceil(raw.length / 4);
  } catch {}

  try {
    const configRaw = await fs.readFile(path.join(cortexDir, 'config.json'), 'utf-8');
    const config = JSON.parse(configRaw);
    if (config.maxWorkingMemoryTokens) maxTokens = config.maxWorkingMemoryTokens;
  } catch {}

  try {
    const files = await fs.readdir(path.join(cortexDir, 'episodes'));
    episodeCount = files.filter(f => f.endsWith('.md')).length;
  } catch {}

  try {
    const raw = await fs.readFile(path.join(cortexDir, 'decisions.md'), 'utf-8');
    const adrs = raw.match(/^## ADR:/gm);
    decisionCount = adrs ? adrs.length : 0;
  } catch {}

  let score = 0;
  if (workingTokens > 0) { score += 15; score += workingTokens <= maxTokens ? 15 : 5; }
  if (episodeCount > 0) score += 15;
  if (episodeCount >= 3) score += 10;
  if (episodeCount >= 10) score += 5;
  if (decisionCount > 0) score += 10;
  if (decisionCount >= 3) score += 5;
  if (decisionCount >= 10) score += 5;
  score = Math.min(100, score);

  vscode.window.showInformationMessage(
    `Cortex: Health ${score}/100 | Tokens: ${workingTokens}/${maxTokens} | Episodes: ${episodeCount} | Decisions: ${decisionCount}`,
  );
}

async function searchMemories(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showWarningMessage('Cortex: Open a workspace folder first.');
    return;
  }

  const query = await vscode.window.showInputBox({
    prompt: 'Search your project memory',
    placeHolder: 'e.g. "auth flow" or "why we chose Postgres"',
  });
  if (!query) return;

  const cortexDir = path.join(workspaceRoot, '.cortex');
  const term = query.toLowerCase();
  const results: Array<{ label: string; description: string; detail: string; filePath: string }> = [];

  // Search working memory
  try {
    const workingPath = path.join(cortexDir, 'working.md');
    const raw = await fs.readFile(workingPath, 'utf-8');
    if (raw.toLowerCase().includes(term)) {
      const lines = raw.split('\n').filter(l => l.toLowerCase().includes(term)).slice(0, 3);
      for (const line of lines) {
        results.push({
          label: '$(file) Working Memory',
          description: line.trim().slice(0, 80),
          detail: workingPath,
          filePath: workingPath,
        });
      }
    }
  } catch {}

  // Search decisions
  try {
    const decisionsPath = path.join(cortexDir, 'decisions.md');
    const raw = await fs.readFile(decisionsPath, 'utf-8');
    if (raw.toLowerCase().includes(term)) {
      for (const section of raw.split(/^## /m).slice(1)) {
        if (section.toLowerCase().includes(term)) {
          results.push({
            label: `$(law) Decision: ${section.split('\n')[0].trim()}`,
            description: section.split('\n').find(l => l.toLowerCase().includes(term))?.trim().slice(0, 80) ?? '',
            detail: decisionsPath,
            filePath: decisionsPath,
          });
        }
      }
    }
  } catch {}

  // Search episodes
  try {
    const episodesDir = path.join(cortexDir, 'episodes');
    for (const file of await fs.readdir(episodesDir)) {
      const filePath = path.join(episodesDir, file);
      const content = await fs.readFile(filePath, 'utf-8');
      if (!content.toLowerCase().includes(term)) continue;
      const title = content.match(/^#\s+(.+)$/m)?.[1] ?? file.replace('.md', '');
      results.push({
        label: `$(history) Episode: ${title}`,
        description: content.split('\n').find(l => l.toLowerCase().includes(term))?.trim().slice(0, 80) ?? '',
        detail: filePath,
        filePath,
      });
    }
  } catch {}

  if (results.length === 0) {
    vscode.window.showInformationMessage(`Cortex: No results for "${query}".`);
    return;
  }

  const selected = await vscode.window.showQuickPick(results, {
    placeHolder: `${results.length} result(s) for "${query}"`,
    matchOnDescription: true,
  });

  if (selected) {
    const doc = await vscode.workspace.openTextDocument(selected.filePath);
    await vscode.window.showTextDocument(doc);
  }
}

// ================================================================
// Utilities
// ================================================================

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Add .cortex/ to .gitignore if it's not already there.
 */
async function ensureGitignore(projectRoot: string): Promise<void> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  try {
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
    } catch {
      // No .gitignore yet
    }

    if (!content.includes('.cortex')) {
      const addition = content.endsWith('\n') || content === ''
        ? '.cortex/\n'
        : '\n.cortex/\n';
      await fs.appendFile(gitignorePath, addition, 'utf-8');
      outputChannel.appendLine('Added .cortex/ to .gitignore');
    }
  } catch {
    // Not a git repo or can't write — skip
  }
}

/**
 * Migrate old working.md template format.
 */
async function migrateOldTemplate(cortexDir: string): Promise<void> {
  const workingPath = path.join(cortexDir, 'working.md');
  try {
    const raw = await fs.readFile(workingPath, 'utf-8');
    const isOldTemplate = raw.includes('## Last Session Summary')
      && (raw.includes('_None yet._') || raw.includes('_No sessions recorded yet'));
    const hasNoRealContent = !raw.includes('> Last updated:');

    if (isOldTemplate && hasNoRealContent) {
      const projectName = path.basename(path.dirname(cortexDir));
      await fs.writeFile(workingPath, `# Working Memory

> Last updated: ${new Date().toISOString()}

## Last Session

_No sessions recorded yet. Start coding and Cortex will capture context automatically._

## Current Context

- Project: ${projectName}
- Status: Ready
`, 'utf-8');
      outputChannel.appendLine('Migrated old working.md template.');
    }
  } catch {}
}
