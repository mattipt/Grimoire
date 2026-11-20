import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AcpSessionNotification } from '@/providers/acp/types';
import { createAgyContinuationController } from '@/providers/antigravity/execution/AntigravityContinuationController';

function createTempBrainRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'grimoire-agy-cont-'));
}

function writeTranscript(
  appDataDir: string,
  sessionId: string,
  compactLines: Record<string, unknown>[],
  fullLines?: Record<string, unknown>[],
): void {
  const logsDir = path.join(appDataDir, 'brain', sessionId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    path.join(logsDir, 'transcript.jsonl'),
    compactLines.map(entry => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );
  if (fullLines) {
    writeFileSync(
      path.join(logsDir, 'transcript_full.jsonl'),
      fullLines.map(entry => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );
  }
}

describe('AntigravityContinuationController', () => {
  const createdRoots: string[] = [];

  afterEach(() => {
    while (createdRoots.length > 0) {
      const root = createdRoots.pop()!;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns immediately when a turn has no background work', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    writeTranscript(appDataDir, 'session-1', [
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'hi' },
      { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'hello' },
    ]);

    const delayMs = jest.fn(async () => {});
    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      { delayMs },
    );

    const presented: AcpSessionNotification[] = [];
    await controller.noteTurnEnded({
      nativeSessionRef: 'session-1',
      output: 'hello',
      presentContent: jest.fn(),
      presentNotification: n => presented.push(n),
    });

    expect(delayMs).not.toHaveBeenCalled();
    expect(presented).toEqual([]);
  });

  it('polls background task continuation and hydrates truncated transcript steps without duplicates', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    const sessionId = 'session-bg';

    // Initial prompt launched a background run_command and returned intermediate text.
    writeTranscript(appDataDir, sessionId, [
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'run tests' },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'tc-1', name: 'run_command', args: { WaitMsBeforeAsync: 500 } }],
        content: 'Started background check.',
      },
    ]);

    let pollTick = 0;
    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      {
        pollIntervalMs: 10,
        maxWakeupGraceMs: 5_000,
        delayMs: async () => {
          pollTick += 1;
          if (pollTick === 2) {
            writeTranscript(
              appDataDir,
              sessionId,
              [
                { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'run tests' },
                {
                  step_index: 2,
                  type: 'PLANNER_RESPONSE',
                  status: 'DONE',
                  tool_calls: [{ id: 'tc-1', name: 'run_command', args: { WaitMsBeforeAsync: 500 } }],
                  content: 'Started background check.',
                },
                { step_index: 3, source: 'SYSTEM', type: 'TASK_NOTIFICATION', status: 'DONE' },
                {
                  step_index: 4,
                  type: 'PLANNER_RESPONSE',
                  status: 'DONE',
                  thinking: 'truncated',
                  truncated_fields: ['thinking', 'content'],
                  tool_calls: [{ id: 'tc-2', name: 'read_file', args: { Path: '/tmp/out' } }],
                  content: 'truncated',
                },
              ],
              [
                {
                  step_index: 4,
                  type: 'PLANNER_RESPONSE',
                  status: 'DONE',
                  thinking: 'Checking final test results.',
                  tool_calls: [{ id: 'tc-2', name: 'read_file', args: { Path: '/tmp/out' } }],
                  content: 'All 42 tests passed.',
                },
              ],
            );
          }
        },
      },
    );

    controller.notePromptStarted(sessionId);
    // Simulate live ACP update signaling background task
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        title: 'run_command',
        status: 'completed',
        rawOutput: 'Tool is running as a background task with task id: session-bg/task-1',
      },
    })).toBe(true);

    const presented: AcpSessionNotification[] = [];
    const noteActivity = jest.fn();

    await controller.noteTurnEnded({
      nativeSessionRef: sessionId,
      output: 'Started background check.',
      presentContent: jest.fn(),
      presentNotification: n => presented.push(n),
      noteActivity,
      isCancelled: () => false,
    });

    expect(noteActivity).toHaveBeenCalled();
    expect(presented.map(item => item.update.sessionUpdate)).toEqual([
      'agent_thought_chunk',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
    ]);
    expect(presented[0].update).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Checking final test results.' },
    });
    expect(presented[3].update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'All 42 tests passed.' },
    });

    // If ACP also forwards the same final message chunk, filterNotification drops the duplicate once.
    expect(controller.filterNotification(presented[3])).toBe(false);
  });

  it('stops polling immediately when cancelled or after wakeup grace expires', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    const sessionId = 'session-cancel';
    let fakeNow = 1000;
    let cancelled = false;

    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      {
        pollIntervalMs: 100,
        maxWakeupGraceMs: 500,
        nowMs: () => fakeNow,
        delayMs: async ms => {
          fakeNow += ms;
          if (fakeNow >= 1200) {
            cancelled = true;
          }
        },
      },
    );

    controller.notePromptStarted(sessionId);
    await controller.noteTurnEnded({
      nativeSessionRef: sessionId,
      output: 'Task logs are available at: /tmp/task-9.log',
      presentContent: jest.fn(),
      isCancelled: () => cancelled,
    });

    expect(cancelled).toBe(true);
    expect(fakeNow).toBe(1200);
  });

  it('ignores historical transcript steps during loadSession replay', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    const sessionId = 'session-replay';

    writeTranscript(appDataDir, sessionId, [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'old-subagent', name: 'invoke_subagent' }],
        content: 'Tool is running as a background task.',
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Previously completed.',
      },
    ]);

    const delayMs = jest.fn(async () => {});
    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      { delayMs },
    );

    controller.clearReplay(sessionId);
    controller.notePromptStarted(sessionId);

    await controller.noteTurnEnded({
      nativeSessionRef: sessionId,
      output: 'Normal answer.',
      presentContent: jest.fn(),
    });

    expect(delayMs).not.toHaveBeenCalled();
  });

  it('skips re-parsing unchanged transcripts and skips full hydration for historical truncated steps', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    const sessionId = 'session-cache';

    writeTranscript(
      appDataDir,
      sessionId,
      [
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          truncated_fields: ['content'],
          content: 'truncated-old',
        },
      ],
      [
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: 'Old giant payload.',
        },
      ],
    );

    const readSpy = jest.fn((filePath: string) => readFileSync(filePath, 'utf8'));

    let ticks = 0;
    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      {
        pollIntervalMs: 5,
        maxWakeupGraceMs: 500,
        readFileUtf8: readSpy,
        delayMs: async () => {
          ticks += 1;
          if (ticks === 4) {
            writeTranscript(appDataDir, sessionId, [
              {
                step_index: 1,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                truncated_fields: ['content'],
                content: 'truncated-old',
              },
              {
                step_index: 2,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [{ id: 'tc-bg', name: 'invoke_subagent' }],
                content: 'Running subagent.',
              },
              {
                step_index: 3,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                content: 'Wakeup done.',
              },
            ]);
          }
        },
      },
    );

    controller.notePromptStarted(sessionId);
    writeTranscript(appDataDir, sessionId, [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        truncated_fields: ['content'],
        content: 'truncated-old',
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'tc-bg', name: 'invoke_subagent' }],
        content: 'Running subagent.',
      },
    ]);
    readSpy.mockClear();

    try {
      const presented: AcpSessionNotification[] = [];
      await controller.noteTurnEnded({
        nativeSessionRef: sessionId,
        output: 'Running subagent.',
        presentContent: jest.fn(),
        presentNotification: n => presented.push(n),
      });

      // Even though step 1 had truncated_fields, transcript_full.jsonl was never read
      // because step 1 was already seen/historical, and ticks 1..3 reused stat cache.
      const readTargets = readSpy.mock.calls.map(call => String(call[0]));
      expect(readTargets.some(target => target.endsWith('transcript_full.jsonl'))).toBe(false);
      expect(readTargets.filter(target => target.endsWith('transcript.jsonl'))).toHaveLength(2);
      expect(presented.some(n => (
        n.update.sessionUpdate === 'agent_message_chunk'
        && n.update.content.type === 'text'
        && n.update.content.text === 'Wakeup done.'
      ))).toBe(true);
    } finally {
      readSpy.mockClear();
    }
  });

  it('continues polling when a wakeup turn spawns a chained background run_command', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    const sessionId = 'session-chained-bg';

    writeTranscript(appDataDir, sessionId, [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'tc-1', name: 'invoke_subagent' }],
        content: 'Subagent started.',
      },
    ]);

    let tick = 0;
    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      {
        pollIntervalMs: 5,
        maxWakeupGraceMs: 2_000,
        delayMs: async () => {
          tick += 1;
          if (tick === 1) {
            writeTranscript(appDataDir, sessionId, [
              {
                step_index: 1,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [{ id: 'tc-1', name: 'invoke_subagent' }],
                content: 'Subagent started.',
              },
              {
                step_index: 2,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [{ id: 'tc-2', name: 'run_command', args: { WaitMsBeforeAsync: 500 } }],
                content: 'Launching follow-up job.',
              },
              {
                step_index: 3,
                type: 'TOOL_RESULT',
                status: 'DONE',
                content: 'Command is running as a background task with task id: session-chained-bg/task-2',
              },
            ]);
          } else if (tick === 3) {
            writeTranscript(appDataDir, sessionId, [
              {
                step_index: 1,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [{ id: 'tc-1', name: 'invoke_subagent' }],
                content: 'Subagent started.',
              },
              {
                step_index: 2,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [{ id: 'tc-2', name: 'run_command', args: { WaitMsBeforeAsync: 500 } }],
                content: 'Launching follow-up job.',
              },
              {
                step_index: 3,
                type: 'TOOL_RESULT',
                status: 'DONE',
                content: 'Command is running as a background task with task id: session-chained-bg/task-2',
              },
              {
                step_index: 4,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                content: 'All chained jobs completed.',
              },
            ]);
          }
        },
      },
    );

    const presented: AcpSessionNotification[] = [];
    await controller.noteTurnEnded({
      nativeSessionRef: sessionId,
      output: 'Subagent started.',
      presentContent: jest.fn(),
      presentNotification: n => presented.push(n),
    });

    expect(presented.some(n => (
      n.update.sessionUpdate === 'agent_message_chunk'
      && n.update.content.type === 'text'
      && n.update.content.text === 'All chained jobs completed.'
    ))).toBe(true);
  });

  it('waits across PLANNER_RESPONSE tool_calls, settles in-flight wire tools, unwraps JSON args, and waits on pending task IDs', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    const sessionId = 'session-1';

    const priorStep = {
      step_index: 245,
      type: 'USER_INPUT',
      status: 'DONE',
      content: 'Proceed with changes.',
    };
    const initialSteps: Record<string, unknown>[] = [
      priorStep,
      {
        step_index: 246,
        type: 'GENERIC',
        status: 'RUNNING',
        content: 'Tool is running as a background task with task id: session-1/task-246',
      },
      {
        step_index: 247,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Running typecheck...',
      },
    ];
    writeTranscript(appDataDir, sessionId, [priorStep]);

    const presented: AcpSessionNotification[] = [];
    let tick = 0;
    let settledWireBeforeTask251 = false;
    let unwrappedArgsSeenBeforeTask251 = false;
    let waitedThroughStep252 = false;

    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      {
        pollIntervalMs: 5,
        maxWakeupGraceMs: 2_000,
        delayMs: async () => {
          tick += 1;
          if (tick === 1) {
            writeTranscript(appDataDir, sessionId, [
              ...initialSteps,
              {
                step_index: 248,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                content: 'Task id "session-1/task-246" finished with result: exit 1',
              },
              {
                step_index: 249,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [
                  {
                    name: 'edit_file',
                    args: {
                      Path: JSON.stringify('/repo/src/utils/fileLink.ts'),
                      Target: JSON.stringify('old'),
                      Replacement: JSON.stringify('new'),
                    },
                  },
                  {
                    name: 'run_command',
                    args: {
                      CommandLine: JSON.stringify('npm run typecheck\nnpm run lint'),
                      WaitMsBeforeAsync: '10000',
                    },
                  },
                ],
              },
            ]);
          } else if (tick === 2) {
            // Note: step 249 had status: 'DONE' and non-empty tool_calls before steps 250/251 existed.
            // Reaching tick === 2 proves noteTurnEnded did not exit prematurely on step 249.
            settledWireBeforeTask251 = presented.some(n => (
              n.update.sessionUpdate === 'tool_call_update'
              && n.update.toolCallId === 'wire-cmd-1'
              && n.update.status === 'completed'
            ));
            const editToolCall = presented.find(n => (
              n.update.sessionUpdate === 'tool_call'
              && n.update.title === 'edit_file'
            ));
            const bashToolCall = presented.find(n => (
              n.update.sessionUpdate === 'tool_call'
              && n.update.title === 'run_command'
            ));
            unwrappedArgsSeenBeforeTask251 = Boolean(
              editToolCall?.update.sessionUpdate === 'tool_call'
              && (editToolCall.update.rawInput as Record<string, unknown>)?.Path === '/repo/src/utils/fileLink.ts'
              && bashToolCall?.update.sessionUpdate === 'tool_call'
              && (bashToolCall.update.rawInput as Record<string, unknown>)?.CommandLine === 'npm run typecheck\nnpm run lint',
            );

            writeTranscript(appDataDir, sessionId, [
              ...initialSteps,
              {
                step_index: 248,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                content: 'Task id "session-1/task-246" finished with result: exit 1',
              },
              {
                step_index: 249,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [
                  {
                    name: 'edit_file',
                    args: {
                      Path: JSON.stringify('/repo/src/utils/fileLink.ts'),
                      Target: JSON.stringify('old'),
                      Replacement: JSON.stringify('new'),
                    },
                  },
                  {
                    name: 'run_command',
                    args: {
                      CommandLine: JSON.stringify('npm run typecheck\nnpm run lint'),
                      WaitMsBeforeAsync: '10000',
                    },
                  },
                ],
              },
              {
                step_index: 250,
                type: 'GENERIC',
                status: 'DONE',
                content: 'Made 1 replacement.',
              },
              {
                step_index: 251,
                type: 'GENERIC',
                status: 'RUNNING',
                content: 'Tool is running as a background task with task id: session-1/task-251',
              },
              {
                step_index: 252,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                content: 'Waiting for task-251...',
              },
            ]);
          } else if (tick === 3) {
            // Reaching tick === 3 after step 252 proves noteTurnEnded did not exit while task-251 was pending.
            waitedThroughStep252 = presented.some(n => (
              n.update.sessionUpdate === 'agent_message_chunk'
              && n.update.content.type === 'text'
              && n.update.content.text === 'Waiting for task-251...'
            ));

            writeTranscript(appDataDir, sessionId, [
              ...initialSteps,
              {
                step_index: 248,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                content: 'Task id "session-1/task-246" finished with result: exit 1',
              },
              {
                step_index: 249,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [
                  {
                    name: 'edit_file',
                    args: {
                      Path: JSON.stringify('/repo/src/utils/fileLink.ts'),
                      Target: JSON.stringify('old'),
                      Replacement: JSON.stringify('new'),
                    },
                  },
                  {
                    name: 'run_command',
                    args: {
                      CommandLine: JSON.stringify('npm run typecheck\nnpm run lint'),
                      WaitMsBeforeAsync: '10000',
                    },
                  },
                ],
              },
              {
                step_index: 250,
                type: 'GENERIC',
                status: 'DONE',
                content: 'Made 1 replacement.',
              },
              {
                step_index: 251,
                type: 'GENERIC',
                status: 'RUNNING',
                content: 'Tool is running as a background task with task id: session-1/task-251',
              },
              {
                step_index: 252,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                content: 'Waiting for task-251...',
              },
              {
                step_index: 253,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                content: 'Task id "session-1/task-251" finished with result: ok',
              },
              {
                step_index: 254,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                content: 'All tasks complete.',
              },
            ]);
          }
        },
      },
    );

    controller.notePromptStarted(sessionId);
    writeTranscript(appDataDir, sessionId, initialSteps);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'wire-cmd-1',
        title: 'run_command',
        status: 'pending',
        rawInput: { CommandLine: 'npm test' },
      },
    })).toBe(true);

    await controller.noteTurnEnded({
      nativeSessionRef: sessionId,
      output: 'Running typecheck...',
      presentContent: jest.fn(),
      presentNotification: n => presented.push(n),
    });

    expect(tick).toBeGreaterThanOrEqual(3);
    expect(settledWireBeforeTask251).toBe(true);
    expect(unwrappedArgsSeenBeforeTask251).toBe(true);
    expect(waitedThroughStep252).toBe(true);
    expect(presented.some(n => (
      n.update.sessionUpdate === 'agent_message_chunk'
      && n.update.content.type === 'text'
      && n.update.content.text === 'All tasks complete.'
    ))).toBe(true);
  });

  it('suppresses synthetic replay when live ACP wire streams wakeup thinking, call_* tools, and chunked prose', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    const sessionId = 'session-live-wire';

    const initialSteps: Record<string, unknown>[] = [
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'run full check' },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        content: 'Tool is running as a background task with task id: session-live-wire/task-2',
      },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Waiting on check...',
      },
    ];

    const wireDelivered: AcpSessionNotification[] = [];
    const syntheticPresented: AcpSessionNotification[] = [];
    let tick = 0;

    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      {
        pollIntervalMs: 5,
        maxWakeupGraceMs: 2_000,
        delayMs: async () => {
          tick += 1;
          if (tick === 1) {
            const liveUpdates: AcpSessionNotification[] = [
              {
                sessionId,
                update: {
                  sessionUpdate: 'agent_thought_chunk',
                  content: { type: 'text', text: 'Inspecting output now.\n\n\n' },
                },
              },
              {
                sessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'call_200',
                  title: 'read_file',
                  status: 'pending',
                  rawInput: { Path: '/repo/out.txt' },
                },
              },
              {
                sessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'call_200',
                  title: 'read_file',
                  status: 'completed',
                },
              },
              {
                sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: '\n\nAll checks ' },
                },
              },
              {
                sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'passed cleanly.' },
                },
              },
            ];
            for (const item of liveUpdates) {
              if (controller.filterNotification(item)) {
                wireDelivered.push(item);
              }
            }
          } else if (tick === 2) {
            writeTranscript(appDataDir, sessionId, [
              ...initialSteps,
              {
                step_index: 4,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                content: 'Task id "session-live-wire/task-2" finished with result: exit 0',
              },
              {
                step_index: 5,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                thinking: 'Inspecting output now.',
                tool_calls: [{ name: 'read_file', args: { Path: '/repo/out.txt' } }],
              },
              {
                step_index: 6,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                content: 'All checks passed cleanly.',
              },
            ]);
          }
        },
      },
    );

    controller.notePromptStarted(sessionId);
    writeTranscript(appDataDir, sessionId, initialSteps);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'wire-cmd-1',
        title: 'run_command',
        status: 'pending',
        rawInput: { CommandLine: 'pytest' },
      },
    })).toBe(true);

    await controller.noteTurnEnded({
      nativeSessionRef: sessionId,
      output: 'Waiting on check...',
      presentContent: jest.fn(),
      presentNotification: n => syntheticPresented.push(n),
    });

    expect(tick).toBeGreaterThanOrEqual(2);
    expect(wireDelivered).toHaveLength(5);
    expect(syntheticPresented).toEqual([
      {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'wire-cmd-1',
          title: 'run_command',
          status: 'completed',
        },
      },
    ]);
  });

  it('waits during drain grace when transcript reaches DONE slightly before live wire prose finishes', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    const sessionId = 'session-live-drain';
    let fakeNow = 1_000;

    const initialSteps: Record<string, unknown>[] = [
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'run job' },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'tc-bg', name: 'invoke_subagent' }],
        content: 'Working...',
      },
    ];
    writeTranscript(appDataDir, sessionId, initialSteps);

    const syntheticPresented: AcpSessionNotification[] = [];
    const wireFilterResults: boolean[] = [];
    let tick = 0;

    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      {
        pollIntervalMs: 10,
        liveWireDrainGraceMs: 200,
        maxWakeupGraceMs: 2_000,
        nowMs: () => fakeNow,
        delayMs: async ms => {
          fakeNow += ms;
          tick += 1;
          if (tick === 1) {
            wireFilterResults.push(controller.filterNotification({
              sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'call_300',
                title: 'read_file',
                status: 'pending',
              },
            }));
            wireFilterResults.push(controller.filterNotification({
              sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call_300',
                title: 'read_file',
                status: 'completed',
              },
            }));
          } else if (tick === 2) {
            writeTranscript(appDataDir, sessionId, [
              ...initialSteps,
              { step_index: 3, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE' },
              {
                step_index: 4,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                content: 'Final answer.',
              },
            ]);
          } else if (tick === 3) {
            wireFilterResults.push(controller.filterNotification({
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: '\n\nFinal ' },
              },
            }));
            wireFilterResults.push(controller.filterNotification({
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'answer.' },
              },
            }));
          }
        },
      },
    );

    await controller.noteTurnEnded({
      nativeSessionRef: sessionId,
      output: 'Working...',
      presentContent: jest.fn(),
      presentNotification: n => syntheticPresented.push(n),
    });

    expect(tick).toBe(3);
    expect(wireFilterResults).toEqual([true, true, true, true]);
    expect(syntheticPresented).toEqual([]);
  });

  it('deduplicates lagging live wire notifications when transcript polling emits first', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    const sessionId = 'session-reverse-race';

    const initialSteps: Record<string, unknown>[] = [
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'run job' },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'tc-bg', name: 'invoke_subagent' }],
        content: 'Started...',
      },
    ];
    writeTranscript(appDataDir, sessionId, initialSteps);

    let tick = 0;
    const syntheticPresented: AcpSessionNotification[] = [];

    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      {
        pollIntervalMs: 5,
        maxWakeupGraceMs: 2_000,
        delayMs: async () => {
          tick += 1;
          if (tick === 1) {
            writeTranscript(appDataDir, sessionId, [
              ...initialSteps,
              { step_index: 3, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE' },
              {
                step_index: 4,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                thinking: 'Checking final test results.',
                tool_calls: [{ name: 'read_file', args: { Path: '/tmp/out' } }],
                content: 'Synthetic final answer.',
              },
              {
                step_index: 5,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                content: 'Done.',
              },
            ]);
          }
        },
      },
    );

    await controller.noteTurnEnded({
      nativeSessionRef: sessionId,
      output: 'Started...',
      presentContent: jest.fn(),
      presentNotification: n => syntheticPresented.push(n),
    });

    expect(syntheticPresented.length).toBeGreaterThanOrEqual(4);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Checking final test results.\n\n\n' },
      },
    })).toBe(false);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_999',
        title: 'read_file',
        status: 'pending',
        rawInput: { Path: '/tmp/out' },
      },
    })).toBe(false);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_999',
        title: 'read_file',
        status: 'completed',
      },
    })).toBe(false);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '\n\nSynthetic final ' },
      },
    })).toBe(false);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'answer.' },
      },
    })).toBe(false);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Done.\n' },
      },
    })).toBe(false);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Fresh distinct follow-up.' },
      },
    })).toBe(true);
  });

  it('emits fallback final prose once if live wire sent wakeup tools but omitted final prose past drain grace', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    const sessionId = 'session-live-fallback';
    let fakeNow = 10_000;

    const initialSteps: Record<string, unknown>[] = [
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'run job' },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'tc-bg', name: 'invoke_subagent' }],
        content: 'Launched...',
      },
    ];
    writeTranscript(appDataDir, sessionId, initialSteps);

    let tick = 0;
    const syntheticPresented: AcpSessionNotification[] = [];
    const wireFilterResults: boolean[] = [];

    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      {
        pollIntervalMs: 10,
        liveWireDrainGraceMs: 50,
        maxWakeupGraceMs: 2_000,
        nowMs: () => fakeNow,
        delayMs: async ms => {
          fakeNow += ms;
          tick += 1;
          if (tick === 1) {
            wireFilterResults.push(controller.filterNotification({
              sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'call_400',
                title: 'read_file',
                status: 'pending',
              },
            }));
            wireFilterResults.push(controller.filterNotification({
              sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call_400',
                title: 'read_file',
                status: 'completed',
              },
            }));
          } else if (tick === 2) {
            writeTranscript(appDataDir, sessionId, [
              ...initialSteps,
              { step_index: 3, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE' },
              {
                step_index: 4,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                content: 'Fallback prose.',
              },
            ]);
          }
        },
      },
    );

    await controller.noteTurnEnded({
      nativeSessionRef: sessionId,
      output: 'Launched...',
      presentContent: jest.fn(),
      presentNotification: n => syntheticPresented.push(n),
    });

    expect(wireFilterResults).toEqual([true, true]);
    expect(syntheticPresented).toEqual([
      {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Fallback prose.' },
        },
      },
    ]);
  });

  it('returns immediately when a mid-turn background run_command completes before end_turn', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    const sessionId = 'session-mid';

    const steps: Record<string, unknown>[] = [
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'run pytest' },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'tc-cmd', name: 'run_command', args: { WaitMsBeforeAsync: 10000 } }],
      },
      {
        step_index: 3,
        type: 'GENERIC',
        status: 'RUNNING',
        content: 'Command is running as a background task with task id: session-mid/task-1',
      },
      {
        step_index: 4,
        source: 'SYSTEM',
        type: 'TASK_NOTIFICATION',
        status: 'DONE',
        content: 'Task id "session-mid/task-1" finished with result: exit 0',
      },
      {
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'All 195 pytest cases passed.',
      },
    ];
    writeTranscript(appDataDir, sessionId, [steps[0]]);

    const delayMs = jest.fn(async () => {});
    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      { delayMs },
    );

    controller.notePromptStarted(sessionId);
    writeTranscript(appDataDir, sessionId, steps);

    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-cmd',
        title: 'uv run pytest -v',
        status: 'pending',
      },
    })).toBe(true);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-cmd',
        title: 'uv run pytest -v',
        status: 'in_progress',
        rawOutput: 'Command is running as a background task with task id: session-mid/task-1',
      },
    })).toBe(true);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-cmd',
        title: 'uv run pytest -v',
        status: 'completed',
        rawOutput: 'Command exited with code 0.\n\nCommand output:\n195 passed',
      },
    })).toBe(true);

    await controller.noteTurnEnded({
      nativeSessionRef: sessionId,
      output: 'All 195 pytest cases passed.',
      presentContent: jest.fn(),
    });

    expect(delayMs).not.toHaveBeenCalled();
  });

  it('returns immediately when a mid-turn invoke_subagent finishes before end_turn', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    const sessionId = 'session-sub-mid';

    writeTranscript(appDataDir, sessionId, [
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'audit repo' },
    ]);

    const delayMs = jest.fn(async () => {});
    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      { delayMs },
    );

    controller.notePromptStarted(sessionId);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-sub',
        title: 'Run invoke_subagent',
        status: 'pending',
      },
    })).toBe(true);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-sub',
        title: 'Run invoke_subagent',
        status: 'completed',
        rawOutput: 'Subagent launched.',
      },
    })).toBe(true);

    writeTranscript(appDataDir, sessionId, [
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'audit repo' },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'tc-sub', name: 'invoke_subagent' }],
      },
      {
        step_index: 3,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: 'Subagent completed audit.',
      },
      {
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Audit complete with no findings.',
      },
    ]);

    await controller.noteTurnEnded({
      nativeSessionRef: sessionId,
      output: 'Audit complete with no findings.',
      presentContent: jest.fn(),
    });

    expect(delayMs).not.toHaveBeenCalled();
  });

  it('does not false-trigger on tool titles containing async tool substrings like schedule or swarm', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    const sessionId = 'session-substring';

    writeTranscript(appDataDir, sessionId, [
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'search workflows' },
    ]);

    const delayMs = jest.fn(async () => {});
    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      { delayMs },
    );

    controller.notePromptStarted(sessionId);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-rg',
        title: 'rg -n "/(goal|compact|schedule|browser)" open.md',
        status: 'pending',
      },
    })).toBe(true);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-rg',
        title: 'rg -n "/(goal|compact|schedule|browser)" open.md',
        status: 'completed',
        rawOutput: 'Command exited with code 0.\n\nCommand output:\nopen.md:10:/schedule',
      },
    })).toBe(true);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-file',
        title: 'File notes/swarm-schedule.md',
        status: 'completed',
        rawOutput: 'Showing lines 1-5 of 5\nRunning as a background task',
      },
    })).toBe(true);

    writeTranscript(appDataDir, sessionId, [
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'search workflows' },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'run_command' }, { name: 'read_file' }],
      },
      {
        step_index: 3,
        type: 'GENERIC',
        status: 'DONE',
        content: 'Command exited with code 0.\n\nCommand output:\nopen.md:10:/schedule',
      },
      {
        step_index: 4,
        type: 'GENERIC',
        status: 'DONE',
        content: 'Showing lines 1-5 of 5\nRunning as a background task',
      },
      {
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Found one reference.',
      },
    ]);

    await controller.noteTurnEnded({
      nativeSessionRef: sessionId,
      output: 'Found one reference.',
      presentContent: jest.fn(),
    });

    expect(delayMs).not.toHaveBeenCalled();
  });

  it('ignores literal background markers and foreign task IDs in read_file, git output, and prose', async () => {
    const appDataDir = createTempBrainRoot();
    createdRoots.push(appDataDir);
    const sessionId = 'session-active-42';

    writeTranscript(appDataDir, sessionId, [
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'inspect controller' },
    ]);

    const delayMs = jest.fn(async () => {});
    const controller = createAgyContinuationController(
      () => ({ ANTIGRAVITY_APPDATA_DIR: appDataDir }),
      { delayMs },
    );

    controller.notePromptStarted(sessionId);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-git',
        title: 'git show 456a34cc',
        status: 'completed',
        rawOutput: [
          'Command exited with code 0.',
          '',
          'Command output:',
          "+ 'running as a background task with task id: session-bg/task-1'",
        ].join('\n'),
      },
    })).toBe(true);
    expect(controller.filterNotification({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'The controller scans for "running as a background task" and "runs in the background".',
        },
      },
    })).toBe(true);

    writeTranscript(appDataDir, sessionId, [
      { step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'inspect controller' },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'read_file' }, { name: 'run_command' }],
      },
      {
        step_index: 3,
        type: 'GENERIC',
        status: 'DONE',
        content: [
          'Created At: 2026-11-20T17:00:00Z',
          'Completed At: 2026-11-20T17:00:01Z',
          'Showing lines 1-800 of 1149',
          "rawOutput: 'Tool is running as a background task with task id: session-bg/task-1'",
        ].join('\n'),
      },
      {
        step_index: 4,
        type: 'GENERIC',
        status: 'DONE',
        content: [
          'Command exited with code 0.',
          '',
          'Command output:',
          "+ 'running as a background task with task id: session-1/task-246'",
        ].join('\n'),
      },
      {
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'The controller scans for "running as a background task" and "runs in the background".',
      },
    ]);

    await controller.noteTurnEnded({
      nativeSessionRef: sessionId,
      output: 'The controller scans for "running as a background task" and "runs in the background".',
      presentContent: jest.fn(),
    });

    expect(delayMs).not.toHaveBeenCalled();
  });
});
