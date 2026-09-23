import { PROTOCOL_VERSION } from '../../shared/protocol';
import { messageOf } from './errors';
import { runtimeProtocolVersion } from './sidecar';

/**
 * What a reader can do about it, which is the part the raw failure never said.
 *
 * Deliberately says nothing about which method drifted. By the time the versions disagree
 * the list is unknowable from here, and naming one would send the reader after a feature
 * again - the exact wrong turn this exists to prevent (#169).
 */
export const STALE_RUNTIME =
  'The runtime is a different version from this window. Restart the app.';

/**
 * Whether the sidecar on the other end was built from the same protocol as this window.
 *
 * Asked once at connect rather than per request, because the answer cannot change while a
 * sidecar lives: it is compiled into the process.
 *
 * A sidecar too old to have the handshake at all answers by not having it, and that is a
 * reliable verdict rather than a guess - `protocol.version` exists in every build that
 * knows the question is being asked.
 *
 * Costs nothing. The handler reads a constant and touches no session, so checking this
 * starts no Copilot process, which is the rule the whole app is built around.
 */
export async function staleRuntime(): Promise<string | null> {
  try {
    return (await runtimeProtocolVersion()) === PROTOCOL_VERSION ? null : STALE_RUNTIME;
  } catch (error: unknown) {
    if (/unknown method/i.test(messageOf(error))) return STALE_RUNTIME;

    // Anything else means the sidecar is unreachable rather than mismatched, which is a
    // different problem with its own report. Answering "stale" here would blame the build
    // for a runtime that simply died, and send the next reader to rebuild it for nothing.
    return null;
  }
}
