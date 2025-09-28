#!/usr/bin/env ts-node
/**
 * MRCP Sidecar Mock Server
 * 목적: AudioHook MRCP bridge-sidecar 구현이 기대하는 최소 WebSocket 프로토콜을 흉내내어
 * 로컬 개발/테스트 환경에서 빠르게 동작 확인.
 *
 * 프로토콜(bridge-sidecar.ts 참고):
 *  - 클라이언트 연결 후 JSON { type: 'init', endpoint, profileId, resource, codec, sampleRate, mono, language? }
 *  - 바이너리 오디오 프레임 수신 (이 모크는 별도 RTP/RTSP 없이 단순 카운트)
 *  - 일정량 수신 후 result 이벤트 전송
 *  - close 시 bye 이벤트 또는 소켓 종료
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as os from 'os';

interface InitMessage {
  type: 'init';
  endpoint: string;
  profileId: string;
  resource: string;
  codec: string;
  sampleRate: number;
  mono: boolean;
  language?: string;
  vendorHeaders?: Record<string, string>;
}
interface ByeMessage { type: 'bye'; reason?: string }

type AnyMessage = InitMessage | ByeMessage | { type: string; [k: string]: any };

const PORT = parseInt(process.env['MRCP_SIDECAR_PORT'] || '9090', 10);
const PATH = '/mrcp';

const server = http.createServer();
const wss = new WebSocketServer({ server, path: PATH });

console.log(`[mrcp-sidecar-mock] listening ws://127.0.0.1:${PORT}${PATH}`);

wss.on('connection', (ws: WebSocket) => {
  console.log('[mrcp-sidecar-mock] client connected');
  let inited = false;
  let bytes = 0;
  let closed = false;

  const send = (obj: unknown) => {
    try { ws.send(JSON.stringify(obj)); } catch {/* ignore */}
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      bytes += (data as Buffer).length;
      // 16KB 누적마다 result (단순 샘플)
      if (bytes >= 16 * 1024) {
        bytes = 0;
        send({ type: 'result', text: `mock transcript @${Date.now()}` });
      }
      return;
    }
    try {
      const msg = JSON.parse(data.toString()) as AnyMessage;
      if (msg.type === 'init') {
        if (inited) return;
        inited = true;
        console.log('[mrcp-sidecar-mock] init received', {
          endpoint: msg.endpoint,
          profileId: msg.profileId,
          codec: msg.codec,
          sampleRate: msg.sampleRate,
          mono: msg.mono,
        });
        // 초기 연결 이벤트 시뮬레이션
        setTimeout(() => send({ type: 'rtsp-connected', remote: msg.endpoint }), 50);
        setTimeout(() => send({ type: 'rtp-started', localRtpPort: 40000, payloadType: msg.codec === 'PCMU' ? 0 : 97 }), 120);
      } else if (msg.type === 'bye') {
        console.log('[mrcp-sidecar-mock] bye received');
        send({ type: 'closed', reason: msg.reason || 'client-bye' });
        try { ws.close(); } catch {/* */}
      }
    } catch (e) {
      send({ type: 'error', message: 'invalid json', cause: String((e as Error).message) });
    }
  });

  ws.on('close', () => {
    if (closed) return; closed = true;
    console.log('[mrcp-sidecar-mock] socket closed');
  });

  ws.on('error', (err) => {
    console.log('[mrcp-sidecar-mock] socket error', err.message);
  });
});

server.listen(PORT);

process.on('SIGINT', () => {
  console.log('\n[mrcp-sidecar-mock] SIGINT');
  try { wss.clients.forEach(c => c.close()); } catch {/* */}
  try { server.close(); } catch {/* */}
  process.exit(0);
});
