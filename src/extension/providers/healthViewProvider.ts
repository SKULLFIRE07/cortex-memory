// ============================================================
// CORTEX - Health View Provider
// WebviewViewProvider for the 'cortex-health' panel
// ============================================================

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { MemoryHealth, StaleWarning } from '../../types/index';

export class HealthViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cortex-health';

  private view?: vscode.WebviewView;
  private health: MemoryHealth = HealthViewProvider.defaultHealth();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRefresh = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  // ----------------------------------------------------------
  // WebviewViewProvider implementation
  // ----------------------------------------------------------

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((message: { command: string }) => {
      if (message.command === 'refresh') {
        this.loadAndRender();
      }
    });

    // Refresh when the panel becomes visible again
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.loadAndRender();
      }
    });

    // If refresh was called before the view was resolved, load now
    this.loadAndRender();
    this.pendingRefresh = false;
  }

  /** Reload data from disk and re-render the webview. Debounced. */
  async refresh(): Promise<void> {
    // If the view hasn't been resolved yet (panel not opened), mark pending
    if (!this.view) {
      this.pendingRefresh = true;
      return;
    }

    // Debounce rapid refresh calls
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.loadAndRender();
    }, 400);
  }

  /** Force set the view and re-render (used when view becomes visible). */
  setView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.loadAndRender();
  }

  // ----------------------------------------------------------
  // Data loading
  // ----------------------------------------------------------

  private async loadAndRender(): Promise<void> {
    this.health = await this.loadHealth();
    if (this.view) {
      this.view.webview.html = this.buildHtml(this.health);
    }
  }

  private async loadHealth(): Promise<MemoryHealth> {
    const cortexDir = this.resolveCortexDir();
    if (!cortexDir) {
      return HealthViewProvider.defaultHealth();
    }

    const health: MemoryHealth = {
      score: 0,
      projectName: '',
      lastUpdated: '',
      workingMemoryTokens: 0,
      episodeCount: 0,
      decisionCount: 0,
      staleWarnings: [],
    };

    // Read working.md for token count and last-updated
    try {
      const workingPath = path.join(cortexDir, 'working.md');
      const stat = await fs.stat(workingPath);
      health.lastUpdated = stat.mtime.toISOString();

      const raw = await fs.readFile(workingPath, 'utf-8');
      // Rough token estimate: ~4 chars per token
      health.workingMemoryTokens = Math.ceil(raw.length / 4);
    } catch {
      // no working memory yet
    }

    // Also check CLAUDE.md — the injector updates it each session,
    // so use the most recent mtime between working.md and CLAUDE.md
    try {
      const workspaceRoot = path.dirname(cortexDir);
      const claudeMdPath = path.join(workspaceRoot, 'CLAUDE.md');
      const claudeStat = await fs.stat(claudeMdPath);
      const claudeMtime = claudeStat.mtime.toISOString();
      if (!health.lastUpdated || claudeMtime > health.lastUpdated) {
        health.lastUpdated = claudeMtime;
      }
    } catch {
      // no CLAUDE.md
    }

    // Count episodes
    try {
      const episodesDir = path.join(cortexDir, 'episodes');
      const entries = await fs.readdir(episodesDir);
      health.episodeCount = entries.filter((e) => e.endsWith('.md')).length;
    } catch {
      // no episodes directory
    }

    // Count decisions — only count ADR headings, not sub-headings like Context/Decision/Reason
    try {
      const decisionsPath = path.join(cortexDir, 'decisions.md');
      const raw = await fs.readFile(decisionsPath, 'utf-8');
      // Match only ADR-style headings: "## ADR: <title>"
      const adrHeadings = raw.match(/^## ADR:\s+.+$/gm);
      if (adrHeadings) {
        health.decisionCount = adrHeadings.length;
      } else {
        // Fallback: count ## headings that aren't meta headings or ADR sub-sections
        const skipHeadings = /^#{2,3}\s+(?:Decision Log|Decisions|Architectural|Context|Decision|Reason|Alternatives|Files Affected)\b/i;
        const allHeadings = raw.match(/^#{2,3}\s+.+$/gm) ?? [];
        health.decisionCount = allHeadings.filter(h => !skipHeadings.test(h)).length;
      }
    } catch {
      // no decisions file
    }

    // Check for stale warnings - flag if working memory is older than 3 days
    if (health.lastUpdated) {
      const lastUpdatedMs = new Date(health.lastUpdated).getTime();
      const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
      if (lastUpdatedMs < threeDaysAgo) {
        health.staleWarnings.push({
          module: 'Working Memory',
          lastMemoryUpdate: health.lastUpdated,
          recentFileChanges: 0,
          message: 'Working memory has not been updated in over 3 days.',
        });
      }
    }

    // Read project name from config
    try {
      const configPath = path.join(cortexDir, 'config.json');
      const raw = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(raw);
      health.projectName = config.projectName ?? '';
    } catch {
      const folders = vscode.workspace.workspaceFolders;
      health.projectName = folders?.[0]?.name ?? 'Unknown';
    }

    // Compute health score
    health.score = this.computeScore(health);

    return health;
  }

  private computeScore(h: MemoryHealth): number {
    let score = 0;

    // Has working memory at all? +30
    if (h.workingMemoryTokens > 0) {
      score += 30;
    }

    // Has episodes? up to +30
    score += Math.min(h.episodeCount * 5, 30);

    // Has decisions? up to +25
    score += Math.min(h.decisionCount * 5, 25);

    // Recency bonus: +15 if updated in the last day
    if (h.lastUpdated) {
      const ageMs = Date.now() - new Date(h.lastUpdated).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);
      if (ageHours < 24) {
        score += 15;
      } else if (ageHours < 72) {
        score += 8;
      }
    }

    // Deduct for stale warnings
    score -= h.staleWarnings.length * 10;

    return Math.max(0, Math.min(100, score));
  }

  // ----------------------------------------------------------
  // HTML rendering
  // ----------------------------------------------------------

  private buildHtml(h: MemoryHealth): string {
    const scoreColor = h.score >= 70 ? '#4ec9b0' : h.score >= 40 ? '#dcdcaa' : '#f44747';
    const maxTokens = 800; // matches cortex.maxWorkingMemoryTokens default
    const tokenPct = Math.min(100, Math.round((h.workingMemoryTokens / maxTokens) * 100));
    const tokenBarColor = tokenPct > 80 ? '#f44747' : tokenPct > 50 ? '#dcdcaa' : '#4ec9b0';

    const lastUpdatedDisplay = h.lastUpdated
      ? new Date(h.lastUpdated).toLocaleString()
      : 'Never';

    const staleHtml = h.staleWarnings.length > 0
      ? h.staleWarnings
          .map((w: StaleWarning) => `<div class="warning">${this.escapeHtml(w.message)}</div>`)
          .join('')
      : '<div class="ok">No stale warnings</div>';

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cortex Health</title>
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #1e1e1e);
      --fg: var(--vscode-sideBar-foreground, #cccccc);
      --border: var(--vscode-panel-border, #333333);
      --muted: var(--vscode-descriptionForeground, #888888);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      padding: 12px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .header h2 { font-size: 14px; font-weight: 600; }
    .refresh-btn {
      background: none;
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 3px 8px;
      cursor: pointer;
      border-radius: 3px;
      font-size: 12px;
    }
    .refresh-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, #2a2d2e);
    }
    .score-container {
      text-align: center;
      margin-bottom: 18px;
    }
    .score {
      font-size: 42px;
      font-weight: 700;
      color: ${scoreColor};
      line-height: 1;
    }
    .score-label {
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-top: 4px;
    }
    .section { margin-bottom: 14px; }
    .section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      margin-bottom: 6px;
      font-weight: 600;
    }
    .stat-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
      border-bottom: 1px solid var(--border);
    }
    .stat-row:last-child { border-bottom: none; }
    .stat-label { color: var(--fg); }
    .stat-value { font-weight: 600; font-variant-numeric: tabular-nums; }
    .bar-track {
      width: 100%;
      height: 6px;
      background: var(--border);
      border-radius: 3px;
      margin-top: 6px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .warning {
      background: rgba(244, 71, 71, 0.12);
      border-left: 3px solid #f44747;
      padding: 6px 10px;
      margin-bottom: 6px;
      border-radius: 0 3px 3px 0;
      font-size: 12px;
    }
    .ok {
      color: #4ec9b0;
      font-size: 12px;
    }
    .timestamp {
      text-align: center;
      font-size: 11px;
      color: var(--muted);
      margin-top: 16px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
    }
  </style>
</head>
<body>
  <div class="header">
    <h2>${this.escapeHtml(h.projectName || 'Cortex')}</h2>
    <button class="refresh-btn" onclick="refresh()">Refresh</button>
  </div>

  <div class="score-container">
    <div class="score">${h.score}</div>
    <div class="score-label">Memory Health</div>
  </div>

  <div class="section">
    <div class="section-title">Token Budget</div>
    <div class="stat-row">
      <span class="stat-label">Working Memory</span>
      <span class="stat-value">${h.workingMemoryTokens.toLocaleString()} / ${maxTokens.toLocaleString()}</span>
    </div>
    <div class="bar-track">
      <div class="bar-fill" style="width: ${tokenPct}%; background: ${tokenBarColor};"></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Stats</div>
    <div class="stat-row">
      <span class="stat-label">Episodes</span>
      <span class="stat-value">${h.episodeCount}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Decisions</span>
      <span class="stat-value">${h.decisionCount}</span>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Warnings</div>
    ${staleHtml}
  </div>

  <div class="timestamp">Last updated: ${this.escapeHtml(lastUpdatedDisplay)}</div>

  ${h.score === 0 ? `
  <div class="section" style="margin-top: 14px;">
    <div class="section-title">Getting Started</div>
    <div style="font-size: 12px; line-height: 1.6; color: var(--fg);">
      Cortex auto-captures memory from your AI coding sessions.<br><br>
      <strong>Just start coding</strong> with Claude Code, Cursor, or Cline — Cortex will remember everything automatically.
    </div>
  </div>
  ` : ''}

  <script>
    const vscode = acquireVsCodeApi();
    function refresh() {
      vscode.postMessage({ command: 'refresh' });
    }
  </script>
</body>
</html>`;
  }

  // ----------------------------------------------------------
  // Utility
  // ----------------------------------------------------------

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private resolveCortexDir(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    return path.join(folders[0].uri.fsPath, '.cortex');
  }

  private static defaultHealth(): MemoryHealth {
    return {
      score: 0,
      projectName: '',
      lastUpdated: '',
      workingMemoryTokens: 0,
      episodeCount: 0,
      decisionCount: 0,
      staleWarnings: [],
    };
  }
}
