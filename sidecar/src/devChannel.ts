import { createServer, type Socket } from 'node:net';

/** Somewhere a JSON-RPC message can be written back to. */
export interface Channel {
  write(payload: unknown): void;
}

export interface DevChannelOptions {
  /** Handles one parsed request and returns the JSON-RPC response to send back. */
  onRequest: (raw: string, channel: Channel) => void;
  log: (message: string) => void;
}

/**
 * Optional local control channel, enabled only by COPILOT_DESKTOP_DEV_PORT.
 *
 * The running app owns its sidecar over stdio, so there is otherwise no way to drive
 * it from outside: a second sidecar would start a second CLI server that the app never
 * sees. Because requests here are handled by the app's own sidecar, its notifications
 * reach the UI exactly as they would for a real interaction.
 *
 * Never listens unless the variable is set, and only ever binds to loopback.
 */
export function startDevChannel(options: DevChannelOptions): { broadcast: (payload: unknown) => void } {
  const configured = process.env.COPILOT_DESKTOP_DEV_PORT;
  const port = configured ? Number(configured) : NaN;

  if (!configured) return { broadcast: () => undefined };

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    options.log(`dev channel disabled: COPILOT_DESKTOP_DEV_PORT="${configured}" is not a valid port`);
    return { broadcast: () => undefined };
  }

  const clients = new Set<Socket>();

  const server = createServer((socket) => {
    clients.add(socket);
    socket.setEncoding('utf8');
    options.log(`dev channel client connected (${clients.size} active)`);

    const channel: Channel = {
      write: (payload) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
      },
    };

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) options.onRequest(line, channel);
      }
    });

    const drop = () => {
      clients.delete(socket);
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  server.on('error', (error: Error) => {
    options.log(`dev channel failed to listen on ${port}: ${error.message}`);
  });

  // Loopback only; this is a development affordance, not a remote control surface.
  server.listen(port, '127.0.0.1', () => {
    options.log(`dev channel listening on 127.0.0.1:${port} (COPILOT_DESKTOP_DEV_PORT is set)`);
  });

  // Never hold the sidecar open just because the channel exists.
  server.unref();

  return {
    broadcast: (payload) => {
      const line = `${JSON.stringify(payload)}\n`;
      for (const socket of clients) {
        if (!socket.destroyed) socket.write(line);
      }
    },
  };
}
