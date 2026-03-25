// ============================================================
// CORTEX - Memory Tree Data Provider
// Shows the 3-layer memory structure in the VSCode sidebar
// ============================================================

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import type {
  WorkingMemory,
  EpisodicMemory,
  DecisionEntry,
} from '../../types/index';

// ------------------------------------------------------------
// Tree Item
// ------------------------------------------------------------

export class MemoryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly layer: 'working' | 'episodic' | 'decisions' | 'leaf',
    public readonly filePath?: string,
    public readonly lineNumber?: number,
  ) {
    super(label, collapsibleState);

    if (filePath) {
      this.command = {
        command: 'vscode.open',
        title: 'Open Memory File',
        arguments: [
          vscode.Uri.file(filePath),
          lineNumber !== undefined
            ? <vscode.TextDocumentShowOptions>{ selection: new vscode.Range(lineNumber, 0, lineNumber, 0) }
            : undefined,
        ],
      };
      this.tooltip = filePath;
    }

    this.iconPath = MemoryTreeItem.iconForLayer(layer, label);
    this.contextValue = layer;
  }

  private static iconForLayer(
    layer: string,
    label: string,
  ): vscode.ThemeIcon {
    switch (layer) {
      case 'working':
        return new vscode.ThemeIcon('flame', new vscode.ThemeColor('charts.red'));
      case 'episodic':
        return new vscode.ThemeIcon('history', new vscode.ThemeColor('charts.orange'));
      case 'decisions':
        return new vscode.ThemeIcon('law', new vscode.ThemeColor('charts.blue'));
      case 'leaf': {
        if (label.startsWith('[Problem]')) {
          return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
        }
        if (label.startsWith('[Decision]')) {
          return new vscode.ThemeIcon('milestone', new vscode.ThemeColor('charts.blue'));
        }
        if (label.startsWith('[Episode]')) {
          return new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('charts.orange'));
        }
        if (label.startsWith('[Context]')) {
          return new vscode.ThemeIcon('info', new vscode.ThemeColor('charts.green'));
        }
        return new vscode.ThemeIcon('circle-outline');
      }
      default:
        return new vscode.ThemeIcon('circle-outline');
    }
  }
}

// ------------------------------------------------------------
// Tree Data Provider
// ------------------------------------------------------------

export class MemoryTreeProvider implements vscode.TreeDataProvider<MemoryTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<MemoryTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cortexDir: string | undefined;

  // Debounce rapid refresh calls (e.g. from multiple events firing at once)
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly REFRESH_DEBOUNCE_MS = 300;

  constructor() {
    this.cortexDir = this.resolveCortexDir();
  }

  /** Force a full tree refresh. Debounced to prevent thrashing. */
  refresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.cortexDir = this.resolveCortexDir();
      this._onDidChangeTreeData.fire();
    }, MemoryTreeProvider.REFRESH_DEBOUNCE_MS);
  }

  /** Immediate refresh — bypasses debounce. Use sparingly. */
  refreshNow(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.cortexDir = this.resolveCortexDir();
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this._onDidChangeTreeData.dispose();
  }

  // ----------------------------------------------------------
  // TreeDataProvider implementation
  // ----------------------------------------------------------

  getTreeItem(element: MemoryTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: MemoryTreeItem): Promise<MemoryTreeItem[]> {
    if (!this.cortexDir) {
      return [
        new MemoryTreeItem(
          'No .cortex/ directory found — run Cortex: Init',
          vscode.TreeItemCollapsibleState.None,
          'leaf',
        ),
      ];
    }

    if (!element) {
      return this.getRootItems();
    }

    switch (element.layer) {
      case 'working':
        return this.getWorkingMemoryChildren();
      case 'episodic':
        return this.getEpisodicMemoryChildren();
      case 'decisions':
        return this.getDecisionChildren();
      default:
        return [];
    }
  }

  // ----------------------------------------------------------
  // Root items
  // ----------------------------------------------------------

  private getRootItems(): MemoryTreeItem[] {
    return [
      new MemoryTreeItem(
        'Working Memory (hot)',
        vscode.TreeItemCollapsibleState.Expanded,
        'working',
      ),
      new MemoryTreeItem(
        'Episodic Memory (warm)',
        vscode.TreeItemCollapsibleState.Collapsed,
        'episodic',
      ),
      new MemoryTreeItem(
        'Decisions (auto ADRs)',
        vscode.TreeItemCollapsibleState.Collapsed,
        'decisions',
      ),
    ];
  }

  // ----------------------------------------------------------
  // Working Memory children
  // ----------------------------------------------------------

  private async getWorkingMemoryChildren(): Promise<MemoryTreeItem[]> {
    const filePath = path.join(this.cortexDir!, 'working.md');
    const items: MemoryTreeItem[] = [];

    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const working = this.parseWorkingMemory(raw);

      // Show session summary
      if (working.lastSessionSummary && !working.lastSessionSummary.startsWith('_No ')) {
        const summary =
          working.lastSessionSummary.length > 100
            ? working.lastSessionSummary.slice(0, 97) + '...'
            : working.lastSessionSummary;
        items.push(
          new MemoryTreeItem(summary, vscode.TreeItemCollapsibleState.None, 'leaf', filePath),
        );
      }

      // Show current context
      if (working.currentContext && !working.currentContext.startsWith('_No ')) {
        const ctx = working.currentContext.length > 80
          ? working.currentContext.slice(0, 77) + '...'
          : working.currentContext;
        items.push(
          new MemoryTreeItem(
            `[Context] ${ctx}`,
            vscode.TreeItemCollapsibleState.None,
            'leaf',
            filePath,
          ),
        );
      }

      // Show decisions
      for (const decision of working.recentDecisions) {
        const label = decision.title.length > 70
          ? decision.title.slice(0, 67) + '...'
          : decision.title;
        items.push(
          new MemoryTreeItem(
            `[Decision] ${label}`,
            vscode.TreeItemCollapsibleState.None,
            'leaf',
            filePath,
          ),
        );
      }

      // Show problems
      for (const problem of working.openProblems) {
        const label =
          problem.length > 70 ? problem.slice(0, 67) + '...' : problem;
        items.push(
          new MemoryTreeItem(
            `[Problem] ${label}`,
            vscode.TreeItemCollapsibleState.None,
            'leaf',
            filePath,
          ),
        );
      }

      if (items.length === 0) {
        items.push(
          new MemoryTreeItem(
            'No working memory yet — start a coding session',
            vscode.TreeItemCollapsibleState.None,
            'leaf',
          ),
        );
      }
    } catch {
      items.push(
        new MemoryTreeItem(
          'working.md not found',
          vscode.TreeItemCollapsibleState.None,
          'leaf',
        ),
      );
    }

    return items;
  }

  // ----------------------------------------------------------
  // Episodic Memory children
  // ----------------------------------------------------------

  private async getEpisodicMemoryChildren(): Promise<MemoryTreeItem[]> {
    const episodesDir = path.join(this.cortexDir!, 'episodes');
    const items: MemoryTreeItem[] = [];

    try {
      const entries = await fs.readdir(episodesDir, { withFileTypes: true });
      const mdFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .sort((a, b) => b.name.localeCompare(a.name)); // newest first

      for (const file of mdFiles.slice(0, 20)) { // Limit to 20 most recent
        const filePath = path.join(episodesDir, file.name);
        const episode = await this.parseEpisodeFile(filePath);
        const title = episode?.title || file.name.replace('.md', '');
        const label = title.length > 60 ? title.slice(0, 57) + '...' : title;

        items.push(
          new MemoryTreeItem(
            `[Episode] ${label}`,
            vscode.TreeItemCollapsibleState.None,
            'leaf',
            filePath,
          ),
        );
      }

      if (mdFiles.length > 20) {
        items.push(
          new MemoryTreeItem(
            `... and ${mdFiles.length - 20} more episodes`,
            vscode.TreeItemCollapsibleState.None,
            'leaf',
          ),
        );
      }

      if (items.length === 0) {
        items.push(
          new MemoryTreeItem(
            'No episodes recorded yet',
            vscode.TreeItemCollapsibleState.None,
            'leaf',
          ),
        );
      }
    } catch {
      items.push(
        new MemoryTreeItem(
          'episodes/ directory not found',
          vscode.TreeItemCollapsibleState.None,
          'leaf',
        ),
      );
    }

    return items;
  }

  // ----------------------------------------------------------
  // Decision children
  // ----------------------------------------------------------

  private async getDecisionChildren(): Promise<MemoryTreeItem[]> {
    const filePath = path.join(this.cortexDir!, 'decisions.md');
    const items: MemoryTreeItem[] = [];

    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const decisions = this.parseDecisions(raw);

      for (const decision of decisions) {
        const label = decision.title.length > 60
          ? decision.title.slice(0, 57) + '...'
          : decision.title;
        items.push(
          new MemoryTreeItem(
            `[Decision] ${label}`,
            vscode.TreeItemCollapsibleState.None,
            'leaf',
            filePath,
          ),
        );
      }

      if (items.length === 0) {
        items.push(
          new MemoryTreeItem(
            'No decisions logged yet',
            vscode.TreeItemCollapsibleState.None,
            'leaf',
          ),
        );
      }
    } catch {
      items.push(
        new MemoryTreeItem(
          'decisions.md not found',
          vscode.TreeItemCollapsibleState.None,
          'leaf',
        ),
      );
    }

    return items;
  }

  // ----------------------------------------------------------
  // Parsing helpers
  // ----------------------------------------------------------

  /**
   * Parse working.md into structured data.
   * Matches the format written by MemoryStore.serializeWorkingMemory().
   */
  private parseWorkingMemory(raw: string): {
    lastSessionSummary: string;
    currentContext: string;
    recentDecisions: { title: string }[];
    openProblems: string[];
  } {
    const result = {
      lastSessionSummary: '',
      currentContext: '',
      recentDecisions: [] as { title: string }[],
      openProblems: [] as string[],
    };

    const sections = this.splitByHeadings(raw);

    for (const [heading, body] of sections) {
      const lower = heading.toLowerCase();

      if (lower.includes('last session') || lower === 'last session summary') {
        // Take the FULL body, not just first line
        const cleaned = body.trim();
        if (cleaned && !cleaned.startsWith('_No ')) {
          result.lastSessionSummary = cleaned;
        }
      } else if (lower.includes('current context')) {
        const cleaned = body.trim();
        if (cleaned && !cleaned.startsWith('_No ')) {
          // Flatten bullet points into a single line
          const lines = cleaned.split('\n')
            .map(l => l.replace(/^\s*[-*]\s+/, '').trim())
            .filter(l => l.length > 0);
          result.currentContext = lines.join(' | ');
        }
      } else if (lower.includes('recent decision')) {
        result.recentDecisions = this.extractDecisionBullets(body);
      } else if (lower.includes('open problem')) {
        result.openProblems = this.extractListItems(body);
      }
    }

    return result;
  }

  /**
   * Parse decisions.md — only count actual ADR entries, not sub-headings.
   */
  private parseDecisions(raw: string): { title: string; id: string }[] {
    const decisions: { title: string; id: string }[] = [];

    // Primary: match ADR-style headings "## ADR: <title>"
    const adrRe = /^## ADR:\s+(.+)$/gm;
    let match: RegExpExecArray | null;
    let idx = 0;
    while ((match = adrRe.exec(raw)) !== null) {
      decisions.push({ id: String(idx++), title: match[1].trim() });
    }

    if (decisions.length > 0) return decisions;

    // Fallback: match ## headings that aren't meta/sub-section headings
    const skipPatterns = /^(?:decision log|decisions|architectural|context|reason|alternatives|files affected|placeholder)\b/i;
    const headingRe = /^##\s+(.+)$/gm;
    while ((match = headingRe.exec(raw)) !== null) {
      const title = match[1].trim();
      if (!skipPatterns.test(title)) {
        decisions.push({ id: String(idx++), title });
      }
    }

    if (decisions.length > 0) return decisions;

    // Last resort: bullet items (for simple decision lists)
    const items = this.extractListItems(raw)
      .filter(item => !item.startsWith('_'));  // Skip placeholder text
    for (const item of items) {
      decisions.push({ id: String(idx++), title: item });
    }

    return decisions;
  }

  private async parseEpisodeFile(filePath: string): Promise<{ title: string } | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');

      // YAML frontmatter title
      const fmTitle = raw.match(/^title:\s*"?([^"\n]*)"?/m);
      if (fmTitle) {
        return { title: fmTitle[1].trim() };
      }

      // First # heading
      const headingMatch = raw.match(/^#\s+(.+)$/m);
      if (headingMatch) {
        return { title: headingMatch[1].trim() };
      }

      // First non-empty, non-frontmatter line
      const body = raw.replace(/^---[\s\S]*?---\n?/, '');
      const firstLine = body.split('\n').find((l) => l.trim().length > 0);
      if (firstLine) {
        return { title: firstLine.trim().slice(0, 60) };
      }
    } catch {
      // ignore
    }
    return null;
  }

  // ----------------------------------------------------------
  // Utility
  // ----------------------------------------------------------

  private resolveCortexDir(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    return path.join(folders[0].uri.fsPath, '.cortex');
  }

  private splitByHeadings(md: string): [string, string][] {
    const lines = md.split('\n');
    const sections: [string, string][] = [];
    let currentHeading = '';
    let currentBody: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
      if (headingMatch) {
        if (currentHeading) {
          sections.push([currentHeading, currentBody.join('\n')]);
        }
        currentHeading = headingMatch[1].trim();
        currentBody = [];
      } else {
        currentBody.push(line);
      }
    }
    if (currentHeading) {
      sections.push([currentHeading, currentBody.join('\n')]);
    }

    return sections;
  }

  private extractListItems(text: string): string[] {
    const items: string[] = [];
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*[-*]\s+(.+)$/);
      if (match) {
        items.push(match[1].trim());
      }
    }
    return items;
  }

  /**
   * Extract decisions from working.md bullet format:
   * "- **Title**: Decision text _(reason)_"
   */
  private extractDecisionBullets(text: string): { title: string }[] {
    const items: { title: string }[] = [];
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*[-*]\s+\*\*(.+?)\*\*/);
      if (match) {
        items.push({ title: match[1].trim() });
      } else {
        // Plain bullet
        const plain = line.match(/^\s*[-*]\s+(.+)$/);
        if (plain && !plain[1].startsWith('_')) {
          items.push({ title: plain[1].trim() });
        }
      }
    }
    return items;
  }
}
