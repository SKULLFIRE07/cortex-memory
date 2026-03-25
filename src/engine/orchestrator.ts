// ============================================================
// CORTEX - Orchestrator (Real-Time)
// ============================================================
// Continuously updates memory as Claude Code generates responses.
// Every thinking block, text output, and tool call triggers
// incremental memory updates in real-time.

import { EventEmitter } from 'node:events';
import type {
  HookEvent,
  SessionMessage,
  WorkingMemory,
  ExtractionResult,
  DecisionEntry,
  PatternEntry,
} from '../types/index.js';
import { SessionWatcher } from './watcher/sessionWatcher.js';
import { ExtractionEngine } from './extractor/extractionEngine.js';
import { ClaudeMdInjector } from './injector/claudeMdInjector.js';
import { compressWorkingMemory, formatForInjection, estimateTokens } from './compressor.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface MemoryStore {
  getWorkingMemory(): Promise<WorkingMemory>;
  updateWorkingMemory(extraction: ExtractionResult, sessionId?: string): Promise<void>;
  addEpisode(episode: any): Promise<void>;
  addDecision(decision: DecisionEntry): Promise<void>;
  getHealth(): Promise<any>;
}

interface HooksManager {
  isInstalled(): Promise<boolean>;
  installHooks(): Promise<void>;
  uninstallHooks(): Promise<void>;
  watchHookSignals(callback: (event: HookEvent) => void): Promise<() => void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 800;

/** Flush memory every N seconds during active sessions. */
const REALTIME_FLUSH_INTERVAL_MS = 15_000;

/** Trigger LLM extraction every N messages (if API key available). */
const LLM_EXTRACTION_THRESHOLD = 20;

/** Max messages to buffer before forcing a flush (safety valve). */
const MAX_BUFFER_SIZE = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  projectPath: string;
  apiKey?: string;
  llmProvider?: 'gemini' | 'anthropic' | 'ollama';
  llmModel?: string;
  maxTokens?: number;
}

export interface OrchestratorEvents {
  'initialized': () => void;
  'session:started': (sessionId: string) => void;
  'session:ended': (sessionId: string) => void;
  'extraction:complete': (result: ExtractionResult) => void;
  'injection:complete': () => void;
  'memory:updated': () => void;
  'error': (error: Error) => void;
}

// ---------------------------------------------------------------------------
// CortexOrchestrator
// ---------------------------------------------------------------------------

export class CortexOrchestrator extends EventEmitter {
  private readonly projectPath: string;
  private readonly apiKey: string | undefined;
  private readonly llmProvider: 'gemini' | 'anthropic' | 'ollama';
  private readonly llmModel: string | undefined;
  private readonly maxTokens: number;

  private memoryStore: MemoryStore | null = null;
  private extractionEngine: ExtractionEngine | null = null;
  private sessionWatcher: SessionWatcher | null = null;
  private claudeMdInjector: ClaudeMdInjector | null = null;
  private hooksManager: HooksManager | null = null;
  private hookSignalCleanup: (() => void) | null = null;

  // Real-time state
  private messageBuffer: Map<string, SessionMessage[]> = new Map();
  private activeSessions: Set<string> = new Set();
  private flushTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private messagesSinceLastExtraction: Map<string, number> = new Map();
  private extractionInProgress: Set<string> = new Set();
  private initialized = false;

  // Track files mentioned across messages for real-time context
  private sessionFiles: Map<string, Set<string>> = new Map();

  constructor(options: OrchestratorOptions) {
    super();
    this.projectPath = options.projectPath;
    this.apiKey = options.apiKey;
    this.llmProvider = options.llmProvider ?? 'gemini';
    this.llmModel = options.llmModel;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      this.memoryStore = await this.createMemoryStore();

      if (this.apiKey || this.llmProvider === 'ollama') {
        this.extractionEngine = new ExtractionEngine({
          provider: this.llmProvider,
          apiKey: this.apiKey,
          model: this.llmModel,
        });
      }

      this.sessionWatcher = new SessionWatcher(this.projectPath);
      this.claudeMdInjector = new ClaudeMdInjector(
        this.projectPath,
        this.memoryStore as any,
      );
      this.hooksManager = await this.createHooksManager();

      if (this.hooksManager) {
        const installed = await this.hooksManager.isInstalled();
        if (!installed) {
          await this.hooksManager.installHooks();
        }
        this.hookSignalCleanup = await this.hooksManager.watchHookSignals((event) => {
          this.handleHookEvent(event).catch((err) => this.emitError('hook-signal', err));
        });
      }

      this.setupEventListeners();
      await this.injectWorkingMemory();
      this.sessionWatcher.start();

      this.initialized = true;
      this.emit('initialized');
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('error', err);
      throw err;
    }
  }

  async handleHookEvent(event: HookEvent): Promise<void> {
    switch (event.type) {
      case 'session_start':
        await this.handleSessionStart(event);
        break;
      case 'session_end':
      case 'stop':
        await this.handleSessionEnd(event);
        break;
      case 'pre_compact':
        await this.handlePreCompact(event);
        break;
    }
  }

  async handleSessionStart(event: HookEvent): Promise<void> {
    const { sessionId } = event;
    this.activeSessions.add(sessionId);
    this.messageBuffer.set(sessionId, []);
    this.messagesSinceLastExtraction.set(sessionId, 0);
    this.sessionFiles.set(sessionId, new Set());

    // Start the real-time flush timer for this session
    this.startFlushTimer(sessionId);

    await this.injectWorkingMemory();
    this.emit('session:started', sessionId);
  }

  async handleSessionEnd(event: HookEvent): Promise<void> {
    const { sessionId } = event;

    try {
      // Stop the flush timer
      this.stopFlushTimer(sessionId);

      // Do a final full extraction with everything buffered
      await this.doFullExtraction(sessionId);

      // Clean up
      this.activeSessions.delete(sessionId);
      this.messageBuffer.delete(sessionId);
      this.messagesSinceLastExtraction.delete(sessionId);
      this.sessionFiles.delete(sessionId);
      this.extractionInProgress.delete(sessionId);

      await this.injectWorkingMemory();
      this.emit('session:ended', sessionId);
    } catch (error: unknown) {
      this.emitError('handleSessionEnd', error);
    }
  }

  async handlePreCompact(event: HookEvent): Promise<void> {
    const { sessionId } = event;
    try {
      await this.doFullExtraction(sessionId);
      await this.injectWorkingMemory();
    } catch (error: unknown) {
      this.emitError('handlePreCompact', error);
    }
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    // Stop all flush timers
    for (const sessionId of this.flushTimers.keys()) {
      this.stopFlushTimer(sessionId);
    }

    try {
      // Final extraction for all sessions
      for (const sessionId of this.messageBuffer.keys()) {
        await this.doFullExtraction(sessionId);
      }
      await this.injectWorkingMemory();
    } catch {
      // Best-effort
    }

    if (this.hookSignalCleanup) {
      this.hookSignalCleanup();
      this.hookSignalCleanup = null;
    }

    if (this.sessionWatcher) {
      this.sessionWatcher.stop();
      this.sessionWatcher = null;
    }

    this.memoryStore = null;
    this.extractionEngine = null;
    this.claudeMdInjector = null;
    this.hooksManager = null;
    this.messageBuffer.clear();
    this.activeSessions.clear();
    this.flushTimers.clear();
    this.messagesSinceLastExtraction.clear();
    this.sessionFiles.clear();
    this.extractionInProgress.clear();
    this.initialized = false;
  }

  // -----------------------------------------------------------------------
  // Real-Time Flush Timer
  // -----------------------------------------------------------------------

  /**
   * Start a periodic timer that flushes buffered messages to memory.
   * This ensures memory is updated every REALTIME_FLUSH_INTERVAL_MS
   * even if the LLM extraction threshold hasn't been hit.
   */
  private startFlushTimer(sessionId: string): void {
    this.stopFlushTimer(sessionId);

    const timer = setInterval(() => {
      this.realtimeFlush(sessionId).catch((err) =>
        this.emitError('realtime-flush', err),
      );
    }, REALTIME_FLUSH_INTERVAL_MS);

    this.flushTimers.set(sessionId, timer);
  }

  private stopFlushTimer(sessionId: string): void {
    const timer = this.flushTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.flushTimers.delete(sessionId);
    }
  }

  /**
   * Periodic real-time flush: update memory with whatever we have so far.
   * Uses fast local extraction (no LLM call) for instant updates.
   * LLM extraction happens less frequently for deeper analysis.
   */
  private async realtimeFlush(sessionId: string): Promise<void> {
    const messages = this.messageBuffer.get(sessionId);
    if (!messages || messages.length === 0) return;

    // Apply fast local extraction (no API call)
    await this.applyIncrementalUpdate(sessionId, messages);

    // Check if we should trigger an LLM extraction
    const count = this.messagesSinceLastExtraction.get(sessionId) ?? 0;
    if (count >= LLM_EXTRACTION_THRESHOLD && this.extractionEngine && !this.extractionInProgress.has(sessionId)) {
      // Run LLM extraction in background (don't block the flush)
      this.triggerLLMExtraction(sessionId).catch((err) =>
        this.emitError('background-extraction', err),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Event Wiring
  // -----------------------------------------------------------------------

  private setupEventListeners(): void {
    if (!this.sessionWatcher) return;

    this.sessionWatcher.on('session:start', ({ sessionId }) => {
      this.handleSessionStart({
        type: 'session_start',
        sessionId,
        timestamp: new Date().toISOString(),
        projectPath: this.projectPath,
      }).catch((err) => this.emitError('session:start listener', err));
    });

    this.sessionWatcher.on('session:end', ({ sessionId }) => {
      this.handleSessionEnd({
        type: 'session_end',
        sessionId,
        timestamp: new Date().toISOString(),
        projectPath: this.projectPath,
      }).catch((err) => this.emitError('session:end listener', err));
    });

    // Every single message triggers real-time processing
    this.sessionWatcher.on('session:message', (message) => {
      const { sessionId, ...msg } = message;
      this.onMessageReceived(sessionId, msg);
    });

    this.sessionWatcher.on('signal:decision', ({ sessionId, message }) => {
      // Decisions are high-value — trigger immediate flush
      this.realtimeFlush(sessionId).catch((err) =>
        this.emitError('decision-flush', err),
      );
    });

    this.sessionWatcher.on('signal:bug', ({ sessionId, message }) => {
      this.realtimeFlush(sessionId).catch((err) =>
        this.emitError('bug-flush', err),
      );
    });

    this.sessionWatcher.on('signal:architecture', ({ sessionId, message }) => {
      this.realtimeFlush(sessionId).catch((err) =>
        this.emitError('architecture-flush', err),
      );
    });

    this.sessionWatcher.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }

  // -----------------------------------------------------------------------
  // Message Processing (Real-Time)
  // -----------------------------------------------------------------------

  /**
   * Called for every single message as it arrives.
   * Buffers the message and tracks files mentioned.
   */
  private onMessageReceived(sessionId: string, message: SessionMessage): void {
    if (!this.messageBuffer.has(sessionId)) {
      this.messageBuffer.set(sessionId, []);
      this.messagesSinceLastExtraction.set(sessionId, 0);
      this.sessionFiles.set(sessionId, new Set());
    }

    const buffer = this.messageBuffer.get(sessionId)!;

    // Deduplicate
    if (message.uuid && buffer.some((m) => m.uuid === message.uuid)) {
      return;
    }

    buffer.push(message);
    this.messagesSinceLastExtraction.set(
      sessionId,
      (this.messagesSinceLastExtraction.get(sessionId) ?? 0) + 1,
    );

    // Track file paths mentioned in this message
    this.extractFilePaths(sessionId, message);

    // Safety valve: force extraction if buffer is huge
    if (buffer.length >= MAX_BUFFER_SIZE) {
      this.doFullExtraction(sessionId).catch((err) =>
        this.emitError('overflow-extract', err),
      );
    }
  }

  /**
   * Extract file paths from message content for real-time tracking.
   */
  private extractFilePaths(sessionId: string, message: SessionMessage): void {
    const files = this.sessionFiles.get(sessionId);
    if (!files) return;

    // Extract from tool calls
    if (message.toolCalls) {
      for (const call of message.toolCalls) {
        const p = (call.input.file_path ?? call.input.path ?? call.input.filePath) as string | undefined;
        if (p && typeof p === 'string') {
          // Store relative path
          const rel = p.startsWith(this.projectPath)
            ? p.slice(this.projectPath.length + 1)
            : p;
          files.add(rel);
        }
      }
    }

    // Extract paths from content using common patterns
    const pathMatches = message.content.match(/(?:^|\s|`)((?:src|lib|app|test|spec|pkg|cmd)\/[\w./-]+\.\w+)/g);
    if (pathMatches) {
      for (const match of pathMatches) {
        files.add(match.trim().replace(/^`|`$/g, ''));
      }
    }
  }

  // -----------------------------------------------------------------------
  // Incremental Update (Fast, No API Call)
  // -----------------------------------------------------------------------

  /**
   * Fast local update — builds a summary from recent messages without LLM.
   * Updates working memory and CLAUDE.md immediately.
   */
  private async applyIncrementalUpdate(
    sessionId: string,
    messages: SessionMessage[],
  ): Promise<void> {
    if (!this.memoryStore || messages.length === 0) return;

    // Build a live summary from the most recent messages
    const recentMessages = messages.slice(-10);
    const summaryParts: string[] = [];

    for (const msg of recentMessages) {
      if (msg.type === 'user') {
        // Clean up thinking markers
        const clean = msg.content
          .replace(/\[thinking\][\s\S]*?(?=\n\[|$)/g, '')
          .replace(/\[tool:.*?\]/g, '')
          .replace(/\[tool_result\][\s\S]*?(?=\n|$)/g, '')
          .trim();
        if (clean && clean.length > 5) {
          summaryParts.push(clean.slice(0, 150));
        }
      } else if (msg.type === 'assistant') {
        // Extract key text from assistant (skip thinking/tool noise)
        const clean = msg.content
          .replace(/\[thinking\][\s\S]*?(?=\n\[|$)/g, '')
          .replace(/\[tool:.*?\]/g, '')
          .replace(/\[tool_result\][\s\S]*?(?=\n|$)/g, '')
          .trim();
        if (clean && clean.length > 10) {
          summaryParts.push(clean.slice(0, 200));
        }
      }
    }

    const summary = summaryParts.length > 0
      ? summaryParts.slice(0, 3).join('. ').slice(0, 500)
      : `Active session with ${messages.length} messages`;

    // Extract any decisions from patterns in the messages
    const localDecisions = this.extractLocalDecisions(recentMessages);

    // Get files tracked this session
    const filesAffected = Array.from(this.sessionFiles.get(sessionId) ?? []);

    // Extract open problems from user questions
    const openProblems = this.extractProblems(recentMessages);

    const result: ExtractionResult = {
      summary,
      decisions: localDecisions,
      patterns: [],
      openProblems,
      filesAffected,
      keyInsights: [],
      nextSteps: [],
    };

    await this.memoryStore.updateWorkingMemory(result, sessionId);
    await this.injectWorkingMemory();
    this.emit('memory:updated');
  }

  /**
   * Extract decisions from messages using pattern matching (no LLM).
   */
  private extractLocalDecisions(
    messages: SessionMessage[],
  ): Omit<DecisionEntry, 'id' | 'sessionId'>[] {
    const decisions: Omit<DecisionEntry, 'id' | 'sessionId'>[] = [];

    const decisionPatterns = [
      /(?:I've decided|Let's go with|Going with|Decision:)\s*(.+?)(?:\.|$)/i,
      /(?:We(?:'ll| will) use)\s+(.+?)(?:\s+(?:for|because|instead)|\.)/i,
    ];

    for (const msg of messages) {
      for (const pattern of decisionPatterns) {
        const match = msg.content.match(pattern);
        if (match) {
          decisions.push({
            title: match[1].trim().slice(0, 80),
            context: '',
            decision: match[0].trim().slice(0, 200),
            alternatives: [],
            reason: '',
            filesAffected: [],
            timestamp: msg.timestamp,
          });
          break; // One decision per message
        }
      }
    }

    return decisions;
  }

  /**
   * Extract open problems from user questions and unresolved topics.
   */
  private extractProblems(messages: SessionMessage[]): string[] {
    const problems: string[] = [];

    for (const msg of messages) {
      if (msg.type !== 'user') continue;
      const clean = msg.content
        .replace(/\[thinking\][\s\S]*/g, '')
        .replace(/\[tool.*?\]/g, '')
        .trim();

      // Look for problem indicators
      if (/(?:fix|bug|broken|not working|error|crash|fail)/i.test(clean) && clean.length < 200) {
        problems.push(clean.slice(0, 150));
      }
    }

    return problems.slice(0, 5); // Keep it focused
  }

  // -----------------------------------------------------------------------
  // LLM Extraction (Deep, Background)
  // -----------------------------------------------------------------------

  /**
   * Trigger a full LLM extraction in the background.
   * This runs alongside the real-time local updates.
   */
  private async triggerLLMExtraction(sessionId: string): Promise<void> {
    if (!this.extractionEngine || this.extractionInProgress.has(sessionId)) return;

    const messages = this.messageBuffer.get(sessionId);
    if (!messages || messages.length === 0) return;

    this.extractionInProgress.add(sessionId);
    this.messagesSinceLastExtraction.set(sessionId, 0);

    // Take a snapshot for extraction (don't clear buffer — incremental updates continue)
    const snapshot = [...messages];

    try {
      const result = await this.extractionEngine.extractFromSession(snapshot);
      await this.applyExtractionResult(sessionId, result);
      this.emit('extraction:complete', result);
    } catch (error: unknown) {
      this.emitError('llm-extraction', error);
    } finally {
      this.extractionInProgress.delete(sessionId);
    }
  }

  /**
   * Force a full extraction on all buffered messages for a session.
   * Used at session end and pre-compact.
   */
  private async doFullExtraction(sessionId: string): Promise<void> {
    const messages = this.messageBuffer.get(sessionId);
    if (!messages || messages.length === 0) return;

    const snapshot = [...messages];
    messages.length = 0;

    if (this.extractionEngine) {
      try {
        const result = await this.extractionEngine.extractFromSession(snapshot);
        await this.applyExtractionResult(sessionId, result);
        this.emit('extraction:complete', result);
      } catch {
        await this.applyBasicExtraction(sessionId, snapshot);
      }
    } else {
      await this.applyBasicExtraction(sessionId, snapshot);
    }
  }

  private async applyExtractionResult(
    sessionId: string,
    result: ExtractionResult,
  ): Promise<void> {
    if (!this.memoryStore) return;

    const now = new Date().toISOString();

    const decisions: DecisionEntry[] = result.decisions.map((d, i) => ({
      ...d,
      id: `${sessionId.slice(0, 8)}-d${i}-${Date.now()}`,
      sessionId,
      timestamp: d.timestamp || now,
    }));

    const patterns: PatternEntry[] = result.patterns.map((p, i) => ({
      ...p,
      id: `${sessionId.slice(0, 8)}-p${i}-${Date.now()}`,
    }));

    // Merge session-tracked files into the result
    const sessionFileSet = this.sessionFiles.get(sessionId);
    const allFiles = new Set([
      ...result.filesAffected,
      ...(sessionFileSet ?? []),
    ]);

    const enrichedResult: ExtractionResult = {
      ...result,
      filesAffected: Array.from(allFiles),
    };

    await this.memoryStore.updateWorkingMemory(enrichedResult, sessionId);

    for (const decision of decisions) {
      await this.memoryStore.addDecision(decision);
    }

    await this.memoryStore.addEpisode({
      id: `ep-${sessionId.slice(0, 8)}-${Date.now()}`,
      sessionId,
      title: result.summary.slice(0, 80) || `Session ${sessionId.slice(0, 8)}`,
      summary: result.summary,
      decisions,
      patterns,
      filesAffected: Array.from(allFiles),
      timestamp: now,
    });

    await this.injectWorkingMemory();
  }

  private async applyBasicExtraction(
    sessionId: string,
    messages: SessionMessage[],
  ): Promise<void> {
    if (!this.memoryStore) return;

    const now = new Date().toISOString();

    const userMessages = messages
      .filter((m) => m.type === 'user')
      .slice(0, 5)
      .map((m) =>
        m.content
          .replace(/\[thinking\][\s\S]*/g, '')
          .replace(/\[tool.*?\]/g, '')
          .trim()
          .slice(0, 200),
      );

    const summary = userMessages.length > 0
      ? `Session covered: ${userMessages.join('; ')}`
      : `Session ${sessionId.slice(0, 8)} with ${messages.length} messages.`;

    const truncatedSummary =
      summary.length > 500 ? summary.slice(0, 497) + '...' : summary;

    const filesAffected = Array.from(this.sessionFiles.get(sessionId) ?? []);

    const basicResult: ExtractionResult = {
      summary: truncatedSummary,
      decisions: [],
      patterns: [],
      openProblems: [],
      filesAffected,
      keyInsights: [],
      nextSteps: [],
    };

    await this.memoryStore.updateWorkingMemory(basicResult, sessionId);

    await this.memoryStore.addEpisode({
      id: `ep-${sessionId.slice(0, 8)}-${Date.now()}`,
      sessionId,
      title: truncatedSummary.slice(0, 80) || `Session ${sessionId.slice(0, 8)}`,
      summary: truncatedSummary,
      decisions: [],
      patterns: [],
      filesAffected,
      timestamp: now,
    });

    await this.injectWorkingMemory();
  }

  // -----------------------------------------------------------------------
  // CLAUDE.md Injection
  // -----------------------------------------------------------------------

  private async injectWorkingMemory(): Promise<void> {
    if (!this.claudeMdInjector) return;

    try {
      await this.claudeMdInjector.inject();
      this.emit('injection:complete');
    } catch (error: unknown) {
      this.emitError('injection', error);
    }
  }

  // -----------------------------------------------------------------------
  // Subsystem Factory Methods
  // -----------------------------------------------------------------------

  private async createMemoryStore(): Promise<MemoryStore> {
    try {
      const mod = await import('./memory/memoryStore.js');
      const StoreClass = mod.MemoryStore ?? mod.default;
      return new StoreClass(this.projectPath, this.maxTokens);
    } catch {
      return this.createStubMemoryStore();
    }
  }

  private async createHooksManager(): Promise<HooksManager | null> {
    try {
      const mod = await import('./hooks/hooksManager.js');
      const ManagerClass = mod.HooksManager ?? mod.default;
      return new ManagerClass(this.projectPath);
    } catch {
      return null;
    }
  }

  private createStubMemoryStore(): MemoryStore {
    let workingMemory: WorkingMemory = {
      lastSessionSummary: '',
      recentDecisions: [],
      currentContext: '',
      openProblems: [],
      updatedAt: new Date().toISOString(),
      tokenCount: 0,
    };

    return {
      async getWorkingMemory() { return { ...workingMemory }; },
      async updateWorkingMemory(partial: any) {
        workingMemory = { ...workingMemory, ...partial } as WorkingMemory;
      },
      async addEpisode() {},
      async addDecision() {},
      async getHealth() { return { score: 0 }; },
    };
  }

  // -----------------------------------------------------------------------
  // Error Handling
  // -----------------------------------------------------------------------

  private emitError(context: string, error: unknown): void {
    const err = error instanceof Error
      ? error
      : new Error(`[${context}] ${String(error)}`);
    if (!(error instanceof Error)) {
      err.message = `[${context}] ${err.message}`;
    }
    this.emit('error', err);
  }
}
