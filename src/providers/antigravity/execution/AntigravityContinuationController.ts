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

interface SessionTurnState {
  lastSeenStepIndex: number;
  backgroundDetected: boolean;
  asyncToolIds: Set<string>;
  pendingBackgroundTaskIds: Set<string>;
  inFlightWireTools: Map<string, string>;
  seenWireToolIds: Set<string>;
  emittedKeys: Set<string>;
  transcriptCache?: TranscriptCacheEntry;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_WAKEUP_GRACE_MS = 600_000;

const ASYNC_TOOL_NAMES = new Set([
  'invoke_subagent',
  'schedule',
  'run_workflow',
  'swarm',
]);

const BACKGROUND_TEXT_MARKERS = [
  'running as a background task',
  'task logs are available at:',
  'launches asynchronously',
  'runs in the background',
];

function containsBackgroundMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return BACKGROUND_TEXT_MARKERS.some(marker => lower.includes(marker));
}

function isAsyncToolName(name: string | undefined): boolean {
  if (!name) return false;
  const normalized = name.trim().toLowerCase();
  return ASYNC_TOOL_NAMES.has(normalized)
    || Array.from(ASYNC_TOOL_NAMES).some(candidate => normalized.includes(candidate));
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

function notificationDedupeKey(notification: AcpSessionNotification): string | null {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case 'agent_thought_chunk':
      return update.content.type === 'text' ? `thought:${update.content.text}` : null;
    case 'agent_message_chunk':
      return update.content.type === 'text' ? `message:${update.content.text}` : null;
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
      if (call.name === 'run_command' && inspectUnknownText(call.args).includes('WaitMsBeforeAsync')) {
        // A run_command step only proves async background continuation if output or live stream says so
        continue;
      }
    }
  }
  if (typeof step.content === 'string' && containsBackgroundMarker(step.content)) {
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

function extractLaunchedBackgroundTaskIds(text: string): string[] {
  return extractRegexCaptures(text, /running as a background task with task id:\s*([^\s"']+)/gi);
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
        inFlightWireTools: new Map(),
        seenWireToolIds: new Set(),
        emittedKeys: new Set(),
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
    input.presentNotification?.(notification);
  };

  const settleInFlightWireTools = (
    sessionId: string,
    state: SessionTurnState,
    input: AgyContinuationNoteTurnEndedInput,
  ): void => {
    if (state.inFlightWireTools.size === 0) {
      return;
    }
    for (const [toolCallId, title] of state.inFlightWireTools) {
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
    state.inFlightWireTools.clear();
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
      state.inFlightWireTools.clear();
      state.seenWireToolIds.clear();
      state.emittedKeys.clear();
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
      state.inFlightWireTools.clear();
      state.seenWireToolIds.clear();
    },

    filterNotification(notification: AcpSessionNotification): boolean {
      const state = getOrCreateState(notification.sessionId);
      const key = notificationDedupeKey(notification);
      if (key && state.emittedKeys.has(key)) {
        state.emittedKeys.delete(key);
        return false;
      }

      const update = notification.update;
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        state.seenWireToolIds.add(update.toolCallId);
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

        const textBlob = [
          update.title ?? '',
          inspectUnknownText(update.rawInput),
          inspectUnknownText(update.rawOutput),
          update.content ? inspectUnknownText(update.content) : '',
        ].join('\n');
        const launchedIds = extractLaunchedBackgroundTaskIds(textBlob);
        for (const launchedId of launchedIds) {
          state.pendingBackgroundTaskIds.add(launchedId);
          state.backgroundDetected = true;
          state.asyncToolIds.add(update.toolCallId);
        }
        if (isAsyncToolName(update.title ?? '') || containsBackgroundMarker(textBlob)) {
          state.backgroundDetected = true;
          state.asyncToolIds.add(update.toolCallId);
        }
      } else if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        for (const launchedId of extractLaunchedBackgroundTaskIds(update.content.text)) {
          state.pendingBackgroundTaskIds.add(launchedId);
          state.backgroundDetected = true;
        }
        if (containsBackgroundMarker(update.content.text)) {
          state.backgroundDetected = true;
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

      let pendingInTranscript = false;
      for (const step of initialUnseen) {
        const isSystem = isSystemTranscriptStep(step);
        if (typeof step.content === 'string') {
          if (isSystem) {
            for (const completedId of extractCompletedBackgroundTaskIds(step.content)) {
              state.pendingBackgroundTaskIds.delete(completedId);
            }
            if (isAllBackgroundTasksStoppedNotice(step.content)) {
              state.pendingBackgroundTaskIds.clear();
            }
          } else {
            for (const launchedId of extractLaunchedBackgroundTaskIds(step.content)) {
              state.pendingBackgroundTaskIds.add(launchedId);
            }
          }
        }
        if (!isSystem && (step.status === 'RUNNING' || stepSpawnsAsyncWork(step))) {
          pendingInTranscript = true;
        }
      }

      const hasBackgroundWork =
        state.backgroundDetected
        || state.asyncToolIds.size > 0
        || state.pendingBackgroundTaskIds.size > 0
        || containsBackgroundMarker(output)
        || pendingInTranscript;

      if (!hasBackgroundWork) {
        state.lastSeenStepIndex = Math.max(state.lastSeenStepIndex, highestStepIndex(initialSteps));
        return;
      }

      // Track where the triggering turn ended so we wait for a subsequent wakeup step.
      const triggerTurnMaxIndex = Math.max(state.lastSeenStepIndex, highestStepIndex(initialSteps));
      let lastActivityAt = nowMs();
      let cycleSpawnedAsyncWork = state.pendingBackgroundTaskIds.size > 0;
      let lastTaskLogsSignature = '';
      let settledWireTools = false;

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
              settleInFlightWireTools(sessionId, state, input);
            }

            input.noteActivity?.();
            lastActivityAt = nowMs();

            const isSystem = isSystemTranscriptStep(step);
            if (isSystem) {
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
            }

            if (!isSystem && typeof step.content === 'string') {
              const launchedIds = extractLaunchedBackgroundTaskIds(step.content);
              if (launchedIds.length > 0) {
                for (const launchedId of launchedIds) {
                  state.pendingBackgroundTaskIds.add(launchedId);
                }
                cycleSpawnedAsyncWork = true;
              }
            }

            if (!isSystem && (step.status === 'RUNNING' || stepSpawnsAsyncWork(step))) {
              cycleSpawnedAsyncWork = true;
              sawWakeupCompletion = false;
            }

            if (step.type === 'PLANNER_RESPONSE') {
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

              const content = step.content?.trim();
              if (content) {
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
              } else if (step.status === 'DONE' || step.status === 'ERROR') {
                sawWakeupCompletion = true;
              }
            } else if (!isSystem) {
              if (typeof step.content === 'string' && containsBackgroundMarker(step.content)) {
                cycleSpawnedAsyncWork = true;
                sawWakeupCompletion = false;
              }
            }
          }

          if (sawWakeupCompletion) {
            return;
          }
          if (nowMs() - lastActivityAt >= maxWakeupGraceMs) {
            return;
          }
          await delayMs(pollIntervalMs);
        }
      } finally {
        settleInFlightWireTools(sessionId, state, input);
      }
    },
  };
}
