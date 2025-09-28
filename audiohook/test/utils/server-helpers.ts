import { createServer, Server, Socket } from 'net';

export interface TestServerHandle {
  port: number;
  server: Server;
  close(): Promise<void>;
}

export async function createTestTcpServer(onConn: (sock: Socket) => void): Promise<TestServerHandle> {
  const srv = createServer(onConn);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  if (typeof addr !== 'object' || !addr) throw new Error('server address unavailable');
  return {
    port: addr.port,
    server: srv,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

export async function withTestTcpServer(onConn: (sock: Socket) => void, fn: (h: TestServerHandle) => Promise<void>): Promise<void> {
  const h = await createTestTcpServer(onConn);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}
