// ============================================================
// CORTEX - Core Type Definitions
// ============================================================

/** Memory layer classification */
export type MemoryLayer = 'working' | 'episodic' | 'semantic';

/** Status of a memory entry */
export type MemoryStatus = 'active' | 'stale' | 'archived';

/** Types of events detected in sessions */
export type EventType = 'decision' | 'bug_pattern' | 'architecture' | 'structural' | 'learning' | 'preference';

// --- Memory Entries ---

export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  content: string;
  summary: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  status: MemoryStatus;
  relevanceScore?: number;
  embedding?: number[];
}

export interface WorkingMemory {
  lastSessionSummary: string;
  recentDecisions: DecisionEntry[];
  currentContext: string;
  openProblems: string[];
  updatedAt: string;
  tokenCount: number;
}

export interface EpisodicMemory {
  id: string;
  sessionId: string;
  title: string;
  summary: string;
  decisions: DecisionEntry[];
  patterns: PatternEntry[];
  filesAffected: string[];
  timestamp: string;
  duration?: number;
}

export interface DecisionEntry {
  id: string;
  title: string;
  context: string;
  decision: string;
  alternatives: string[];
  reason: string;
  filesAffected: string[];
  timestamp: string;
  sessionId: string;
}

export interface PatternEntry {
  id: string;
  type: EventType;
  description: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  relatedFiles: string[];
}

// --- Session Types ---

export interface SessionInfo {
  id: string;
  projectPath: string;
  startedAt: string;
  endedAt?: string;
  status: 'active' | 'ended' | 'compacted';
  messageCount: number;
}

export interface SessionMessage {
  type: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  uuid?: string;
  parentUuid?: string;
  toolCalls?: ToolCallInfo[];
}

export interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
  output?: string;
}

// --- Extraction Types ---

export interface ExtractionResult {
  summary: string;
  decisions: Omit<DecisionEntry, 'id' | 'sessionId'>[];
  patterns: Omit<PatternEntry, 'id'>[];
  openProblems: string[];
  filesAffected: string[];
  keyInsights: string[];
  nextSteps: string[];
}

// --- Hook Event Types ---

export interface HookEvent {
  type: 'session_start' | 'session_end' | 'pre_compact' | 'stop';
  sessionId: string;
  source?: string;
  timestamp: string;
  projectPath?: string;
}

// --- Memory Health ---

export interface MemoryHealth {
  score: number; // 0-100
  projectName: string;
  lastUpdated: string;
  workingMemoryTokens: number;
  episodeCount: number;
  decisionCount: number;
  staleWarnings: StaleWarning[];
}

export interface StaleWarning {
  module: string;
  lastMemoryUpdate: string;
  recentFileChanges: number;
  message: string;
}

// --- Config ---

export interface CortexConfig {
  version: string;
  projectName: string;
  projectPath: string;
  createdAt: string;
  anthropicApiKey?: string;
  maxWorkingMemoryTokens: number;
  autoInject: boolean;
  extractionModel: string;
  teamSyncEnabled: boolean;
  ignorePaths: string[];
}

// --- MCP Types ---

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPRequest {
  method: string;
  params: Record<string, unknown>;
}

export interface MCPResponse {
  content: Array<{
    type: 'text';
    text: string;
  }>;
}
