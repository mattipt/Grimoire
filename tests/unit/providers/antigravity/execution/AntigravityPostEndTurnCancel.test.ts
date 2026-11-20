import { executionBackendId } from '@/core/execution/ExecutionBackendDescriptor';
import { executionSessionId, runId, sessionInstanceId } from '@/core/execution/ExecutionIds';
import { reconcileAntigravityAcpRun } from '@/providers/antigravity/execution/AntigravityExecutionComposition';

describe('reconcileAntigravityAcpRun', () => {
  const baseQuery = {
    backendId: executionBackendId('antigravity:acp'),
    backendGeneration: 1,
    executionSessionId: executionSessionId('es-00000000000000000000000000000001'),
    sessionInstanceId: sessionInstanceId('si-00000000000000000000000000000001'),
    runId: runId('run-00000000000000000000000000000001'),
    resultExpectation: 'required' as const,
  };

  it('returns stopped-safe when cancelled after native end_turn', () => {
    expect(reconcileAntigravityAcpRun({
      ...baseQuery,
      cancellationRequested: true,
      nativeStopReason: 'end_turn',
    })).toEqual({ kind: 'stopped-safe' });
  });

  it('returns stopped-safe when ACP reported a cancelled stop reason', () => {
    expect(reconcileAntigravityAcpRun({
      ...baseQuery,
      cancellationRequested: true,
      nativeStopReason: 'cancelled',
    })).toEqual({ kind: 'stopped-safe' });
  });

  it('returns unknown when cancelled without a native stop reason', () => {
    expect(reconcileAntigravityAcpRun({
      ...baseQuery,
      cancellationRequested: true,
    })).toEqual({ kind: 'unknown', effectsPossible: true });
  });

  it('returns unknown when end_turn is present without cancellation requested', () => {
    expect(reconcileAntigravityAcpRun({
      ...baseQuery,
      cancellationRequested: false,
      nativeStopReason: 'end_turn',
    })).toEqual({ kind: 'unknown', effectsPossible: true });
  });
});
