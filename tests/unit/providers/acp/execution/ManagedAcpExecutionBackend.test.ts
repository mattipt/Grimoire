import {
  executionBackendId,
  internalExecutionServiceId,
} from '@/core/execution/ExecutionBackendDescriptor';
import type { ExecutionRequest } from '@/core/execution/ExecutionContracts';
import type { ProviderExecutionEvent } from '@/core/execution/ExecutionEvents';
import {
  executionSessionId,
  interactionId,
  runId,
  sessionInstanceId,
} from '@/core/execution/ExecutionIds';
import type { ManagedAcpClient } from '@/providers/acp/execution/ManagedAcpClient';
import {
  ManagedAcpExecutionBackend,
  type ManagedAcpExecutionInvocation,
} from '@/providers/acp/execution/ManagedAcpExecutionBackend';
import type { AcpSessionNotification } from '@/providers/acp/types';

class ReplayAcpClient implements ManagedAcpClient {
  readonly loadRequests: Parameters<ManagedAcpClient['loadSession']>[0][] = [];
  readonly promptRequests: Parameters<ManagedAcpClient['prompt']>[0][] = [];
  private readonly notificationListeners = new Set<(notification: AcpSessionNotification) => void>();
  private readonly lossListeners = new Set<(error?: Error) => void>();
  private promptResolve?: (value: { stopReason: string }) => void;
  private promptReject?: (error: unknown) => void;

  constructor(
    private readonly onLoadSession?: (
      emit: (notification: AcpSessionNotification) => void,
      request: Parameters<ManagedAcpClient['loadSession']>[0],
    ) => Promise<void> | void,
  ) {}

  async initialize(): Promise<void> {}

  async newSession() {
    return { sessionId: 'new-session' };
  }

  async loadSession(request: Parameters<ManagedAcpClient['loadSession']>[0]) {
    this.loadRequests.push(request);
    await this.onLoadSession?.(notification => this.emit(notification), request);
    return { sessionId: request.sessionId };
  }

  prompt(request: Parameters<ManagedAcpClient['prompt']>[0]) {
    this.promptRequests.push(request);
    return new Promise<{ stopReason: string }>((resolve, reject) => {
      this.promptResolve = resolve;
      this.promptReject = reject;
    });
  }

  async setMode() { return {}; }
  async setModel() { return {}; }
  async setConfigOption() { return { configOptions: [] }; }
  cancel(): void {}

  onSessionNotification(listener: (notification: AcpSessionNotification) => void) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onConnectionLost(listener: (error?: Error) => void) {
    this.lossListeners.add(listener);
    return () => this.lossListeners.delete(listener);
  }

  async close(): Promise<'confirmed'> {
    return 'confirmed';
  }

  emit(notification: AcpSessionNotification): void {
    for (const listener of this.notificationListeners) listener(notification);
  }

  completePrompt(stopReason = 'end_turn'): void {
    this.promptResolve?.({ stopReason });
  }

  loseConnection(error = new Error('connection dropped')): void {
    this.promptReject?.(error);
    for (const listener of this.lossListeners) listener(error);
  }
}

function agentChunk(sessionId: string, text: string): AcpSessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  };
}

function toolCallNotification(sessionId: string, toolCallId: string): AcpSessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'Replayed tool call',
      status: 'completed',
    },
  };
}

async function waitFor(predicate: () => boolean, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition not reached.');
}

async function collectEvents(run: { readonly events: AsyncIterable<ProviderExecutionEvent> }) {
  const events: ProviderExecutionEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

function hexId(prefix: string, n: number): string {
  return `${prefix}-${n.toString(16).padStart(32, '0')}`;
}

function createHarness(clients: ManagedAcpClient[]) {
  let seq = 0;
  const stored: string[] = [];
  const backend = new ManagedAcpExecutionBackend({
    descriptor: {
      backendId: executionBackendId('test:acp'),
      association: { kind: 'internal', service: internalExecutionServiceId('test-acp') },
    },
    clientFactory: {
      create: async () => {
        const next = clients.shift();
        if (!next) throw new Error('No test client queued.');
        return next;
      },
    },
    requestResolver: {
      resolve: async (requestRef): Promise<ManagedAcpExecutionInvocation> => ({
        startupRef: requestRef,
        restartFingerprint: 'fp-1',
        cwd: '/vault',
        prompt: [{ type: 'text', text: 'hello' }],
        mcpServers: [],
      }),
    },
    dynamicApplier: {
      apply: async () => undefined,
    },
    interactionBridge: {
      prepare: async () => {
        throw new Error('Unexpected permission prompt');
      },
    },
    resultSink: {
      storeResult: async ({ output }) => {
        stored.push(output);
        return {
          kind: 'committed',
          result: { resultId: 'res-1', storage: 'projection', digest: 'sha256:test' },
        };
      },
    },
    reconciler: {
      reconcile: async () => ({ kind: 'unknown', effectsPossible: true }),
    },
    auxiliaryQueries: {
      execute: async () => {
        throw new Error('Unsupported');
      },
    },
    scheduler: {
      setTimeout: (cb, ms) => window.setTimeout(cb, ms),
      clearTimeout: id => window.clearTimeout(id as number),
    },
    sessionInstanceIdFactory: () => sessionInstanceId(hexId('si', ++seq)),
    interactionIdFactory: () => interactionId(hexId('ix', ++seq)),
    resultCommitTimeoutMs: 1_000,
    recoveryTimeoutMs: 1_000,
    runTimeoutMs: 10_000,
    maxResultBytes: 1024 * 1024,
  });

  const request: ExecutionRequest = {
    runId: runId(hexId('run', 1)),
    owner: { kind: 'conversation', ownerId: 'conv-1' },
    resultExpectation: 'required',
    requestRef: 'req-1',
  };

  return { backend, stored, request };
}

describe('ManagedAcpExecutionBackend loadSession replay guard', () => {
  it('suppresses historical session/update notifications emitted during recovery loadSession', async () => {
    const first = new ReplayAcpClient();
    const second = new ReplayAcpClient((emit, req) => {
      emit(agentChunk(req.sessionId, 'Replayed historical message'));
      emit(toolCallNotification(req.sessionId, 'replayed-tool-1'));
    });

    const { backend, stored, request } = createHarness([first, second]);
    const session = await backend.createSession({
      executionSessionId: executionSessionId(hexId('es', 1)),
      owner: { kind: 'conversation', ownerId: 'conv-1' },
      backendGeneration: 1,
      nativeSessionRef: 'saved-session',
    });

    const eventsPromise = collectEvents(session.createRun(request));
    await waitFor(() => first.promptRequests.length === 1);

    first.loseConnection();
    await waitFor(() => second.promptRequests.length === 1);

    second.emit(agentChunk('saved-session', 'Fresh recovery reply'));
    second.completePrompt();

    const events = await eventsPromise;
    expect(stored).toEqual(['Fresh recovery reply']);

    const deltas = events
      .filter(e => e.event.kind === 'output-delta')
      .map(e => (e.event as { text: string }).text);
    expect(deltas).toEqual(['Fresh recovery reply']);

    const updates = events
      .filter(e => e.event.kind === 'provider-content')
      .map(e => (e.event as { payload: { kind: string; notification?: AcpSessionNotification } }).payload)
      .filter(p => p.kind === 'session-update')
      .map(p => p.notification?.update.sessionUpdate);
    expect(updates).toEqual(['agent_message_chunk']);
  });

  it('suppresses historical session/update notifications emitted during initial resume loadSession', async () => {
    const client = new ReplayAcpClient((emit, req) => {
      emit(agentChunk(req.sessionId, 'Old persisted turn'));
      emit(toolCallNotification(req.sessionId, 'old-tool-1'));
    });

    const { backend, stored, request } = createHarness([client]);
    const session = await backend.createSession({
      executionSessionId: executionSessionId(hexId('es', 2)),
      owner: { kind: 'conversation', ownerId: 'conv-2' },
      backendGeneration: 1,
      nativeSessionRef: 'saved-session',
    });

    const eventsPromise = collectEvents(session.createRun(request));
    await waitFor(() => client.promptRequests.length === 1);

    client.emit(agentChunk('saved-session', 'Live reply'));
    client.completePrompt();

    const events = await eventsPromise;
    expect(stored).toEqual(['Live reply']);

    const deltas = events
      .filter(e => e.event.kind === 'output-delta')
      .map(e => (e.event as { text: string }).text);
    expect(deltas).toEqual(['Live reply']);
  });

  it('clears replay guards if recovery loadSession fails so subsequent runs still receive notifications', async () => {
    const first = new ReplayAcpClient();
    const failingRecovery = new ReplayAcpClient(() => {
      throw new Error('transient load failure');
    });
    const third = new ReplayAcpClient();

    const { backend, stored, request } = createHarness([first, failingRecovery, third]);
    const session = await backend.createSession({
      executionSessionId: executionSessionId(hexId('es', 3)),
      owner: { kind: 'conversation', ownerId: 'conv-3' },
      backendGeneration: 1,
      nativeSessionRef: 'saved-session',
    });

    const failedRun = collectEvents(session.createRun(request));
    await waitFor(() => first.promptRequests.length === 1);
    first.loseConnection();
    await failedRun;

    const nextRequest: ExecutionRequest = {
      ...request,
      runId: runId(hexId('run', 2)),
    };
    const nextRun = collectEvents(session.createRun(nextRequest));
    await waitFor(() => third.promptRequests.length === 1);
    third.emit(agentChunk('saved-session', 'Next run reply'));
    third.completePrompt();

    await nextRun;
    expect(stored).toEqual(['Next run reply']);
  });
});
