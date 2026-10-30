import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';

/**
 * The two protocol eras a Porter server must serve:
 *
 * - `2025`: the classic `initialize` handshake plus a session. Claude Desktop and most
 *   clients in the wild still speak this.
 * - `2026`: the stateless 2026-07-28 revision, where each request carries its version and
 *   capabilities in `_meta`.
 *
 * Integration tests run every case under both (see `ERAS`), because the SDK takes a
 * different code path for each.
 */
export type Era = '2025' | '2026';
export const ERAS: readonly Era[] = ['2025', '2026'];

export interface TestClient {
  client: Client;
  close(): Promise<void>;
}

/**
 * Connects a real MCP client to a server in the same process, with no sockets or child
 * processes.
 *
 * - 2025: `InMemoryTransport` linked pair. It only speaks the 2025 protocol.
 * - 2026: the server's web-standard `handler.fetch` is passed straight to the client's
 *   Streamable HTTP transport as its `fetch`. Real HTTP semantics (headers, status codes,
 *   JSON/SSE bodies) without a network, and it is the exact handler we deploy.
 */
export async function connectTestClient(factory: () => McpServer, era: Era): Promise<TestClient> {
  if (era === '2025') {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = factory();
    const client = new Client({ name: 'porter-test', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  const handler = createMcpHandler(factory, { legacy: 'reject' });
  const transport = new StreamableHTTPClientTransport(new URL('http://porter.test/mcp'), {
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  });
  const client = new Client(
    { name: 'porter-test', version: '0.0.0' },
    // Pin the modern era. With `legacy: 'reject'` on the handler, any silent fallback to
    // 2025 would fail loudly instead of quietly testing the wrong path.
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}
