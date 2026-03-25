// ============================================================
// CORTEX - Core Memory Store
// 3-Layer Memory Management System
//
// Layer 1: Working Memory (hot)  - always injected, ~800 tokens
// Layer 2: Episodic Memory (warm) - session histories, contextual
// Layer 3: Semantic Memory (cold) - knowledge graph, queryable
// ============================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  WorkingMemory,
  EpisodicMemory,
  DecisionEntry,
  MemoryEntry,
  MemoryHealth,
  ExtractionResult,
  StaleWarning,
} from '../../types/index.js';

// Approximate token count: ~4 characters per token.
const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 800;

/**
 * Core 3-layer memory management for the Cortex system.
 *
 * All persistence is file-based inside the `.cortex/` directory:
 * - `.cortex/working.md`       -- Layer 1 working memory
 * - `.cortex/episodes/`        -- Layer 2 episodic memory (one .md per episode)
 * - `.cortex/decisions.md`     -- Layer 2 architectural decisions (ADR format)
 */
export class MemoryStore {
  private readonly cortexDir: string;
  private readonly workingPath: string;
  private readonly episodesDir: string;
  private readonly decisionsPath: string;
  private readonly maxTokens: number;

  constructor(projectPath: string, maxTokens: number = DEFAULT_MAX_TOKENS) {
    this.cortexDir = path.join(projectPath, '.cortex');
    this.workingPath = path.join(this.cortexDir, 'working.md');
    this.episodesDir = path.join(this.cortexDir, 'episodes');
    this.decisionsPath = path.join(this.cortexDir, 'decisions.md');
    this.maxTokens = maxTokens;
  }

  // ================================================================
  // Layer 1 -- Working Memory (hot)
  // ================================================================

  /**
   * Read the current working memory from `.cortex/working.md`.
   * Returns sensible defaults when the file does not yet exist.
   */
  async getWorkingMemory(): Promise<WorkingMemory> {
    try {
      const raw = await fs.readFile(this.workingPath, 'utf-8');
      return this.parseWorkingMemory(raw);
    } catch {
      return this.defaultWorkingMemory();
    }
  }

  /**
   * Merge an extraction result into the current working memory and persist.
   * Prunes oldest items when the token budget is exceeded.
   */
  async updateWorkingMemory(
    extraction: ExtractionResult,
    sessionId: string,
  ): Promise<void> {
    await this.ensureDir(this.cortexDir);

    const current = await this.getWorkingMemory();

    // Merge summary -- latest extraction wins, but preserve prior context.
    current.lastSessionSummary = extraction.summary;
    current.currentContext = extraction.nextSteps.length > 0
      ? extraction.nextSteps.join('; ')
      : current.currentContext;

    // Merge open problems (deduplicate, newest first).
    const problemSet = new Set<string>([
      ...extraction.openProblems,
      ...current.openProblems,
    ]);
    current.openProblems = Array.from(problemSet);

    // Merge decisions (newest first, deduplicate by title).
    const newDecisions: DecisionEntry[] = extraction.decisions.map((d) => ({
      ...d,
      id: this.generateId(),
      sessionId,
    }));
    const seenTitles = new Set<string>();
    const mergedDecisions: DecisionEntry[] = [];
    for (const dec of [...newDecisions, ...current.recentDecisions]) {
      if (!seenTitles.has(dec.title)) {
        seenTitles.add(dec.title);
        mergedDecisions.push(dec);
      }
    }
    current.recentDecisions = mergedDecisions;

    // Update timestamp.
    current.updatedAt = new Date().toISOString();

    // Prune to stay within token budget.
    this.pruneWorkingMemory(current);

    // Persist.
    const md = this.serializeWorkingMemory(current);
    await fs.writeFile(this.workingPath, md, 'utf-8');
  }

  // ================================================================
  // Layer 2 -- Episodic Memory (warm)
  // ================================================================

  /**
   * Persist a new episode as an individual `.md` file inside `.cortex/episodes/`.
   * Filename: `YYYY-MM-DD-<slugified-title>.md`
   */
  async addEpisode(episode: EpisodicMemory): Promise<void> {
    await this.ensureDir(this.episodesDir);

    const datePrefix = episode.timestamp.slice(0, 10); // YYYY-MM-DD
    const slug = this.slugify(episode.title);
    const filename = `${datePrefix}-${slug}.md`;
    const filePath = path.join(this.episodesDir, filename);

    const md = this.serializeEpisode(episode);
    await fs.writeFile(filePath, md, 'utf-8');
  }

  /**
   * Retrieve the most recent episodes, sorted newest-first.
   */
  async getEpisodes(limit?: number): Promise<EpisodicMemory[]> {
    try {
      const files = await fs.readdir(this.episodesDir);
      const mdFiles = files
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse();

      const selected = limit ? mdFiles.slice(0, limit) : mdFiles;
      const episodes: EpisodicMemory[] = [];

      for (const file of selected) {
        try {
          const raw = await fs.readFile(path.join(this.episodesDir, file), 'utf-8');
          episodes.push(this.parseEpisode(raw));
        } catch {
          // Skip unparseable episode files.
        }
      }

      return episodes;
    } catch {
      return [];
    }
  }

  /**
   * Return episodes whose `filesAffected` overlap with the given file list.
   */
  async getRelevantEpisodes(changedFiles: string[]): Promise<EpisodicMemory[]> {
    const all = await this.getEpisodes();
    if (changedFiles.length === 0) {
      return [];
    }

    const changedSet = new Set(changedFiles.map((f) => this.normalizePath(f)));

    return all.filter((ep) =>
      ep.filesAffected.some((f) => changedSet.has(this.normalizePath(f))),
    );
  }

  // ================================================================
  // Decisions (part of Layer 2)
  // ================================================================

  /**
   * Append an architectural decision to `.cortex/decisions.md` in ADR format.
   */
  async addDecision(decision: DecisionEntry): Promise<void> {
    await this.ensureDir(this.cortexDir);

    const entry = this.serializeDecision(decision);

    try {
      await fs.access(this.decisionsPath);
      await fs.appendFile(this.decisionsPath, `\n${entry}`, 'utf-8');
    } catch {
      // File does not exist yet -- create with header.
      const header = '# Architectural Decision Records\n\n'
        + 'This file is managed by Cortex. Each entry captures a key project decision.\n';
      await fs.writeFile(this.decisionsPath, `${header}\n${entry}`, 'utf-8');
    }
  }

  /**
   * Read all decisions from `.cortex/decisions.md`.
   */
  async getDecisions(): Promise<DecisionEntry[]> {
    try {
      const raw = await fs.readFile(this.decisionsPath, 'utf-8');
      return this.parseDecisions(raw);
    } catch {
      return [];
    }
  }

  // ================================================================
  // Layer 3 -- Semantic Memory (cold) -- stubs
  // ================================================================

  /**
   * Search across all memory layers using text matching.
   * Falls back to substring search until vector embeddings are implemented.
   */
  async search(query: string): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];
    const term = query.toLowerCase();

    // Search working memory
    try {
      const raw = await fs.readFile(this.workingPath, 'utf-8');
      if (raw.toLowerCase().includes(term)) {
        results.push({
          id: 'working-memory',
          layer: 'working',
          summary: 'Working Memory',
          content: raw,
          tags: ['working-memory'],
          createdAt: '',
          updatedAt: '',
          sessionId: '',
          status: 'active',
        });
      }
    } catch { /* file may not exist */ }

    // Search decisions
    try {
      const decisions = await this.getDecisions();
      for (const d of decisions) {
        const text = `${d.title} ${d.decision} ${d.context} ${d.reason}`.toLowerCase();
        if (text.includes(term)) {
          results.push({
            id: d.id,
            layer: 'semantic',
            summary: `Decision: ${d.title}`,
            content: `${d.decision}\nReason: ${d.reason}`,
            tags: ['decision', ...d.filesAffected],
            createdAt: d.timestamp,
            updatedAt: d.timestamp,
            sessionId: d.sessionId,
            status: 'active',
          });
        }
      }
    } catch { /* file may not exist */ }

    // Search episodes
    try {
      const episodes = await this.getEpisodes();
      for (const ep of episodes) {
        const text = `${ep.title} ${ep.summary}`.toLowerCase();
        if (text.includes(term)) {
          results.push({
            id: ep.id,
            layer: 'episodic',
            summary: ep.title,
            content: ep.summary,
            tags: ep.filesAffected,
            createdAt: ep.timestamp,
            updatedAt: ep.timestamp,
            sessionId: ep.sessionId,
            status: 'active',
          });
        }
      }
    } catch { /* dir may not exist */ }

    return results;
  }

  /**
   * Add an entry to the semantic knowledge graph.
   * TODO: Implement graph persistence and embedding generation.
   */
  async addToGraph(_entry: MemoryEntry): Promise<void> {
    // TODO: Persist entry to the knowledge graph and generate
    // embeddings for semantic retrieval.
  }

  // ================================================================
  // Health
  // ================================================================

  /**
   * Calculate a health score (0-100) for the project memory.
   * Factors: recency of updates, coverage (episodes + decisions), staleness.
   */
  async getHealth(): Promise<MemoryHealth> {
    const working = await this.getWorkingMemory();
    const episodes = await this.getEpisodes();
    const decisions = await this.getDecisions();

    const now = Date.now();
    const staleWarnings: StaleWarning[] = [];

    // --- Recency score (0-40) ---
    let recencyScore = 0;
    if (working.updatedAt) {
      const ageMs = now - new Date(working.updatedAt).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);
      if (ageHours < 1) recencyScore = 40;
      else if (ageHours < 24) recencyScore = 30;
      else if (ageHours < 72) recencyScore = 20;
      else if (ageHours < 168) recencyScore = 10;
      else {
        recencyScore = 0;
        staleWarnings.push({
          module: 'working-memory',
          lastMemoryUpdate: working.updatedAt,
          recentFileChanges: 0,
          message: `Working memory has not been updated for ${Math.round(ageHours / 24)} days.`,
        });
      }
    }

    // --- Coverage score (0-40) ---
    let coverageScore = 0;
    // Episodes contribute up to 20 points.
    coverageScore += Math.min(episodes.length * 4, 20);
    // Decisions contribute up to 20 points.
    coverageScore += Math.min(decisions.length * 5, 20);

    // --- Freshness score (0-20) ---
    let freshnessScore = 20;
    if (episodes.length > 0) {
      const latestEpisode = episodes[0]; // already sorted newest-first
      const epAgeMs = now - new Date(latestEpisode.timestamp).getTime();
      const epAgeDays = epAgeMs / (1000 * 60 * 60 * 24);
      if (epAgeDays > 7) {
        freshnessScore = 10;
        staleWarnings.push({
          module: 'episodic-memory',
          lastMemoryUpdate: latestEpisode.timestamp,
          recentFileChanges: 0,
          message: `No new episodes recorded in ${Math.round(epAgeDays)} days.`,
        });
      }
      if (epAgeDays > 30) {
        freshnessScore = 0;
      }
    } else {
      freshnessScore = 0;
    }

    const score = Math.min(100, recencyScore + coverageScore + freshnessScore);

    // Derive project name from the cortex directory path.
    const projectName = path.basename(path.dirname(this.cortexDir));

    return {
      score,
      projectName,
      lastUpdated: working.updatedAt || new Date().toISOString(),
      workingMemoryTokens: working.tokenCount,
      episodeCount: episodes.length,
      decisionCount: decisions.length,
      staleWarnings,
    };
  }

  // ================================================================
  // Private helpers -- Working Memory serialization
  // ================================================================

  private defaultWorkingMemory(): WorkingMemory {
    return {
      lastSessionSummary: '',
      recentDecisions: [],
      currentContext: '',
      openProblems: [],
      updatedAt: '',
      tokenCount: 0,
    };
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Drop the oldest open problems and decisions until we fit within budget.
   */
  private pruneWorkingMemory(wm: WorkingMemory): void {
    const maxChars = this.maxTokens * CHARS_PER_TOKEN;

    const serialize = () => this.serializeWorkingMemory(wm);

    // Prune open problems from the end (oldest) first.
    while (serialize().length > maxChars && wm.openProblems.length > 1) {
      wm.openProblems.pop();
    }

    // Prune decisions from the end (oldest) first.
    while (serialize().length > maxChars && wm.recentDecisions.length > 1) {
      wm.recentDecisions.pop();
    }

    // If still over, truncate the summary.
    if (serialize().length > maxChars) {
      const overBy = serialize().length - maxChars;
      if (wm.lastSessionSummary.length > overBy + 50) {
        wm.lastSessionSummary =
          wm.lastSessionSummary.slice(0, wm.lastSessionSummary.length - overBy - 3) + '...';
      }
    }

    wm.tokenCount = this.estimateTokens(serialize());
  }

  private serializeWorkingMemory(wm: WorkingMemory): string {
    const lines: string[] = [];

    lines.push('# Working Memory');
    lines.push('');
    lines.push(`> Last updated: ${wm.updatedAt || 'never'}`);
    lines.push('');

    lines.push('## Last Session');
    lines.push('');
    lines.push(wm.lastSessionSummary || '_No sessions recorded yet._');
    lines.push('');

    if (wm.currentContext) {
      lines.push('## Current Context');
      lines.push('');
      lines.push(wm.currentContext);
      lines.push('');
    }

    if (wm.recentDecisions.length > 0) {
      lines.push('## Recent Decisions');
      lines.push('');
      for (const d of wm.recentDecisions) {
        lines.push(`- **${d.title}**: ${d.decision} _(${d.reason})_`);
      }
      lines.push('');
    }

    if (wm.openProblems.length > 0) {
      lines.push('## Open Problems');
      lines.push('');
      for (const p of wm.openProblems) {
        lines.push(`- ${p}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private parseWorkingMemory(raw: string): WorkingMemory {
    const wm = this.defaultWorkingMemory();

    // Extract updated timestamp from the blockquote.
    const tsMatch = raw.match(/Last updated:\s*(.+)/);
    if (tsMatch) {
      const ts = tsMatch[1].trim();
      if (ts !== 'never') {
        wm.updatedAt = ts;
      }
    }

    // Extract section contents by heading.
    const sections = this.extractSections(raw);

    wm.lastSessionSummary = sections['Last Session']?.trim()
      || sections['Last Session Summary']?.trim()
      || '';
    if (wm.lastSessionSummary.startsWith('_No ')) {
      wm.lastSessionSummary = '';
    }

    wm.currentContext = sections['Current Context']?.trim() || '';

    // Parse Recent Decisions as bullet points.
    const decSection = sections['Recent Decisions'] || '';
    const decLines = decSection.split('\n').filter((l) => l.startsWith('- '));
    wm.recentDecisions = decLines.map((line) => {
      const titleMatch = line.match(/\*\*(.+?)\*\*:\s*(.+?)(?:\s*_\((.+?)\)_)?$/);
      return {
        id: this.generateId(),
        title: titleMatch?.[1] || line.slice(2),
        decision: titleMatch?.[2]?.trim() || '',
        context: '',
        alternatives: [],
        reason: titleMatch?.[3] || '',
        filesAffected: [],
        timestamp: wm.updatedAt || '',
        sessionId: '',
      };
    });

    // Parse Open Problems as bullet points.
    const probSection = sections['Open Problems'] || '';
    wm.openProblems = probSection
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim());

    wm.tokenCount = this.estimateTokens(raw);

    return wm;
  }

  // ================================================================
  // Private helpers -- Episodic Memory serialization
  // ================================================================

  private serializeEpisode(ep: EpisodicMemory): string {
    const lines: string[] = [];

    // YAML frontmatter.
    lines.push('---');
    lines.push(`id: ${ep.id}`);
    lines.push(`sessionId: ${ep.sessionId}`);
    lines.push(`title: "${this.escapeYaml(ep.title)}"`);
    lines.push(`timestamp: ${ep.timestamp}`);
    if (ep.duration !== undefined) {
      lines.push(`duration: ${ep.duration}`);
    }
    if (ep.filesAffected.length > 0) {
      lines.push('filesAffected:');
      for (const f of ep.filesAffected) {
        lines.push(`  - ${f}`);
      }
    }
    lines.push('---');
    lines.push('');

    // Body.
    lines.push(`# ${ep.title}`);
    lines.push('');
    lines.push(ep.summary);
    lines.push('');

    if (ep.decisions.length > 0) {
      lines.push('## Decisions');
      lines.push('');
      for (const d of ep.decisions) {
        lines.push(`### ${d.title}`);
        lines.push('');
        lines.push(d.decision);
        if (d.reason) {
          lines.push('');
          lines.push(`**Reason:** ${d.reason}`);
        }
        if (d.alternatives.length > 0) {
          lines.push('');
          lines.push('**Alternatives considered:**');
          for (const alt of d.alternatives) {
            lines.push(`- ${alt}`);
          }
        }
        lines.push('');
      }
    }

    if (ep.patterns.length > 0) {
      lines.push('## Patterns');
      lines.push('');
      for (const p of ep.patterns) {
        lines.push(`- **${p.type}**: ${p.description} (seen ${p.occurrences}x)`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private parseEpisode(raw: string): EpisodicMemory {
    const frontmatter = this.extractFrontmatter(raw);
    const body = this.extractBody(raw);

    // Parse filesAffected from frontmatter lines.
    const filesAffected: string[] = [];
    const faMatch = frontmatter.match(/filesAffected:\n((?:\s+-\s+.+\n?)*)/);
    if (faMatch) {
      const faLines = faMatch[1].split('\n').filter((l) => l.trim().startsWith('-'));
      for (const l of faLines) {
        filesAffected.push(l.replace(/^\s*-\s*/, '').trim());
      }
    }

    const getValue = (key: string): string => {
      const match = frontmatter.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?`, 'm'));
      return match?.[1]?.trim() || '';
    };

    // Extract summary: the first paragraph after the title heading.
    const bodyLines = body.split('\n');
    let summary = '';
    let pastTitle = false;
    for (const line of bodyLines) {
      if (line.startsWith('# ')) {
        pastTitle = true;
        continue;
      }
      if (pastTitle && line.startsWith('## ')) break;
      if (pastTitle && line.trim()) {
        summary += (summary ? '\n' : '') + line;
      }
    }

    return {
      id: getValue('id') || this.generateId(),
      sessionId: getValue('sessionId'),
      title: getValue('title'),
      summary,
      decisions: [], // Full decision re-parsing is deferred to avoid fragility.
      patterns: [],
      filesAffected,
      timestamp: getValue('timestamp'),
      duration: getValue('duration') ? parseInt(getValue('duration'), 10) : undefined,
    };
  }

  // ================================================================
  // Private helpers -- Decision serialization (ADR format)
  // ================================================================

  private serializeDecision(d: DecisionEntry): string {
    const lines: string[] = [];

    lines.push(`## ADR: ${d.title}`);
    lines.push('');
    lines.push(`**Date:** ${d.timestamp.slice(0, 10)}`);
    lines.push(`**Status:** Accepted`);
    lines.push(`**Session:** ${d.sessionId}`);
    lines.push('');
    lines.push('### Context');
    lines.push('');
    lines.push(d.context || '_No additional context._');
    lines.push('');
    lines.push('### Decision');
    lines.push('');
    lines.push(d.decision);
    lines.push('');
    lines.push('### Reason');
    lines.push('');
    lines.push(d.reason || '_Not specified._');
    lines.push('');

    if (d.alternatives.length > 0) {
      lines.push('### Alternatives Considered');
      lines.push('');
      for (const alt of d.alternatives) {
        lines.push(`- ${alt}`);
      }
      lines.push('');
    }

    if (d.filesAffected.length > 0) {
      lines.push('### Files Affected');
      lines.push('');
      for (const f of d.filesAffected) {
        lines.push(`- \`${f}\``);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');

    return lines.join('\n');
  }

  private parseDecisions(raw: string): DecisionEntry[] {
    const decisions: DecisionEntry[] = [];

    // Split on ADR headings.
    const adrBlocks = raw.split(/^## ADR:\s*/m).slice(1);

    for (const block of adrBlocks) {
      const titleLine = block.split('\n')[0]?.trim() || '';
      const sections = this.extractSections('## Placeholder\n' + block);

      const dateMatch = block.match(/\*\*Date:\*\*\s*(\S+)/);
      const sessionMatch = block.match(/\*\*Session:\*\*\s*(\S+)/);

      const altSection = sections['Alternatives Considered'] || '';
      const alternatives = altSection
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => l.slice(2).trim());

      const filesSection = sections['Files Affected'] || '';
      const filesAffected = filesSection
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => l.replace(/^-\s*`?/, '').replace(/`$/, '').trim());

      decisions.push({
        id: this.generateId(),
        title: titleLine,
        context: sections['Context']?.trim() || '',
        decision: sections['Decision']?.trim() || '',
        alternatives,
        reason: sections['Reason']?.trim() || '',
        filesAffected,
        timestamp: dateMatch?.[1] || '',
        sessionId: sessionMatch?.[1] || '',
      });
    }

    return decisions;
  }

  // ================================================================
  // Private helpers -- generic utilities
  // ================================================================

  /**
   * Extract markdown sections keyed by heading text.
   * Supports ## and ### headings.
   */
  private extractSections(raw: string): Record<string, string> {
    const sections: Record<string, string> = {};
    const lines = raw.split('\n');
    let currentHeading = '';
    let currentContent: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^#{2,3}\s+(.+)/);
      if (headingMatch) {
        if (currentHeading) {
          sections[currentHeading] = currentContent.join('\n');
        }
        currentHeading = headingMatch[1].trim();
        currentContent = [];
      } else if (currentHeading) {
        currentContent.push(line);
      }
    }

    if (currentHeading) {
      sections[currentHeading] = currentContent.join('\n');
    }

    return sections;
  }

  private extractFrontmatter(raw: string): string {
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    return match?.[1] || '';
  }

  private extractBody(raw: string): string {
    const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    return match?.[1] || raw;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  private escapeYaml(text: string): string {
    return text.replace(/"/g, '\\"');
  }

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 8);
    return `${timestamp}-${random}`;
  }

  private async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }
}
