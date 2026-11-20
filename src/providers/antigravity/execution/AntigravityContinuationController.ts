import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { delayThroughWindow } from '@/app/execution/hostTimers';
import type { AcpSessionNotification, AcpToolCallStatus } from '@/providers/acp/types';

export interface AgyContinuationNoteTurnEndedInput {
  readonly nativeSessionRef: string;
  readonly nativeRunRef?: string;
  readonly output?: string;
  readonly presentContent: (payload: unknown) => void;
  readonly presentNotification?: (notification: AcpSessionNotification) => void;
  readonly isCancelled?: () => boolean;
  readonly noteActivity?: () => void;
}

export interface AgyContinuationOptions {
  readonly pollIntervalMs?: number;
  readonly maxWakeupGraceMs?: number;
  readonly liveWireDrainGraceMs?: number;
  readonly delayMs?: (ms: number) => Promise<void>;
  readonly nowMs?: () => number;
  readonly readFileUtf8?: (filePath: string) => string;
}

export interface AgyContinuationController {
  clearReplay(sessionId: string): void;
  notePromptStarted(sessionId: string): void;
  filterNotification(notification: AcpSessionNotification): boolean;
  noteTurnEnded(input: AgyContinuationNoteTurnEndedInput): Promise<void>;
}

interface TranscriptToolCall {
  readonly id?: string;
  readonly call_id?: string;
  readonly name?: string;
  readonly args?: Record<string, unknown>;
}

interface TranscriptStep {
  readonly step_index?: number;
  readonly source?: string;
  readonly type?: string;
  readonly status?: string;
  readonly content?: string;
  readonly thinking?: string;
  readonly tool_calls?: ReadonlyArray<TranscriptToolCall>;
  readonly truncated_fields?: ReadonlyArray<string>;
}

interface TranscriptCacheEntry {
  readonly compactPath: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly hydratedAboveIndex: number;
  readonly steps: TranscriptStep[];
}

interface PendingSyntheticText {
  remaining: string;
  started: boolean;
}

interface SessionTurnState {
  lastSeenStepIndex: number;
  backgroundDetected: boolean;
  asyncToolIds: Set<string>;
  pendingBackgroundTaskIds: Set<string>;
  wireTaskIdsByToolCallId: Map<string, Set<string>>;
  inFlightWireTools: Map<string, string>;
  seenWireToolIds: Set<string>;
  emittedKeys: Set<string>;
  transcriptCache?: TranscriptCacheEntry;
  inContinuation: boolean;
  sawLiveWireContinuation: boolean;
  liveWireContinuationText: string;
  pendingSyntheticMessages: PendingSyntheticText[];
  pendingSyntheticThoughts: PendingSyntheticText[];
  syntheticToolSuppressions: Map<string, number>;
  suppressedWireToolIds: Set<string>;
  onContinuationWireActivity?: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_WAKEUP_GRACE_MS = 600_000;
const DEFAULT_LIVE_WIRE_DRAIN_GRACE_MS = 2_000;

const ASYNC_TOOL_NAMES = new Set([
  'invoke_subagent',
  'schedule',
  'run_workflow',
  'swarm',
]);

const NON_BACKGROUND_TOOL_NAMES = new Set([
  'read_file',
  'view_file',
  'edit_file',
  'write_file',
  'write_to_file',
  'replace_file_content',
  'list_dir',
  'list_directory',
  'find_by_name',
  'grep_search',
  'search_web',
  'read_url_content',
  'exit_plan_mode',
  'ask_question',
]);

const BACKGROUND_TEXT_MARKERS = [
  'running as a background task',
  'task logs are available at:',
];

function containsBackgroundMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return BACKGROUND_TEXT_MARKERS.some(marker => lower.includes(marker));
}

function normalizeToolName(name: string | undefined): string {
  if (!name) return '';
  let normalized = name.trim().toLowerCase();
  if (normalized.startsWith('run ')) {
    normalized = normalized.slice(4).trim();
  }
  if (normalized.startsWith('default_api:')) {
    normalized = normalized.slice('default_api:'.length).trim();
  }
  return normalized;
}

function isAsyncToolName(name: string | undefined): boolean {
  const normalized = normalizeToolName(name);
  return normalized.length > 0 && ASYNC_TOOL_NAMES.has(normalized);
}

function isNonBackgroundToolName(name: string | undefined): boolean {
  const normalized = normalizeToolName(name);
  return normalized.length > 0 && NON_BACKGROUND_TOOL_NAMES.has(normalized);
}

function isNonBackgroundWireToolTitle(title: string | undefined): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('file ') || lower.startsWith('diff ')) {
    return true;
  }
  return isNonBackgroundToolName(trimmed);
}

function looksLikeCompletedNonLaunchOutput(text: string): boolean {
  if (!text) return false;
  return (
    text.includes('Command exited with code ')
    || text.includes('\nCommand output:\n')
    || /(?:^|\n)Showing lines \d+-\d+ of \d+/.test(text)
    || /(?:^|\n)Partial read \(lines /.test(text)
    || text.includes("The tool's output was truncated due to being too long.")
  );
}

function resolveAppDataDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.ANTIGRAVITY_APPDATA_DIR?.trim()
    || env.AGY_APPDATA_DIR?.trim()
    || env.ANTIGRAVITY_CLI_DATA_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, '.gemini', 'antigravity-cli');
}

function parseJsonLines(
  filePath: string,
  readFileUtf8: (targetPath: string) => string,
): TranscriptStep[] {
  if (!existsSync(filePath)) {
    return [];
  }
  let raw = '';
  try {
    raw = readFileUtf8(filePath);
  } catch {
    return [];
  }
  const steps: TranscriptStep[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        steps.push(parsed);
      }
    } catch {
      // Ignore partial line while writer is flushing
    }
  }
  return steps;
}

function readHydratedTranscriptSteps(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  state?: SessionTurnState,
  minStepIndexToHydrate = -1,
  readFileUtf8: (filePath: string) => string = filePath => readFileSync(filePath, 'utf8'),
): TranscriptStep[] {
  const logsDir = path.join(resolveAppDataDir(env), 'brain', sessionId, '.system_generated', 'logs');
  const compactPath = path.join(logsDir, 'transcript.jsonl');

  let compactMtimeMs = -1;
  let compactSize = -1;
  try {
    const stats = statSync(compactPath);
    compactMtimeMs = stats.mtimeMs;
    compactSize = stats.size;
  } catch {
    if (state) {
      state.transcriptCache = undefined;
    }
    return [];
  }

  const cached = state?.transcriptCache;
  if (
    cached
    && cached.compactPath === compactPath
    && cached.mtimeMs === compactMtimeMs
    && cached.size === compactSize
    && minStepIndexToHydrate >= cached.hydratedAboveIndex
  ) {
    return cached.steps;
  }

  const compactSteps = parseJsonLines(compactPath, readFileUtf8);
  if (compactSteps.length === 0) {
    if (state) {
      state.transcriptCache = {
        compactPath,
        mtimeMs: compactMtimeMs,
        size: compactSize,
        hydratedAboveIndex: minStepIndexToHydrate,
        steps: [],
      };
    }
    return [];
  }

  const needsFull = compactSteps.some(
    step =>
      typeof step.step_index === 'number'
      && step.step_index > minStepIndexToHydrate
      && step.truncated_fields
      && step.truncated_fields.length > 0,
  );
  if (!needsFull) {
    if (state) {
      state.transcriptCache = {
        compactPath,
        mtimeMs: compactMtimeMs,
        size: compactSize,
        hydratedAboveIndex: minStepIndexToHydrate,
        steps: compactSteps,
      };
    }
    return compactSteps;
  }
  const fullSteps = parseJsonLines(path.join(logsDir, 'transcript_full.jsonl'), readFileUtf8);
  if (fullSteps.length === 0) {
    return compactSteps;
  }
  const byIndex = new Map<number, TranscriptStep>();
  for (const full of fullSteps) {
    if (typeof full.step_index === 'number' && full.step_index > minStepIndexToHydrate) {
      byIndex.set(full.step_index, full);
    }
  }
  const hydrated = compactSteps.map(step => {
    if (
      typeof step.step_index === 'number'
      && step.step_index > minStepIndexToHydrate
      && step.truncated_fields
      && step.truncated_fields.length > 0
    ) {
      return byIndex.get(step.step_index) ?? step;
    }
    return step;
  });
  if (state) {
    state.transcriptCache = {
      compactPath,
      mtimeMs: compactMtimeMs,
      size: compactSize,
      hydratedAboveIndex: minStepIndexToHydrate,
      steps: hydrated,
    };
  }
  return hydrated;
}

function highestStepIndex(steps: ReadonlyArray<TranscriptStep>): number {
  let maxIndex = -1;
  for (const step of steps) {
    if (typeof step.step_index === 'number' && step.step_index > maxIndex) {
      maxIndex = step.step_index;
    }
  }
  return maxIndex;
}

function normalizeComparableText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeToolKey(name: string | undefined): string {
  return (name ?? 'tool').trim().toLowerCase();
}

function consumePendingSyntheticText(
  queue: PendingSyntheticText[],
  incoming: string,
  stripTrailingOnComplete: boolean,
): boolean {
  if (queue.length === 0) {
    return false;
  }
  const head = queue[0];
  const candidate = head.started ? incoming : incoming.replace(/^\s+/, '');
  if (!candidate) {
    return true;
  }
  if (head.remaining.startsWith(candidate)) {
    head.remaining = head.remaining.slice(candidate.length);
    head.started = true;
    if (head.remaining.trim().length === 0) {
      queue.shift();
    }
    return true;
  }
  if (stripTrailingOnComplete) {
    const trimmedEnd = candidate.replace(/\s+$/, '');
    if (trimmedEnd.length > 0 && trimmedEnd === head.remaining) {
      queue.shift();
      return true;
    }
  }
  if (candidate.trim().length > 0 && candidate.trim() === head.remaining.trim()) {
    queue.shift();
    return true;
  }
  return false;
}

function resetContinuationTracking(state: SessionTurnState): void {
  state.inContinuation = false;
  state.sawLiveWireContinuation = false;
  state.liveWireContinuationText = '';
  state.pendingSyntheticMessages = [];
  state.pendingSyntheticThoughts = [];
  state.syntheticToolSuppressions.clear();
  state.suppressedWireToolIds.clear();
  state.onContinuationWireActivity = undefined;
}

function beginContinuationTracking(
  state: SessionTurnState,
  onWireActivity: () => void,
): void {
  resetContinuationTracking(state);
  state.inContinuation = true;
  state.onContinuationWireActivity = onWireActivity;
}

function notificationDedupeKey(notification: AcpSessionNotification): string | null {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case 'agent_thought_chunk':
      return update.content.type === 'text' ? `thought:${update.content.text.trim()}` : null;
    case 'agent_message_chunk':
      return update.content.type === 'text' ? `message:${update.content.text.trim()}` : null;
    case 'tool_call':
      return `tool_call:${update.toolCallId}`;
    case 'tool_call_update':
      return `tool_call_update:${update.toolCallId}:${update.status ?? ''}`;
    default:
      return null;
  }
}

function inspectUnknownText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

function stepSpawnsAsyncWork(step: TranscriptStep): boolean {
  if (step.tool_calls) {
    for (const call of step.tool_calls) {
      if (isAsyncToolName(call.name)) {
        return true;
      }
    }
  }
  if (isUserTranscriptStep(step) || step.type === 'PLANNER_RESPONSE') {
    return false;
  }
  if (
    typeof step.content === 'string'
    && !looksLikeCompletedNonLaunchOutput(step.content)
    && containsBackgroundMarker(step.content)
  ) {
    return true;
  }
  return false;
}

function extractRegexCaptures(text: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const captured = match[1]?.trim();
    if (captured) {
      matches.push(captured);
    }
  }
  return matches;
}

function extractLaunchedBackgroundTaskIds(text: string, sessionId?: string): string[] {
  const matches = extractRegexCaptures(text, /running as a background task with task id:\s*([^\s"'`<>]+)/gi);
  if (!sessionId) {
    return matches;
  }
  return matches.filter(taskId => {
    const slashIdx = taskId.indexOf('/');
    return slashIdx < 0 || taskId.slice(0, slashIdx) === sessionId;
  });
}

function extractCompletedBackgroundTaskIds(text: string): string[] {
  return [
    ...extractRegexCaptures(text, /Task id\s+"([^"]+)"\s+finished/gi),
    ...extractRegexCaptures(text, /\bsender=([^\s"'<>]+\/task-[^\s"'<>]+)/gi),
  ];
}

function isAllBackgroundTasksStoppedNotice(text: string): boolean {
  return /All your subagents and background tasks have been stopped/i.test(text);
}

function isSystemTranscriptStep(step: TranscriptStep): boolean {
  return (
    step.source === 'SYSTEM'
    || step.type === 'SYSTEM_MESSAGE'
    || step.type === 'TASK_NOTIFICATION'
  );
}

function isUserTranscriptStep(step: TranscriptStep): boolean {
  return step.type === 'USER_INPUT' || step.source === 'USER_EXPLICIT';
}

interface ToolResultBackgroundScan {
  readonly launchedIds: string[];
  readonly hasAnonymousBackgroundSignal: boolean;
}

function scanToolResultStepForBackground(
  step: TranscriptStep,
  originToolName: string | undefined,
  sessionId: string,
): ToolResultBackgroundScan {
  const content = typeof step.content === 'string' ? step.content : '';
  const canSpawnBackground =
    !isNonBackgroundToolName(originToolName)
    && !looksLikeCompletedNonLaunchOutput(content);
  if (!canSpawnBackground) {
    return {
      launchedIds: [],
      hasAnonymousBackgroundSignal: step.status === 'RUNNING',
    };
  }
  const launchedIds = extractLaunchedBackgroundTaskIds(content, sessionId);
  const hasAnonymousBackgroundSignal =
    launchedIds.length === 0
    && (step.status === 'RUNNING' || containsBackgroundMarker(content));
  return { launchedIds, hasAnonymousBackgroundSignal };
}

function unwrapTranscriptArgValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  const looksJsonEncoded =
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || trimmed === 'true'
    || trimmed === 'false'
    || trimmed === 'null'
    || /^-?\d+(?:\.\d+)?$/.test(trimmed)
    || (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (!looksJsonEncoded) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed;
  } catch {
    return value;
  }
}

function normalizeTranscriptToolArgs(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!args) {
    return {};
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    normalized[key] = unwrapTranscriptArgValue(value);
  }
  return normalized;
}

function readTaskLogsSignature(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  pendingTaskIds: ReadonlySet<string>,
): string {
  if (pendingTaskIds.size === 0) {
    return '';
  }
  const tasksDir = path.join(resolveAppDataDir(env), 'brain', sessionId, '.system_generated', 'tasks');
  const parts: string[] = [];
  try {
    const dirStats = statSync(tasksDir);
    parts.push(`dir:${dirStats.mtimeMs}:${dirStats.size}`);
  } catch {
    return '';
  }
  for (const taskId of Array.from(pendingTaskIds).sort()) {
    const slashIdx = taskId.lastIndexOf('/');
    const baseName = slashIdx >= 0 ? taskId.slice(slashIdx + 1) : taskId;
    if (!baseName || baseName.includes('..') || path.isAbsolute(baseName)) {
      continue;
    }
    try {
      const stats = statSync(path.join(tasksDir, `${baseName}.log`));
      parts.push(`${baseName}:${stats.mtimeMs}:${stats.size}`);
    } catch {
      // Log file may not exist yet or may have already been removed.
    }
  }
  return parts.join('|');
}

export function createAgyContinuationController(
  resolveEnv: () => NodeJS.ProcessEnv,
  options: AgyContinuationOptions = {},
): AgyContinuationController {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWakeupGraceMs = options.maxWakeupGraceMs ?? DEFAULT_MAX_WAKEUP_GRACE_MS;
  const liveWireDrainGraceMs = options.liveWireDrainGraceMs ?? DEFAULT_LIVE_WIRE_DRAIN_GRACE_MS;
  const delayMs = options.delayMs ?? (ms => delayThroughWindow(ms));
  const nowMs = options.nowMs ?? (() => Date.now());
  const readFileUtf8 = options.readFileUtf8 ?? (filePath => readFileSync(filePath, 'utf8'));
  const sessions = new Map<string, SessionTurnState>();

  const getOrCreateState = (sessionId: string): SessionTurnState => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        lastSeenStepIndex: -1,
        backgroundDetected: false,
        asyncToolIds: new Set(),
        pendingBackgroundTaskIds: new Set(),
        wireTaskIdsByToolCallId: new Map(),
        inFlightWireTools: new Map(),
        seenWireToolIds: new Set(),
        emittedKeys: new Set(),
        inContinuation: false,
        sawLiveWireContinuation: false,
        liveWireContinuationText: '',
        pendingSyntheticMessages: [],
        pendingSyntheticThoughts: [],
        syntheticToolSuppressions: new Map(),
        suppressedWireToolIds: new Set(),
      };
      sessions.set(sessionId, state);
    }
    return state;
  };

  const emitSynthetic = (
    state: SessionTurnState,
    input: AgyContinuationNoteTurnEndedInput,
    notification: AcpSessionNotification,
  ): void => {
    const key = notificationDedupeKey(notification);
    if (key) {
      state.emittedKeys.add(key);
    }
    const update = notification.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      const trimmed = update.content.text.trim();
      if (trimmed) {
        state.pendingSyntheticMessages.push({ remaining: trimmed, started: false });
      }
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
      const trimmed = update.content.text.trim();
      if (trimmed) {
        state.pendingSyntheticThoughts.push({ remaining: trimmed, started: false });
      }
    } else if (update.sessionUpdate === 'tool_call') {
      const toolKey = normalizeToolKey(update.title);
      state.syntheticToolSuppressions.set(
        toolKey,
        (state.syntheticToolSuppressions.get(toolKey) ?? 0) + 1,
      );
    }
    input.presentNotification?.(notification);
  };

  const settleInFlightWireTools = (
    sessionId: string,
    state: SessionTurnState,
    input: AgyContinuationNoteTurnEndedInput,
    onlyToolIds?: ReadonlySet<string>,
  ): void => {
    if (state.inFlightWireTools.size === 0) {
      return;
    }
    const targets = onlyToolIds
      ? Array.from(state.inFlightWireTools.entries()).filter(([toolCallId]) => onlyToolIds.has(toolCallId))
      : Array.from(state.inFlightWireTools.entries());
    for (const [toolCallId, title] of targets) {
      state.inFlightWireTools.delete(toolCallId);
      emitSynthetic(state, input, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          title,
          status: 'completed',
        },
      });
    }
  };

  return {
    clearReplay(sessionId: string): void {
      const state = getOrCreateState(sessionId);
      const steps = readHydratedTranscriptSteps(
        resolveEnv(),
        sessionId,
        state,
        Number.MAX_SAFE_INTEGER,
        readFileUtf8,
      );
      state.lastSeenStepIndex = highestStepIndex(steps);
      state.backgroundDetected = false;
      state.asyncToolIds.clear();
      state.pendingBackgroundTaskIds.clear();
      state.wireTaskIdsByToolCallId.clear();
      state.inFlightWireTools.clear();
      state.seenWireToolIds.clear();
      state.emittedKeys.clear();
      resetContinuationTracking(state);
      state.transcriptCache = undefined;
    },

    notePromptStarted(sessionId: string): void {
      const state = getOrCreateState(sessionId);
      const steps = readHydratedTranscriptSteps(
        resolveEnv(),
        sessionId,
        state,
        state.lastSeenStepIndex,
        readFileUtf8,
      );
      state.lastSeenStepIndex = Math.max(state.lastSeenStepIndex, highestStepIndex(steps));
      state.backgroundDetected = false;
      state.asyncToolIds.clear();
      state.pendingBackgroundTaskIds.clear();
      state.wireTaskIdsByToolCallId.clear();
      state.inFlightWireTools.clear();
      state.seenWireToolIds.clear();
      state.emittedKeys.clear();
      resetContinuationTracking(state);
    },

    filterNotification(notification: AcpSessionNotification): boolean {
      const state = getOrCreateState(notification.sessionId);
      const update = notification.update;
      const isWireActivityUpdate =
        update.sessionUpdate === 'agent_message_chunk'
        || update.sessionUpdate === 'agent_thought_chunk'
        || update.sessionUpdate === 'tool_call'
        || update.sessionUpdate === 'tool_call_update';

      if (state.inContinuation && isWireActivityUpdate) {
        state.sawLiveWireContinuation = true;
        state.onContinuationWireActivity?.();
      }

      const key = notificationDedupeKey(notification);

      if (update.sessionUpdate === 'tool_call') {
        if (key && state.emittedKeys.has(key)) {
          state.emittedKeys.delete(key);
          return false;
        }
        const toolKey = normalizeToolKey(update.title);
        const pendingCount = state.syntheticToolSuppressions.get(toolKey) ?? 0;
        if (pendingCount > 0) {
          if (pendingCount === 1) {
            state.syntheticToolSuppressions.delete(toolKey);
          } else {
            state.syntheticToolSuppressions.set(toolKey, pendingCount - 1);
          }
          state.suppressedWireToolIds.add(update.toolCallId);
          state.seenWireToolIds.add(update.toolCallId);
          return false;
        }
      } else if (update.sessionUpdate === 'tool_call_update') {
        if (state.suppressedWireToolIds.has(update.toolCallId)) {
          if (update.status === 'completed' || update.status === 'failed') {
            state.suppressedWireToolIds.delete(update.toolCallId);
          }
          return false;
        }
        if (key && state.emittedKeys.has(key)) {
          state.emittedKeys.delete(key);
          return false;
        }
      } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
        if (consumePendingSyntheticText(state.pendingSyntheticThoughts, update.content.text, true)) {
          if (key) {
            state.emittedKeys.delete(key);
          }
          return false;
        }
        if (key && state.emittedKeys.has(key)) {
          state.emittedKeys.delete(key);
          return false;
        }
      } else if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        if (consumePendingSyntheticText(state.pendingSyntheticMessages, update.content.text, true)) {
          if (key) {
            state.emittedKeys.delete(key);
          }
          return false;
        }
        if (key && state.emittedKeys.has(key)) {
          state.emittedKeys.delete(key);
          return false;
        }
        if (state.inContinuation) {
          state.liveWireContinuationText += update.content.text;
        }
      } else if (key && state.emittedKeys.has(key)) {
        state.emittedKeys.delete(key);
        return false;
      }

      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        state.seenWireToolIds.add(update.toolCallId);
        const effectiveTitle = update.title ?? state.inFlightWireTools.get(update.toolCallId);
        const title = update.title ?? 'tool';
        if (update.sessionUpdate === 'tool_call') {
          if (update.status === 'completed' || update.status === 'failed') {
            state.inFlightWireTools.delete(update.toolCallId);
          } else {
            state.inFlightWireTools.set(update.toolCallId, title);
          }
        } else if (update.status === 'completed' || update.status === 'failed') {
          state.inFlightWireTools.delete(update.toolCallId);
        } else if (update.title && state.inFlightWireTools.has(update.toolCallId)) {
          state.inFlightWireTools.set(update.toolCallId, title);
        }

        const resultBlob = [
          inspectUnknownText(update.rawOutput),
          update.content ? inspectUnknownText(update.content) : '',
        ].join('\n');
        if (
          (update.status === 'completed' || update.status === 'failed')
          && looksLikeCompletedNonLaunchOutput(resultBlob)
        ) {
          const trackedIds = state.wireTaskIdsByToolCallId.get(update.toolCallId);
          if (trackedIds) {
            for (const trackedId of trackedIds) {
              state.pendingBackgroundTaskIds.delete(trackedId);
            }
            state.wireTaskIdsByToolCallId.delete(update.toolCallId);
          }
        }
        if (isAsyncToolName(effectiveTitle)) {
          state.backgroundDetected = true;
          state.asyncToolIds.add(update.toolCallId);
        } else if (
          !isNonBackgroundWireToolTitle(effectiveTitle)
          && !looksLikeCompletedNonLaunchOutput(resultBlob)
        ) {
          const launchedIds = extractLaunchedBackgroundTaskIds(resultBlob, notification.sessionId);
          if (launchedIds.length > 0) {
            let tracked = state.wireTaskIdsByToolCallId.get(update.toolCallId);
            if (!tracked) {
              tracked = new Set();
              state.wireTaskIdsByToolCallId.set(update.toolCallId, tracked);
            }
            for (const launchedId of launchedIds) {
              state.pendingBackgroundTaskIds.add(launchedId);
              tracked.add(launchedId);
            }
          } else if (containsBackgroundMarker(resultBlob)) {
            state.backgroundDetected = true;
            state.asyncToolIds.add(update.toolCallId);
          }
        }
      }

      return true;
    },

    async noteTurnEnded(input: AgyContinuationNoteTurnEndedInput): Promise<void> {
      const sessionId = input.nativeSessionRef;
      const state = getOrCreateState(sessionId);
      const output = input.output ?? '';
      const env = resolveEnv();
      const initialSteps = readHydratedTranscriptSteps(
        env,
        sessionId,
        state,
        state.lastSeenStepIndex,
        readFileUtf8,
      );
      const initialUnseen = initialSteps
        .filter(step => typeof step.step_index === 'number' && step.step_index > state.lastSeenStepIndex)
        .sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0));

      let pendingToolNames: string[] = [];
      let pendingAnonymousAsyncCount = 0;
      let hasUnresolvedRunningStep = false;
      let sawSystemCompletion = false;
      let lastStepWasSettledPlannerResponse = false;

      for (const step of initialUnseen) {
        if (isSystemTranscriptStep(step)) {
          sawSystemCompletion = true;
          hasUnresolvedRunningStep = false;
          lastStepWasSettledPlannerResponse = false;
          pendingToolNames = [];
          const stepContent = typeof step.content === 'string' ? step.content : '';
          const completedIds = extractCompletedBackgroundTaskIds(stepContent);
          for (const completedId of completedIds) {
            state.pendingBackgroundTaskIds.delete(completedId);
          }
          if (isAllBackgroundTasksStoppedNotice(stepContent)) {
            state.pendingBackgroundTaskIds.clear();
            pendingAnonymousAsyncCount = 0;
          } else if (completedIds.length === 0 && pendingAnonymousAsyncCount > 0) {
            pendingAnonymousAsyncCount -= 1;
          }
          continue;
        }
        if (isUserTranscriptStep(step)) {
          lastStepWasSettledPlannerResponse = false;
          pendingToolNames = [];
          continue;
        }
        if (step.type === 'PLANNER_RESPONSE') {
          pendingToolNames = (step.tool_calls ?? []).map(call => (call.name ?? '').trim().toLowerCase());
          const asyncCalls = (step.tool_calls ?? []).filter(call => isAsyncToolName(call.name)).length;
          if (asyncCalls > 0) {
            pendingAnonymousAsyncCount += asyncCalls;
            lastStepWasSettledPlannerResponse = false;
          } else if ((step.tool_calls?.length ?? 0) === 0 && (step.status === 'DONE' || step.status === 'ERROR')) {
            lastStepWasSettledPlannerResponse = true;
          } else {
            lastStepWasSettledPlannerResponse = false;
          }
          continue;
        }
        lastStepWasSettledPlannerResponse = false;
        const originToolName = pendingToolNames.shift();
        const scan = scanToolResultStepForBackground(step, originToolName, sessionId);
        for (const launchedId of scan.launchedIds) {
          state.pendingBackgroundTaskIds.add(launchedId);
        }
        if (scan.hasAnonymousBackgroundSignal) {
          hasUnresolvedRunningStep = true;
        }
      }

      if (
        sawSystemCompletion
        && lastStepWasSettledPlannerResponse
        && state.pendingBackgroundTaskIds.size === 0
        && pendingAnonymousAsyncCount === 0
        && !hasUnresolvedRunningStep
      ) {
        state.backgroundDetected = false;
        state.asyncToolIds.clear();
      }

      const pendingInTranscript = pendingAnonymousAsyncCount > 0 || hasUnresolvedRunningStep;
      const outputFallback = initialUnseen.length === 0 && containsBackgroundMarker(output);
      const hasBackgroundWork =
        state.backgroundDetected
        || state.asyncToolIds.size > 0
        || state.pendingBackgroundTaskIds.size > 0
        || outputFallback
        || pendingInTranscript;

      if (!hasBackgroundWork) {
        state.lastSeenStepIndex = Math.max(state.lastSeenStepIndex, highestStepIndex(initialSteps));
        return;
      }

      // Track where the triggering turn ended so we wait for a subsequent wakeup step.
      const triggerTurnMaxIndex = Math.max(state.lastSeenStepIndex, highestStepIndex(initialSteps));
      const foregroundInFlightToolIds = new Set(state.inFlightWireTools.keys());
      let lastActivityAt = nowMs();
      let cycleSpawnedAsyncWork = state.pendingBackgroundTaskIds.size > 0;
      let lastTaskLogsSignature = '';
      let settledWireTools = false;
      let pendingCompletionContent: string | null = null;
      let completionSeenAt: number | null = null;
      let wakeupPendingToolNames: string[] = [];

      beginContinuationTracking(state, () => {
        lastActivityAt = nowMs();
        input.noteActivity?.();
      });

      try {
        while (!input.isCancelled?.()) {
          const currentEnv = resolveEnv();
          const taskLogsSignature = readTaskLogsSignature(
            currentEnv,
            sessionId,
            state.pendingBackgroundTaskIds,
          );
          if (taskLogsSignature && taskLogsSignature !== lastTaskLogsSignature) {
            lastTaskLogsSignature = taskLogsSignature;
            input.noteActivity?.();
            lastActivityAt = nowMs();
          }

          const steps = readHydratedTranscriptSteps(
            currentEnv,
            sessionId,
            state,
            state.lastSeenStepIndex,
            readFileUtf8,
          );
          const newSteps = steps
            .filter(
              step => typeof step.step_index === 'number' && step.step_index > state.lastSeenStepIndex,
            )
            .sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0));

          let sawWakeupCompletion = false;

          for (const step of newSteps) {
            const stepIndex = step.step_index ?? state.lastSeenStepIndex;
            state.lastSeenStepIndex = Math.max(state.lastSeenStepIndex, stepIndex);

            const isAfterInitialTrigger = stepIndex > triggerTurnMaxIndex;
            if (!isAfterInitialTrigger) {
              continue;
            }

            if (!settledWireTools) {
              settledWireTools = true;
              settleInFlightWireTools(sessionId, state, input, foregroundInFlightToolIds);
            }

            input.noteActivity?.();
            lastActivityAt = nowMs();

            const isSystem = isSystemTranscriptStep(step);
            if (isSystem) {
              wakeupPendingToolNames = [];
              cycleSpawnedAsyncWork = false;
              if (typeof step.content === 'string') {
                for (const completedId of extractCompletedBackgroundTaskIds(step.content)) {
                  state.pendingBackgroundTaskIds.delete(completedId);
                }
                if (isAllBackgroundTasksStoppedNotice(step.content)) {
                  state.pendingBackgroundTaskIds.clear();
                }
              }
              sawWakeupCompletion = false;
              pendingCompletionContent = null;
              completionSeenAt = null;
              continue;
            }

            if (isUserTranscriptStep(step)) {
              wakeupPendingToolNames = [];
              continue;
            }

            if (step.type === 'PLANNER_RESPONSE') {
              wakeupPendingToolNames = (step.tool_calls ?? []).map(call => (call.name ?? '').trim().toLowerCase());
              if (step.status === 'RUNNING' || stepSpawnsAsyncWork(step)) {
                cycleSpawnedAsyncWork = true;
                sawWakeupCompletion = false;
                pendingCompletionContent = null;
                completionSeenAt = null;
              }
              const suppressSynthetic = state.sawLiveWireContinuation;

              if (!suppressSynthetic) {
                const thinking = step.thinking?.trim();
                if (thinking) {
                  emitSynthetic(state, input, {
                    sessionId,
                    update: {
                      sessionUpdate: 'agent_thought_chunk',
                      content: { type: 'text', text: thinking },
                    },
                  });
                }

                if (step.tool_calls) {
                  step.tool_calls.forEach((call, callIndex) => {
                    const callId = call.call_id || call.id || `${stepIndex}:${callIndex}:${call.name ?? 'tool'}`;
                    if (state.seenWireToolIds.has(callId)) {
                      return;
                    }
                    const title = call.name ?? 'tool';
                    const normalizedArgs = normalizeTranscriptToolArgs(call.args);
                    emitSynthetic(state, input, {
                      sessionId,
                      update: {
                        sessionUpdate: 'tool_call',
                        toolCallId: callId,
                        title,
                        status: 'pending',
                        rawInput: normalizedArgs,
                      },
                    });
                    const status: AcpToolCallStatus = step.status === 'ERROR' ? 'failed' : 'completed';
                    emitSynthetic(state, input, {
                      sessionId,
                      update: {
                        sessionUpdate: 'tool_call_update',
                        toolCallId: callId,
                        title,
                        status,
                        rawInput: normalizedArgs,
                      },
                    });
                  });
                }
              }

              const content = step.content?.trim();
              if (content && !suppressSynthetic) {
                emitSynthetic(state, input, {
                  sessionId,
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: content },
                  },
                });
              }

              const hasToolCalls = Boolean(step.tool_calls && step.tool_calls.length > 0);
              if (
                hasToolCalls
                || stepSpawnsAsyncWork(step)
                || cycleSpawnedAsyncWork
                || state.pendingBackgroundTaskIds.size > 0
              ) {
                sawWakeupCompletion = false;
                pendingCompletionContent = null;
                completionSeenAt = null;
              } else if (step.status === 'DONE' || step.status === 'ERROR') {
                sawWakeupCompletion = true;
                pendingCompletionContent = content ?? '';
                completionSeenAt ??= nowMs();
              }
              continue;
            }

            const originToolName = wakeupPendingToolNames.shift();
            const scan = scanToolResultStepForBackground(step, originToolName, sessionId);
            if (scan.launchedIds.length > 0) {
              for (const launchedId of scan.launchedIds) {
                state.pendingBackgroundTaskIds.add(launchedId);
              }
              cycleSpawnedAsyncWork = true;
              sawWakeupCompletion = false;
              pendingCompletionContent = null;
              completionSeenAt = null;
            } else if (scan.hasAnonymousBackgroundSignal) {
              cycleSpawnedAsyncWork = true;
              sawWakeupCompletion = false;
              pendingCompletionContent = null;
              completionSeenAt = null;
            }
          }

          if (sawWakeupCompletion || completionSeenAt !== null) {
            if (!state.sawLiveWireContinuation) {
              return;
            }
            const expected = normalizeComparableText(pendingCompletionContent ?? '');
            const observed = normalizeComparableText(state.liveWireContinuationText);
            if (!expected || observed.includes(expected)) {
              return;
            }
            if (nowMs() - (completionSeenAt ?? nowMs()) >= liveWireDrainGraceMs) {
              if (state.liveWireContinuationText.trim().length === 0 && pendingCompletionContent) {
                emitSynthetic(state, input, {
                  sessionId,
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: pendingCompletionContent },
                  },
                });
              }
              return;
            }
          }
          if (nowMs() - lastActivityAt >= maxWakeupGraceMs) {
            return;
          }
          await delayMs(pollIntervalMs);
        }
      } finally {
        state.inContinuation = false;
        state.onContinuationWireActivity = undefined;
        settleInFlightWireTools(sessionId, state, input);
      }
    },
  };
}
