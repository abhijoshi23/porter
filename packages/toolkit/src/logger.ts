import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Logs go to **stderr (fd 2)** only. In stdio mode, stdout carries the JSON-RPC stream,
 * and a single stray log line there corrupts the protocol and the client drops the
 * connection. MCP's own `notifications/message` logging is deprecated as of 2026-07-28,
 * so stderr (plus OpenTelemetry in HTTP mode) is the supported path.
 */
export function createLogger(name: string, level = 'info'): Logger {
  return pino(
    {
      name,
      level,
      // Defence in depth: never write credentials, even if they end up in a logged object.
      redact: {
        paths: [
          'authorization',
          '*.authorization',
          'headers.authorization',
          '*.headers.authorization',
          'token',
          '*.token',
          'accessToken',
          '*.accessToken',
          'refreshToken',
          '*.refreshToken',
          'apiKey',
          '*.apiKey',
        ],
        censor: '[redacted]',
      },
    },
    pino.destination(2),
  );
}

/** A logger that discards everything. Used in tests. */
export const silentLogger: Logger = pino({ level: 'silent' });
