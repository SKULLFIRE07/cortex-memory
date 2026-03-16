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

  constructor() {
    this.cortexDir = this.resolveCortexDir();
  }

  /** Force a full tree refresh. */
  refresh(): void {
    this.cortexDir = this.resolveCortexDir();
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
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
          'No .cortex/ directory found',
          vscode.TreeItemCollapsibleState.None,
          'leaf',
        ),
      ];
    }

    // Top-level categories
    if (!element) {
      return this.getRootItems();
    }

    // Children per category
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

      if (working.lastSessionSummary) {
        const summary =
          working.lastSessionSummary.length > 80
            ? working.lastSessionSummary.slice(0, 77) + '...'
            : working.lastSessionSummary;
        items.push(
          new MemoryTreeItem(summary, vscode.TreeItemCollapsibleState.None, 'leaf', filePath),
        );
      }

      for (const decision of working.recentDecisions) {
        items.push(
          new MemoryTreeItem(
            `[Decision] ${decision.title}`,
            vscode.TreeItemCollapsibleState.None,
            'leaf',
            filePath,
          ),
        );
      }

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
            'No working memory yet',
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

      for (const file of mdFiles) {
        const filePath = path.join(episodesDir, file.name);
        const episode = await this.parseEpisodeFile(filePath);
        const label = episode
          ? `[Episode] ${episode.title}`
          : `[Episode] ${file.name.replace('.md', '')}`;

        items.push(
          new MemoryTreeItem(
            label,
            vscode.TreeItemCollapsibleState.None,
            'leaf',
            filePath,
          ),
        );
      }

      if (items.length === 0) {
        items.push(
          new MemoryTreeItem(
            'No episodes recorded',
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
        items.push(
          new MemoryTreeItem(
            `[Decision] ${decision.title}`,
            vscode.TreeItemCollapsibleState.None,
            'leaf',
            filePath,
          ),
        );
      }

      if (items.length === 0) {
        items.push(
          new MemoryTreeItem(
            'No decisions logged',
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
   * Best-effort parse of working.md.
   * Expects a markdown file with YAML-like front matter or structured headings.
   * Falls back gracefully if the format is unexpected.
   */
  private parseWorkingMemory(raw: string): Pick<WorkingMemory, 'lastSessionSummary' | 'recentDecisions' | 'openProblems'> {
    const result: Pick<WorkingMemory, 'lastSessionSummary' | 'recentDecisions' | 'openProblems'> = {
      lastSessionSummary: '',
      recentDecisions: [],
      openProblems: [],
    };

    // Try JSON front-matter between --- fences first
    const jsonMatch = raw.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]) as Partial<WorkingMemory>;
        result.lastSessionSummary = parsed.lastSessionSummary ?? '';
        result.recentDecisions = parsed.recentDecisions ?? [];
        result.openProblems = parsed.openProblems ?? [];
        return result;
      } catch {
        // fall through to heading-based parsing
      }
    }

    // Heading-based parsing
    const sections = this.splitByHeadings(raw);

    for (const [heading, body] of sections) {
      const lower = heading.toLowerCase();
      if (lower.includes('summary') || lower.includes('session')) {
        result.lastSessionSummary = body.trim().split('\n')[0] ?? '';
      } else if (lower.includes('decision')) {
        result.recentDecisions = this.extractListAsDecisions(body);
      } else if (lower.includes('problem') || lower.includes('open')) {
        result.openProblems = this.extractListItems(body);
      }
    }

    return result;
  }

  private parseDecisions(raw: string): Pick<DecisionEntry, 'title' | 'id'>[] {
    const decisions: Pick<DecisionEntry, 'title' | 'id'>[] = [];

    // Try JSON block
    const jsonMatch = raw.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed)) {
          return parsed.map((d: Partial<DecisionEntry>) => ({
            id: d.id ?? '',
            title: d.title ?? d.decision ?? 'Untitled',
          }));
        }
      } catch {
        // fall through
      }
    }

    // Heading-based: each ## or ### is a decision
    const headingRe = /^#{2,3}\s+(.+)$/gm;
    let match: RegExpExecArray | null;
    let idx = 0;
    while ((match = headingRe.exec(raw)) !== null) {
      decisions.push({ id: String(idx++), title: match[1].trim() });
    }

    // Fallback: list items starting with -
    if (decisions.length === 0) {
      const items = this.extractListItems(raw);
      for (const item of items) {
        decisions.push({ id: String(idx++), title: item });
      }
    }

    return decisions;
  }

  private async parseEpisodeFile(filePath: string): Promise<{ title: string } | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');

      // Try first heading
      const headingMatch = raw.match(/^#\s+(.+)$/m);
      if (headingMatch) {
        return { title: headingMatch[1].trim() };
      }

      // Try JSON block
      const jsonMatch = raw.match(/```json\s*\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1]) as Partial<EpisodicMemory>;
          if (parsed.title) {
            return { title: parsed.title };
          }
        } catch {
          // ignore
        }
      }

      // First non-empty line
      const firstLine = raw.split('\n').find((l) => l.trim().length > 0);
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

  private extractListAsDecisions(text: string): DecisionEntry[] {
    return this.extractListItems(text).map((item, idx) => ({
      id: String(idx),
      title: item,
      context: '',
      decision: item,
      alternatives: [],
      reason: '',
      filesAffected: [],
      timestamp: '',
      sessionId: '',
    }));
  }
}
