// ============================================================
// CORTEX - Orchestrator
// ============================================================
// Main orchestrator that ties together the entire Cortex memory
// system. Coordinates session lifecycle events, extraction,
// memory storage, and CLAUDE.md injection.

import { EventEmitter } from 'node:events';
import type {
  HookEvent,
  SessionMessage,
  WorkingMemory,
  ExtractionResult,
  DecisionEntry,
} from '../types/index.js';
import { SessionWatcher } from './watcher/sessionWatcher.js';
import { ExtractionEngine } from './extractor/extractionEngine.js';
import { ClaudeMdInjector } from './injector/claudeMdInjector.js';
import { compressWorkingMemory, formatForInjection, estimateTokens } from './compressor.js';

// ---------------------------------------------------------------------------
// Placeholder interfaces for modules that haven't been built yet.
// These will be replaced with real imports once the modules exist.
// ---------------------------------------------------------------------------

/**
 * Minimal MemoryStore interface expected by the orchestrator.
 * The real implementation lives in `./memory/memoryStore.ts`.
 */
interface MemoryStore {
  getWorkingMemory(): Promise<WorkingMemory>;
  updateWorkingMemory(extraction: any, sessionId?: string): Promise<void>;
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

/** How many messages to buffer before forcing an extraction. */
const MAX_BUFFER_SIZE = 50;

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
  'error': (error: Error) => void;
}

// ---------------------------------------------------------------------------
// CortexOrchestrator
// ---------------------------------------------------------------------------

/**
 * Central coordinator for the Cortex memory system.
 *
 * Lifecycle:
 *   1. `initialize()` — sets up all subsystems and installs hooks.
 *   2. Session watcher emits events as Claude Code sessions progress.
 *   3. The orchestrator buffers messages, extracts memories at key moments
 *      (pre-compact, session end), and keeps CLAUDE.md up to date.
 *   4. `shutdown()` — tears down watchers and flushes pending work.
 */
export class CortexOrchestrator extends EventEmitter {
  private readonly projectPath: string;
  private readonly apiKey: string | undefined;
  private readonly llmProvider: 'gemini' | 'anthropic' | 'ollama';
  private readonly llmModel: string | undefined;
  private readonly maxTokens: number;

  // Subsystems — initialised in initialize().
  private memoryStore: MemoryStore | null = null;
  private extractionEngine: ExtractionEngine | null = null;
  private sessionWatcher: SessionWatcher | null = null;
  private claudeMdInjector: ClaudeMdInjector | null = null;
  private hooksManager: HooksManager | null = null;

  // Message buffer: accumulates messages between extraction points.
  private messageBuffer: Map<string, SessionMessage[]> = new Map();

  // Track active sessions.
  private activeSessions: Set<string> = new Set();

  // Guard against double-initialization.
  private initialized = false;

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

  /**
   * Initialize all subsystems and prepare the orchestrator for operation.
   *
   * This must be called before the orchestrator will respond to any events.
   * It is safe to call multiple times — subsequent calls are no-ops.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Create subsystems.
      // NOTE: MemoryStore and HooksManager are created via dynamic import
      // so this module can be loaded even if those modules haven't been
      // written yet. Replace with static imports once they exist.
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
        this.memoryStore as any, // MemoryStore satisfies the injector's interface
      );
      this.hooksManager = await this.createHooksManager();

      // Install hooks if not already present.
      if (this.hooksManager) {
        const installed = await this.hooksManager.isInstalled();
        if (!installed) {
          await this.hooksManager.installHooks();
        }
      }

      // Wire up event listeners on the session watcher.
      this.setupEventListeners();

      // Inject current working memory into CLAUDE.md.
      await this.injectWorkingMemory();

      // Start watching for session activity.
      this.sessionWatcher.start();

      this.initialized = true;
      this.emit('initialized');
    } catch (error: unknown) {
      const err =
        error instanceof Error
          ? error
          : new Error(String(error));
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Handle a session start hook event.
   *
   * Injects the latest working memory into CLAUDE.md so the new session
   * starts with full project context.
   */
  async handleSessionStart(event: HookEvent): Promise<void> {
    const { sessionId } = event;
    this.activeSessions.add(sessionId);
    this.messageBuffer.set(sessionId, []);

    // Inject fresh working memory for the new session.
    await this.injectWorkingMemory();
    this.emit('session:started', sessionId);
  }

  /**
   * Handle a session end hook event.
   *
   * Performs final extraction from any buffered messages, updates all three
   * memory layers, and refreshes CLAUDE.md.
   */
  async handleSessionEnd(event: HookEvent): Promise<void> {
    const { sessionId } = event;

    try {
      // Process any remaining buffered messages.
      await this.processBufferedMessagesForSession(sessionId);

      // Clean up session tracking.
      this.activeSessions.delete(sessionId);
      this.messageBuffer.delete(sessionId);

      // Refresh CLAUDE.md with updated memory.
      await this.injectWorkingMemory();
      this.emit('session:ended', sessionId);
    } catch (error: unknown) {
      this.emitError('handleSessionEnd', error);
    }
  }

  /**
   * Handle a pre-compact hook event.
   *
   * Claude Code is about to compact the conversation. This is our cue to
   * extract memories from the messages accumulated so far, before the
   * conversation context is reduced.
   */
  async handlePreCompact(event: HookEvent): Promise<void> {
    const { sessionId } = event;

    try {
      await this.processBufferedMessagesForSession(sessionId);
      await this.injectWorkingMemory();
    } catch (error: unknown) {
      this.emitError('handlePreCompact', error);
    }
  }

  /**
   * Process all buffered messages across all active sessions.
   *
   * Triggers extraction, updates the memory store, and clears the buffers.
   */
  async processBufferedMessages(): Promise<void> {
    const sessionIds = Array.from(this.messageBuffer.keys());

    for (const sessionId of sessionIds) {
      await this.processBufferedMessagesForSession(sessionId);
    }
  }

  /**
   * Gracefully shut down the orchestrator.
   *
   * Processes any remaining buffered messages, stops the session watcher,
   * performs a final CLAUDE.md injection, and releases resources.
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    try {
      // Flush any remaining messages.
      await this.processBufferedMessages();

      // Final injection.
      await this.injectWorkingMemory();
    } catch {
      // Best-effort — we still want to clean up.
    }

    // Stop session watcher.
    if (this.sessionWatcher) {
      this.sessionWatcher.stop();
      this.sessionWatcher = null;
    }

    // Clean up memory store reference.
    if (this.memoryStore) {
      this.memoryStore = null;
    }

    this.extractionEngine = null;
    this.claudeMdInjector = null;
    this.hooksManager = null;
    this.messageBuffer.clear();
    this.activeSessions.clear();
    this.initialized = false;
  }

  // -----------------------------------------------------------------------
  // Internal: Event Wiring
  // -----------------------------------------------------------------------

  /**
   * Wire up event listeners on the session watcher to drive the memory
   * extraction pipeline.
   */
  private setupEventListeners(): void {
    if (!this.sessionWatcher) {
      return;
    }

    // Session lifecycle events.
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

    // Buffer every message for later extraction.
    this.sessionWatcher.on('session:message', (message) => {
      const { sessionId, ...msg } = message;
      this.bufferMessage(sessionId, msg);
    });

    // Semantic signal events — these are also buffered (the messages
    // themselves are already captured above), but we could add real-time
    // processing here in the future.
    this.sessionWatcher.on('signal:decision', ({ sessionId, message }) => {
      this.bufferMessage(sessionId, message);
    });

    this.sessionWatcher.on('signal:bug', ({ sessionId, message }) => {
      this.bufferMessage(sessionId, message);
    });

    this.sessionWatcher.on('signal:architecture', ({ sessionId, message }) => {
      this.bufferMessage(sessionId, message);
    });

    // Propagate watcher errors.
    this.sessionWatcher.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }

  // -----------------------------------------------------------------------
  // Internal: Message Buffering
  // -----------------------------------------------------------------------

  /**
   * Add a message to the buffer for a given session. If the buffer exceeds
   * MAX_BUFFER_SIZE, trigger an automatic extraction.
   */
  private bufferMessage(sessionId: string, message: SessionMessage): void {
    if (!this.messageBuffer.has(sessionId)) {
      this.messageBuffer.set(sessionId, []);
    }

    const buffer = this.messageBuffer.get(sessionId)!;

    // Deduplicate by uuid if available.
    if (message.uuid && buffer.some((m) => m.uuid === message.uuid)) {
      return;
    }

    buffer.push(message);

    // Auto-extract if buffer is getting large.
    if (buffer.length >= MAX_BUFFER_SIZE) {
      this.processBufferedMessagesForSession(sessionId).catch((err) =>
        this.emitError('auto-extract', err),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Internal: Extraction Pipeline
  // -----------------------------------------------------------------------

  /**
   * Extract memories from the buffered messages for a specific session,
   * update the memory store, and clear the buffer.
   */
  private async processBufferedMessagesForSession(
    sessionId: string,
  ): Promise<void> {
    const messages = this.messageBuffer.get(sessionId);
    if (!messages || messages.length === 0) {
      return;
    }

    // Snapshot and clear the buffer to avoid double-processing.
    const snapshot = [...messages];
    messages.length = 0;

    // If no extraction engine is available (no API key), fall back to a
    // basic summary derived from message content.
    if (!this.extractionEngine) {
      await this.applyBasicExtraction(sessionId, snapshot);
      return;
    }

    try {
      const result = await this.extractionEngine.extractFromSession(snapshot);
      await this.applyExtractionResult(sessionId, result);
      this.emit('extraction:complete', result);
    } catch (error: unknown) {
      this.emitError('extraction', error);
      // On failure, attempt basic extraction as a fallback.
      await this.applyBasicExtraction(sessionId, snapshot);
    }
  }

  /**
   * Apply a full extraction result to the memory store.
   *
   * Updates working memory (summary, decisions, problems) and creates an
   * episodic memory entry for the session.
   */
  private async applyExtractionResult(
    sessionId: string,
    result: ExtractionResult,
  ): Promise<void> {
    if (!this.memoryStore) {
      return;
    }

    const now = new Date().toISOString();

    // Stamp decisions with IDs and session info.
    const decisions: DecisionEntry[] = result.decisions.map((d, i) => ({
      ...d,
      id: `${sessionId}-d${i}-${Date.now()}`,
      sessionId,
      timestamp: d.timestamp || now,
    }));

    // Update working memory.
    const currentWorking = await this.memoryStore.getWorkingMemory();
    const mergedDecisions = [
      ...currentWorking.recentDecisions,
      ...decisions,
    ];
    const mergedProblems = deduplicateStrings([
      ...currentWorking.openProblems,
      ...result.openProblems,
    ]);

    const updatedWorking: Partial<WorkingMemory> = {
      lastSessionSummary: result.summary || currentWorking.lastSessionSummary,
      recentDecisions: mergedDecisions,
      openProblems: mergedProblems,
      updatedAt: now,
    };

    // Compress to fit within token budget before saving.
    const fullWorking: WorkingMemory = {
      ...currentWorking,
      ...updatedWorking,
      recentDecisions: mergedDecisions,
      openProblems: mergedProblems,
    };
    const compressed = compressWorkingMemory(fullWorking, this.maxTokens);
    await this.memoryStore.updateWorkingMemory(result, sessionId || 'unknown');

    // Store decisions.
    for (const decision of decisions) {
      await this.memoryStore.addDecision(decision);
    }

    // Create episodic memory entry.
    await this.memoryStore.addEpisode({
      sessionId,
      title: result.summary.slice(0, 80) || `Session ${sessionId}`,
      summary: result.summary,
      decisions,
      patterns: result.patterns as any,
      filesAffected: result.filesAffected,
    });
  }

  /**
   * Fallback extraction when no API key / extraction engine is available.
   *
   * Creates a simple summary from the message content and updates working
   * memory with a basic recap.
   */
  private async applyBasicExtraction(
    sessionId: string,
    messages: SessionMessage[],
  ): Promise<void> {
    if (!this.memoryStore) {
      return;
    }

    const now = new Date().toISOString();

    // Build a basic summary from the first few user messages.
    const userMessages = messages
      .filter((m) => m.type === 'user')
      .slice(0, 5)
      .map((m) => m.content.slice(0, 200));

    const summary = userMessages.length > 0
      ? `Session covered: ${userMessages.join('; ')}`
      : `Session ${sessionId} with ${messages.length} messages.`;

    const truncatedSummary =
      summary.length > 500 ? summary.slice(0, 497) + '...' : summary;

    // Build a minimal ExtractionResult for the store
    const basicResult: ExtractionResult = {
      summary: truncatedSummary,
      decisions: [],
      patterns: [],
      openProblems: [],
      filesAffected: [],
      keyInsights: [],
      nextSteps: [],
    };
    await this.memoryStore.updateWorkingMemory(basicResult, sessionId);
  }

  // -----------------------------------------------------------------------
  // Internal: CLAUDE.md Injection
  // -----------------------------------------------------------------------

  /**
   * Read the current working memory, compress it, and inject into CLAUDE.md.
   */
  private async injectWorkingMemory(): Promise<void> {
    if (!this.claudeMdInjector) {
      return;
    }

    try {
      await this.claudeMdInjector.inject();
      this.emit('injection:complete');
    } catch (error: unknown) {
      this.emitError('injection', error);
    }
  }

  // -----------------------------------------------------------------------
  // Internal: Subsystem Factory Methods
  // -----------------------------------------------------------------------

  /**
   * Create the MemoryStore instance.
   *
   * Uses dynamic import so the orchestrator module can be loaded even
   * before the memory store implementation exists. Falls back to a
   * no-op in-memory stub if the module is not found.
   */
  private async createMemoryStore(): Promise<MemoryStore> {
    try {
      const mod = await import('./memory/memoryStore.js');
      const StoreClass = mod.MemoryStore ?? mod.default;
      return new StoreClass(this.projectPath);
    } catch {
      // Module not yet implemented — return an in-memory stub.
      return this.createStubMemoryStore();
    }
  }

  /**
   * Create the HooksManager instance.
   *
   * Uses dynamic import for the same reason as createMemoryStore.
   */
  private async createHooksManager(): Promise<HooksManager | null> {
    try {
      const mod = await import('./hooks/hooksManager.js');
      const ManagerClass = mod.HooksManager ?? mod.default;
      return new ManagerClass(this.projectPath);
    } catch {
      // Module not yet implemented — hooks will not be managed.
      return null;
    }
  }

  /**
   * In-memory stub MemoryStore used when the real module hasn't been
   * built yet. Stores working memory in a plain object.
   */
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
      async getWorkingMemory() {
        return { ...workingMemory };
      },
      async updateWorkingMemory(partial: any) {
        workingMemory = { ...workingMemory, ...partial } as WorkingMemory;
      },
      async addEpisode() {},
      async addDecision() {},
      async getHealth() { return { score: 0 }; },
    };
  }

  // -----------------------------------------------------------------------
  // Internal: Error Handling
  // -----------------------------------------------------------------------

  /**
   * Emit an error event with contextual information.
   */
  private emitError(context: string, error: unknown): void {
    const err =
      error instanceof Error
        ? error
        : new Error(`[${context}] ${String(error)}`);
    if (!(error instanceof Error)) {
      err.message = `[${context}] ${err.message}`;
    }
    this.emit('error', err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Remove duplicate strings from an array while preserving order.
 */
function deduplicateStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item.trim().toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(item);
    }
  }
  return result;
}
