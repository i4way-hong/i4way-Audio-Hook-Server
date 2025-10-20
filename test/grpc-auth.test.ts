import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';

// NOTE: 단순 통합 테스트 - 실제 서버가 test 환경에서 기동되어 있어야 함.
// CI 환경에서 gRPC 서버를 별도로 띄우지 않았다면 이 테스트는 skip 처리 필요.
// 여기서는 환경변수 GRPC_AUTH_TOKEN 사용 시 인증 성공/실패 흐름만 기본적으로 검증 시나리오 제시.

const PROTO = path.resolve(process.cwd(), 'proto', 'speech_transcription.proto');

function loadClient() {
  const def = protoLoader.loadSync(PROTO, { longs: String, enums: String, defaults: true, oneofs: true });
  const pkg = grpc.loadPackageDefinition(def) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const client = new pkg.audiohook.stt.v1.SpeechTranscription('localhost:' + (process.env['GRPC_PORT'] || '50051'), grpc.credentials.createInsecure());
  return client;
}

// Helper to open a stream and wait minimal ready/error
function openStream(client: any, token?: string): Promise<{ messages: any[]; error?: Error }>{ // eslint-disable-line @typescript-eslint/no-explicit-any
  return new Promise((resolve) => {
    const md = new grpc.Metadata();
    if (token) md.set('authorization', `Bearer ${token}`);
    const stream = client.StreamingRecognize(md);
    const messages: any[] = [];
    let resolved = false;
    stream.on('data', (m: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      messages.push(m);
      if (!resolved) {
        resolved = true;
        resolve({ messages });
        stream.end();
      }
    });
    stream.on('error', (err: Error) => {
      if (!resolved) {
        resolved = true;
        resolve({ messages, error: err });
      }
    });
    stream.on('end', () => {
      if (!resolved) {
        resolved = true;
        resolve({ messages });
      }
    });
    // send init quickly
    stream.write({ init: { language_code: 'ko-KR', sample_rate_hz: 8000, encoding: 'LINEAR16' } });
  });
}

// Skip automatically if GRPC_AUTH_TOKEN not set (nothing to test about auth)
const maybe = process.env['GRPC_AUTH_TOKEN'] ? describe : describe.skip;

maybe('gRPC auth basic', () => {
  test('valid token accepted', async () => {
    const client = loadClient();
  const { messages, error } = await openStream(client, process.env['GRPC_AUTH_TOKEN']);
    expect(error).toBeUndefined();
    // Expect at least a ready message or no error
    const hasReady = messages.some(m => m.ready);
    expect(hasReady).toBe(true);
  });

  test('invalid token rejected', async () => {
    const client = loadClient();
    const { messages } = await openStream(client, 'INVALID_TOKEN');
    // Expect first message to contain error with UNAUTHENTICATED
    const hasUnauth = messages.some(m => m.error && m.error.code === 'UNAUTHENTICATED');
    expect(hasUnauth).toBe(true);
  });
});
