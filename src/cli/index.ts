#!/usr/bin/env node

// ============================================================
// CORTEX CLI - Project Memory OS for AI Coding Assistants
// ============================================================

import { Command } from 'commander';
import { readFile, writeFile, mkdir, readdir, stat, access } from 'fs/promises';
import { join, basename, resolve } from 'path';
import type {
  CortexConfig,
  WorkingMemory,
  EpisodicMemory,
  DecisionEntry,
  MemoryHealth,
  StaleWarning,
} from '../types/index';

// ── ANSI Color Helpers ──────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgRed: '\x1b[41m',
} as const;

function green(text: string): string {
  return `${ANSI.green}${text}${ANSI.reset}`;
}
function yellow(text: string): string {
  return `${ANSI.yellow}${text}${ANSI.reset}`;
}
function red(text: string): string {
  return `${ANSI.red}${text}${ANSI.reset}`;
}
function cyan(text: string): string {
  return `${ANSI.cyan}${text}${ANSI.reset}`;
}
function bold(text: string): string {
  return `${ANSI.bold}${text}${ANSI.reset}`;
}
function dim(text: string): string {
  return `${ANSI.dim}${text}${ANSI.reset}`;
}

// ── Box Drawing ─────────────────────────────────────────────

const BOX = {
  topLeft: '\u250c',
  topRight: '\u2510',
  bottomLeft: '\u2514',
  bottomRight: '\u2518',
  horizontal: '\u2500',
  vertical: '\u2502',
  teeRight: '\u251c',
  teeLeft: '\u2524',
} as const;

function boxLine(width: number): string {
  return BOX.horizontal.repeat(width);
}

function boxTop(width: number): string {
  return `${BOX.topLeft}${boxLine(width)}${BOX.topRight}`;
}

function boxBottom(width: number): string {
  return `${BOX.bottomLeft}${boxLine(width)}${BOX.bottomRight}`;
}

function boxRow(content: string, width: number): string {
  const stripped = stripAnsi(content);
  const padding = Math.max(0, width - stripped.length);
  return `${BOX.vertical} ${content}${' '.repeat(padding)}${BOX.vertical}`;
}

function boxDivider(width: number): string {
  return `${BOX.teeRight}${boxLine(width)}${BOX.teeLeft}`;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ── Path Helpers ────────────────────────────────────────────

function getCortexDir(cwd?: string): string {
  return join(cwd ?? process.cwd(), '.cortex');
}

function getCortexPath(file: string, cwd?: string): string {
  return join(getCortexDir(cwd), file);
}

async function cortexDirExists(cwd?: string): Promise<boolean> {
  try {
    await access(getCortexDir(cwd));
    return true;
  } catch {
    return false;
  }
}

async function requireCortexDir(cwd?: string): Promise<void> {
  if (!(await cortexDirExists(cwd))) {
    console.error(
      red('Error: .cortex/ directory not found. Run `cortex init` first.')
    );
    process.exit(1);
  }
}

// ── Time Helpers ────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;

  if (isNaN(then)) return 'unknown';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// ── Token Estimation ────────────────────────────────────────

function estimateTokens(text: string): number {
  // Rough estimation: ~4 characters per token for English text
  return Math.ceil(text.length / 4);
}

// ── File Helpers ────────────────────────────────────────────

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ============================================================
// COMMAND: init
// ============================================================

async function handleInit(options: { hooks?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const cortexDir = getCortexDir(cwd);
  const projectName = basename(cwd);

  if (await cortexDirExists(cwd)) {
    console.log(yellow('Warning: .cortex/ directory already exists.'));
    console.log(dim('  Use --force to reinitialize (not yet supported).'));
    return;
  }

  console.log(bold('\n  Initializing Cortex...\n'));

  // Create directory structure
  await mkdir(join(cortexDir, 'episodes'), { recursive: true });

  // Create working.md
  const workingMd = `# Working Memory

## Last Session Summary
_No sessions recorded yet. Start coding and Cortex will capture context automatically._

## Current Context
- Project: ${projectName}
- Status: Freshly initialized

## Open Problems
_None yet._

## Recent Decisions
_None yet._

---
_Updated: ${new Date().toISOString()}_
`;
  await writeFile(getCortexPath('working.md', cwd), workingMd, 'utf-8');

  // Create decisions.md
  const decisionsMd = `# Decision Log

> All architectural and design decisions are recorded here automatically.
> Each entry includes context, alternatives considered, and rationale.

---

_No decisions recorded yet._
`;
  await writeFile(getCortexPath('decisions.md', cwd), decisionsMd, 'utf-8');

  // Create config.json
  const config: CortexConfig = {
    version: '0.1.0',
    projectName,
    projectPath: cwd,
    createdAt: new Date().toISOString(),
    maxWorkingMemoryTokens: 800,
    autoInject: true,
    extractionModel: 'claude-haiku-4-5-20251001',
    teamSyncEnabled: false,
    ignorePaths: [
      'node_modules',
      '.git',
      'dist',
      'build',
      '.next',
      'coverage',
    ],
  };
  await writeFile(
    getCortexPath('config.json', cwd),
    JSON.stringify(config, null, 2),
    'utf-8'
  );

  console.log(green('  + .cortex/working.md'));
  console.log(green('  + .cortex/decisions.md'));
  console.log(green('  + .cortex/config.json'));
  console.log(green('  + .cortex/episodes/'));

  // Install hooks if requested
  if (options.hooks) {
    try {
      const { HooksManager } = await import('../engine/hooks/hooksManager.js');
      const manager = new HooksManager(cwd);
      await manager.installHooks();
      console.log(green('  + Claude Code hooks installed'));
    } catch {
      console.log(
        yellow('  ~ Claude Code hooks skipped (engine not available)')
      );
    }
  }

  // Print success
  const width = 52;
  console.log('');
  console.log(green(boxTop(width)));
  console.log(green(boxRow(bold('Cortex initialized successfully!'), width)));
  console.log(green(boxDivider(width)));
  console.log(green(boxRow('', width)));
  console.log(green(boxRow('Next steps:', width)));
  console.log(green(boxRow(`  1. Start a Claude Code session`, width)));
  console.log(green(boxRow(`  2. Cortex captures context automatically`, width)));
  console.log(green(boxRow(`  3. Run ${cyan('cortex status')} to check health`, width)));
  console.log(green(boxRow('', width)));
  console.log(green(boxRow(dim('Add .cortex/ to .gitignore for solo use,'), width)));
  console.log(green(boxRow(dim('or commit it for team-shared memory.'), width)));
  console.log(green(boxRow('', width)));
  console.log(green(boxBottom(width)));
  console.log('');
}

// ============================================================
// COMMAND: status
// ============================================================

async function handleStatus(): Promise<void> {
  const cwd = process.cwd();
  await requireCortexDir(cwd);

  const config = await readJsonFile<CortexConfig>(
    getCortexPath('config.json', cwd)
  );
  const workingMd = await readTextFile(getCortexPath('working.md', cwd));
  const decisionsMd = await readTextFile(getCortexPath('decisions.md', cwd));

  // Count episodes
  let episodeCount = 0;
  try {
    const episodeFiles = await readdir(getCortexPath('episodes', cwd));
    episodeCount = episodeFiles.filter(
      (f) => f.endsWith('.md') || f.endsWith('.json')
    ).length;
  } catch {
    // episodes dir might not exist yet
  }

  // Count decisions
  let decisionCount = 0;
  if (decisionsMd) {
    // Count decision entries by looking for ## headings (excluding the main header)
    const headings = decisionsMd.match(/^## (?!Decision Log).+/gm);
    decisionCount = headings ? headings.length : 0;
  }

  // Estimate working memory tokens
  const workingTokens = workingMd ? estimateTokens(workingMd) : 0;
  const maxTokens = config?.maxWorkingMemoryTokens ?? 800;

  // Get last updated time
  let lastUpdated = 'never';
  try {
    const workingStat = await stat(getCortexPath('working.md', cwd));
    lastUpdated = relativeTime(workingStat.mtime.toISOString());
  } catch {
    // file might not exist
  }

  // Calculate health score
  const health = calculateHealthScore({
    workingTokens,
    maxTokens,
    episodeCount,
    decisionCount,
    lastUpdated,
  });

  // Detect stale warnings
  const staleWarnings = await detectStaleWarnings(cwd);

  // Render status display
  const projectName = config?.projectName ?? basename(cwd);
  const width = 54;

  console.log('');
  console.log(boxTop(width));
  console.log(boxRow(bold('  CORTEX STATUS'), width));
  console.log(boxDivider(width));
  console.log(boxRow('', width));
  console.log(
    boxRow(`  Project:        ${cyan(projectName)}`, width)
  );
  console.log(
    boxRow(
      `  Memory Health:  ${colorizeScore(health.score)}`,
      width
    )
  );
  console.log(
    boxRow(`  Last updated:   ${dim(lastUpdated)}`, width)
  );
  console.log(boxRow('', width));
  console.log(boxDivider(width));
  console.log(boxRow('', width));
  console.log(
    boxRow(
      `  Working memory: ${colorizeTokens(workingTokens, maxTokens)}`,
      width
    )
  );
  console.log(
    boxRow(`  Episodes:       ${bold(String(episodeCount))}`, width)
  );
  console.log(
    boxRow(`  Decisions:      ${bold(String(decisionCount))}`, width)
  );
  console.log(boxRow('', width));

  if (staleWarnings.length > 0) {
    console.log(boxDivider(width));
    console.log(boxRow(yellow('  Stale Warnings:'), width));
    for (const warning of staleWarnings) {
      console.log(boxRow(yellow(`    - ${warning.message}`), width));
    }
    console.log(boxRow('', width));
  }

  console.log(boxBottom(width));
  console.log('');
}

interface HealthInput {
  workingTokens: number;
  maxTokens: number;
  episodeCount: number;
  decisionCount: number;
  lastUpdated: string;
}

function calculateHealthScore(input: HealthInput): MemoryHealth {
  let score = 0;

  // Working memory exists and is reasonable size (30 points)
  if (input.workingTokens > 0) {
    score += 15;
    if (input.workingTokens <= input.maxTokens) {
      score += 15;
    } else {
      score += 5; // partial credit for having content, even if over limit
    }
  }

  // Episodes captured (30 points)
  if (input.episodeCount > 0) score += 15;
  if (input.episodeCount >= 3) score += 10;
  if (input.episodeCount >= 10) score += 5;

  // Decisions logged (20 points)
  if (input.decisionCount > 0) score += 10;
  if (input.decisionCount >= 3) score += 5;
  if (input.decisionCount >= 10) score += 5;

  // Recency (20 points)
  if (input.lastUpdated === 'just now' || input.lastUpdated.includes('m ago')) {
    score += 20;
  } else if (input.lastUpdated.includes('h ago')) {
    score += 15;
  } else if (input.lastUpdated.includes('d ago')) {
    const days = parseInt(input.lastUpdated, 10);
    if (days <= 3) score += 10;
    else if (days <= 7) score += 5;
  }

  return {
    score: Math.min(100, score),
    projectName: '',
    lastUpdated: '',
    workingMemoryTokens: input.workingTokens,
    episodeCount: input.episodeCount,
    decisionCount: input.decisionCount,
    staleWarnings: [],
  };
}

function colorizeScore(score: number): string {
  const display = `${score}/100`;
  if (score >= 70) return green(display);
  if (score >= 40) return yellow(display);
  return red(display);
}

function colorizeTokens(current: number, max: number): string {
  const display = `${current}/${max} tokens`;
  if (current <= max * 0.8) return green(display);
  if (current <= max) return yellow(display);
  return red(display);
}

async function detectStaleWarnings(cwd: string): Promise<StaleWarning[]> {
  const warnings: StaleWarning[] = [];

  try {
    const workingStat = await stat(getCortexPath('working.md', cwd));
    const daysSinceUpdate =
      (Date.now() - workingStat.mtime.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceUpdate > 7) {
      warnings.push({
        module: 'working-memory',
        lastMemoryUpdate: workingStat.mtime.toISOString(),
        recentFileChanges: 0,
        message: `Working memory not updated in ${Math.floor(daysSinceUpdate)} days`,
      });
    }
  } catch {
    warnings.push({
      module: 'working-memory',
      lastMemoryUpdate: 'never',
      recentFileChanges: 0,
      message: 'Working memory file missing',
    });
  }

  try {
    const episodeFiles = await readdir(getCortexPath('episodes', cwd));
    if (episodeFiles.length === 0) {
      warnings.push({
        module: 'episodes',
        lastMemoryUpdate: 'never',
        recentFileChanges: 0,
        message: 'No episodes captured yet',
      });
    }
  } catch {
    // episodes dir missing is handled by init check
  }

  return warnings;
}

// ============================================================
// COMMAND: query
// ============================================================

async function handleQuery(searchTerm: string): Promise<void> {
  const cwd = process.cwd();
  await requireCortexDir(cwd);

  const term = searchTerm.toLowerCase();
  const results: Array<{ source: string; title: string; excerpt: string }> = [];

  // Search working memory
  const workingMd = await readTextFile(getCortexPath('working.md', cwd));
  if (workingMd && workingMd.toLowerCase().includes(term)) {
    const lines = workingMd.split('\n');
    const matchingLines = lines.filter((line) =>
      line.toLowerCase().includes(term)
    );
    for (const line of matchingLines.slice(0, 3)) {
      results.push({
        source: 'working-memory',
        title: 'Working Memory',
        excerpt: highlightMatch(line.trim(), term),
      });
    }
  }

  // Search decisions
  const decisionsMd = await readTextFile(getCortexPath('decisions.md', cwd));
  if (decisionsMd && decisionsMd.toLowerCase().includes(term)) {
    const sections = decisionsMd.split(/^## /m).slice(1);
    for (const section of sections) {
      if (section.toLowerCase().includes(term)) {
        const title = section.split('\n')[0].trim();
        const lines = section.split('\n').filter((l) =>
          l.toLowerCase().includes(term)
        );
        results.push({
          source: 'decisions',
          title: `Decision: ${title}`,
          excerpt: highlightMatch(
            lines.slice(0, 2).join(' ').trim().substring(0, 200),
            term
          ),
        });
      }
    }
  }

  // Search episodes
  try {
    const episodeDir = getCortexPath('episodes', cwd);
    const episodeFiles = await readdir(episodeDir);

    for (const file of episodeFiles) {
      const filePath = join(episodeDir, file);
      const content = await readTextFile(filePath);
      if (!content || !content.toLowerCase().includes(term)) continue;

      if (file.endsWith('.json')) {
        try {
          const episode = JSON.parse(content) as EpisodicMemory;
          results.push({
            source: 'episode',
            title: `Episode: ${episode.title}`,
            excerpt: highlightMatch(
              episode.summary.substring(0, 200),
              term
            ),
          });
        } catch {
          // Skip malformed JSON
        }
      } else if (file.endsWith('.md')) {
        const lines = content.split('\n');
        const titleLine = lines.find((l) => l.startsWith('# '));
        const matchingLines = lines.filter((l) =>
          l.toLowerCase().includes(term)
        );
        results.push({
          source: 'episode',
          title: `Episode: ${titleLine?.replace('# ', '') ?? file}`,
          excerpt: highlightMatch(
            matchingLines.slice(0, 2).join(' ').trim().substring(0, 200),
            term
          ),
        });
      }
    }
  } catch {
    // episodes dir might not exist
  }

  // Display results
  console.log('');
  if (results.length === 0) {
    console.log(yellow(`  No results found for "${searchTerm}"`));
    console.log(dim('  Try a different search term or broader query.'));
    console.log('');
    return;
  }

  console.log(
    bold(`  Found ${results.length} result${results.length === 1 ? '' : 's'} for "${searchTerm}"`)
  );
  console.log('');

  for (const result of results) {
    const sourceLabel = colorizeSource(result.source);
    console.log(`  ${sourceLabel} ${bold(result.title)}`);
    console.log(`    ${dim(result.excerpt)}`);
    console.log('');
  }
}

function highlightMatch(text: string, term: string): string {
  const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
  return text.replace(regex, `${ANSI.bold}${ANSI.cyan}$1${ANSI.reset}${ANSI.dim}`);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function colorizeSource(source: string): string {
  switch (source) {
    case 'working-memory':
      return `${ANSI.bgGreen}${ANSI.white} WRK ${ANSI.reset}`;
    case 'decisions':
      return `${ANSI.bgYellow}${ANSI.white} DEC ${ANSI.reset}`;
    case 'episode':
      return `${ANSI.cyan}[EPI]${ANSI.reset}`;
    default:
      return `[${source}]`;
  }
}

// ============================================================
// COMMAND: export
// ============================================================

async function handleExport(): Promise<void> {
  const cwd = process.cwd();
  await requireCortexDir(cwd);

  const config = await readJsonFile<CortexConfig>(
    getCortexPath('config.json', cwd)
  );
  const workingMd = await readTextFile(getCortexPath('working.md', cwd));
  const decisionsMd = await readTextFile(getCortexPath('decisions.md', cwd));

  const sections: string[] = [];

  // Header
  sections.push(`# Cortex Memory Export`);
  sections.push(`> Exported: ${new Date().toISOString()}`);
  sections.push(`> Project: ${config?.projectName ?? basename(cwd)}`);
  sections.push('');

  // Project overview
  sections.push('---');
  sections.push('');
  sections.push('## Project Overview');
  sections.push('');
  if (config) {
    sections.push(`- **Name:** ${config.projectName}`);
    sections.push(`- **Path:** ${config.projectPath}`);
    sections.push(`- **Created:** ${config.createdAt}`);
    sections.push(`- **Extraction Model:** ${config.extractionModel}`);
    sections.push(`- **Max Working Memory:** ${config.maxWorkingMemoryTokens} tokens`);
  }
  sections.push('');

  // Working memory
  sections.push('---');
  sections.push('');
  sections.push('## Current Working Memory');
  sections.push('');
  if (workingMd) {
    sections.push(workingMd);
  } else {
    sections.push('_No working memory recorded._');
  }
  sections.push('');

  // Decisions
  sections.push('---');
  sections.push('');
  sections.push('## Decision Log');
  sections.push('');
  if (decisionsMd) {
    // Strip the header from decisions.md to avoid duplication
    const withoutHeader = decisionsMd
      .replace(/^# Decision Log\n/m, '')
      .trim();
    sections.push(withoutHeader);
  } else {
    sections.push('_No decisions recorded._');
  }
  sections.push('');

  // Episodes
  sections.push('---');
  sections.push('');
  sections.push('## Episodes');
  sections.push('');

  try {
    const episodeDir = getCortexPath('episodes', cwd);
    const episodeFiles = (await readdir(episodeDir)).sort().reverse();

    if (episodeFiles.length === 0) {
      sections.push('_No episodes recorded._');
    }

    // Include up to 20 most recent episodes
    for (const file of episodeFiles.slice(0, 20)) {
      const filePath = join(episodeDir, file);
      const content = await readTextFile(filePath);
      if (!content) continue;

      if (file.endsWith('.json')) {
        try {
          const episode = JSON.parse(content) as EpisodicMemory;
          sections.push(`### ${episode.title}`);
          sections.push(`_Session: ${episode.sessionId} | ${episode.timestamp}_`);
          sections.push('');
          sections.push(episode.summary);
          if (episode.filesAffected.length > 0) {
            sections.push('');
            sections.push(
              `**Files:** ${episode.filesAffected.join(', ')}`
            );
          }
          sections.push('');
        } catch {
          sections.push(`### ${file}`);
          sections.push(content);
          sections.push('');
        }
      } else {
        sections.push(content);
        sections.push('');
      }
    }
  } catch {
    sections.push('_No episodes directory found._');
  }

  sections.push('');

  // Write export file
  const exportContent = sections.join('\n');
  const exportPath = getCortexPath('export.md', cwd);
  await writeFile(exportPath, exportContent, 'utf-8');

  console.log('');
  console.log(green(bold('  Export complete!')));
  console.log(dim(`  Written to: ${exportPath}`));
  console.log(
    dim(`  Size: ${(Buffer.byteLength(exportContent, 'utf-8') / 1024).toFixed(1)} KB`)
  );
  console.log('');
}

// ============================================================
// COMMAND: sync
// ============================================================

async function handleSync(options: { team?: boolean }): Promise<void> {
  if (options.team) {
    console.log('');
    console.log(
      cyan(bold('  Team sync coming soon in Cortex Pro'))
    );
    console.log(dim('  Visit https://cortex.dev/pro for early access.'));
    console.log('');
    return;
  }

  console.log('');
  console.log(yellow('  Please specify a sync mode.'));
  console.log(dim('  Usage: cortex sync --team'));
  console.log('');
}

// ============================================================
// COMMAND: hooks
// ============================================================

async function handleHooksInstall(): Promise<void> {
  const cwd = process.cwd();
  await requireCortexDir(cwd);

  try {
    const { HooksManager } = await import('../engine/hooks/hooksManager.js');
    const manager = new HooksManager(cwd);
    await manager.installHooks();
    console.log('');
    console.log(green(bold('  Claude Code hooks installed successfully!')));
    console.log(
      dim('  Hooks will trigger memory capture on session events.')
    );
    console.log('');
  } catch {
    console.error('');
    console.error(
      red('  Error: Could not install hooks.')
    );
    console.error(
      dim('  Make sure the Cortex engine module is built and available.')
    );
    console.error('');
    process.exit(1);
  }
}

async function handleHooksUninstall(): Promise<void> {
  const cwd = process.cwd();
  await requireCortexDir(cwd);

  try {
    const { HooksManager } = await import('../engine/hooks/hooksManager.js');
    const manager = new HooksManager(cwd);
    await manager.uninstallHooks();
    console.log('');
    console.log(green(bold('  Claude Code hooks uninstalled successfully.')));
    console.log('');
  } catch {
    console.error('');
    console.error(
      red('  Error: Could not uninstall hooks.')
    );
    console.error(
      dim('  Make sure the Cortex engine module is built and available.')
    );
    console.error('');
    process.exit(1);
  }
}

// ============================================================
// CLI PROGRAM
// ============================================================

async function loadVersion(): Promise<string> {
  try {
    const pkgPath = resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.1.0';
  }
}

async function main(): Promise<void> {
  const version = await loadVersion();

  const program = new Command();

  program
    .name('cortex')
    .description('Cortex - Project Memory OS for AI Coding Assistants')
    .version(version, '-v, --version');

  // ── init ────────────────────────────────────────────────

  program
    .command('init')
    .description('Initialize Cortex in the current project')
    .option('--hooks', 'Install Claude Code hooks during initialization')
    .action(async (options: { hooks?: boolean }) => {
      await handleInit(options);
    });

  // ── status ──────────────────────────────────────────────

  program
    .command('status')
    .description('Display memory health and statistics')
    .action(async () => {
      await handleStatus();
    });

  // ── query ───────────────────────────────────────────────

  program
    .command('query <search-term>')
    .description('Search through episodes and decisions')
    .action(async (searchTerm: string) => {
      await handleQuery(searchTerm);
    });

  // ── export ──────────────────────────────────────────────

  program
    .command('export')
    .description('Export all memory as a single markdown file')
    .action(async () => {
      await handleExport();
    });

  // ── sync ────────────────────────────────────────────────

  program
    .command('sync')
    .description('Sync memory with team')
    .option('--team', 'Enable team sync mode')
    .action(async (options: { team?: boolean }) => {
      await handleSync(options);
    });

  // ── hooks ───────────────────────────────────────────────

  const hooksCmd = program
    .command('hooks')
    .description('Manage Claude Code hooks');

  hooksCmd
    .command('install')
    .description('Install Claude Code hooks for automatic memory capture')
    .action(async () => {
      await handleHooksInstall();
    });

  hooksCmd
    .command('uninstall')
    .description('Remove Claude Code hooks')
    .action(async () => {
      await handleHooksUninstall();
    });

  // ── parse ───────────────────────────────────────────────

  await program.parseAsync(process.argv);
}

main().catch((err: Error) => {
  console.error(red(`\nCortex error: ${err.message}`));
  process.exit(1);
});
