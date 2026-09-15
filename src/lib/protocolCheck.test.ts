// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION } from '../../shared/protocol';
import { STALE_RUNTIME, staleRuntime } from './protocolCheck';

const { runtimeProtocolVersion } = vi.hoisted(() => ({ runtimeProtocolVersion: vi.fn() }));

vi.mock('./sidecar', () => ({ runtimeProtocolVersion: () => runtimeProtocolVersion() }));

beforeEach(() => {
  runtimeProtocolVersion.mockReset().mockResolvedValue(PROTOCOL_VERSION);
});

describe('checking the runtime was built from this protocol', () => {
  it('says nothing when the two agree', async () => {
    await expect(staleRuntime()).resolves.toBeNull();
  });

  it('reports a sidecar built from a different method list', async () => {
    runtimeProtocolVersion.mockResolvedValue('0badf00d');

    await expect(staleRuntime()).resolves.toBe(STALE_RUNTIME);
  });

  /**
   * The case that started #169. A sidecar older than the handshake cannot answer it, and
   * that refusal is the evidence rather than something to be recovered from.
   */
  it('reads a sidecar too old to know the handshake as the same problem', async () => {
    runtimeProtocolVersion.mockRejectedValue(new Error('Unknown method: protocol.version'));

    await expect(staleRuntime()).resolves.toBe(STALE_RUNTIME);
  });

  /**
   * A dead sidecar is reported by the shell, which knows it died. Blaming the build would
   * send the next reader to rebuild something that was never wrong.
   */
  it.each([
    ['the runtime stopped; restart the app'],
    ['the runtime is restarting; try again'],
    ['the runtime did not answer; it may still be working'],
  ])('leaves %s to the report that already covers it', async (reason) => {
    runtimeProtocolVersion.mockRejectedValue(new Error(reason));

    await expect(staleRuntime()).resolves.toBeNull();
  });

  it('never blames the build for a request that merely failed', async () => {
    runtimeProtocolVersion.mockRejectedValue(new Error('EPERM: operation not permitted'));

    await expect(staleRuntime()).resolves.toBeNull();
  });
});
