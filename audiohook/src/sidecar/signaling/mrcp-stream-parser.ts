/*
  MRCP 멀티프레임 스트림 파서 (초기 스켈레톤)
  - TCP 등에서 이어붙여 들어오는 raw 문자열/버퍼 조각을 누적
  - '\r\n\r\n' 헤더 경계 찾기 → Content-Length 해석 → 전체 메시지 길이 확보 시 콜백
  - Body 길이 검증 실패/이상치 시 onError 호출 후 버퍼 초기화 (간단 fail-fast)
  제한:
    * 바디를 문자열로 가정 (추후 Buffer 유지 옵션 필요)
    * Chunk 내 다중 메시지 가능
*/
import { parseMrcpMessage, MrcpMessage } from './mrcp-parser';

export type MrcpMessageHandler = (msg: MrcpMessage) => void;
export type MrcpParserErrorHandler = (err: Error, context?: { bufferSize: number }) => void;

export class MrcpStreamParser {
  private buffer = '';
  private readonly maxHeaderSize: number;
  private readonly maxBodySize: number;

  constructor(
    private readonly onMessage: MrcpMessageHandler,
    private readonly onError: MrcpParserErrorHandler = () => {},
    opts: { maxHeaderSize?: number; maxBodySize?: number } = {},
  ) {
    this.maxHeaderSize = opts.maxHeaderSize ?? 32 * 1024;
    this.maxBodySize = opts.maxBodySize ?? 512 * 1024;
  }

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    try {
      this.drain();
    } catch (e) {
      this.onError(e as Error, { bufferSize: this.buffer.length });
      // 안전을 위해 버퍼 초기화 (프로토콜 sync 재시도)
      this.buffer = '';
    }
  }

  private drain(): void {
    while (true) {
      const boundary = this.buffer.indexOf('\r\n\r\n');
      if (boundary === -1) return; // 헤더 부족
      if (boundary > this.maxHeaderSize) throw new Error('MRCP header too large');
      // 헤더 부분
      const headerPart = this.buffer.substring(0, boundary);
      const headerLines = headerPart.split(/\r\n/);
      // Content-Length 탐색
      let contentLength: number | undefined;
      for (let i = 1; i < headerLines.length; i++) {
        const line = headerLines[i];
        const c = line.indexOf(':');
        if (c === -1) continue;
        const k = line.substring(0, c).trim().toLowerCase();
        if (k === 'content-length') {
          const n = Number(line.substring(c + 1).trim());
          if (!Number.isFinite(n) || n < 0 || n > this.maxBodySize) {
            throw new Error('Invalid Content-Length');
          }
          contentLength = n;
          break;
        }
      }
      const totalNeeded = boundary + 4 + (contentLength ?? 0);
      if (this.buffer.length < totalNeeded) return; // 더 필요
      const rawMessage = this.buffer.substring(0, totalNeeded);
      this.buffer = this.buffer.substring(totalNeeded);
      try {
        const msg = parseMrcpMessage(rawMessage);
        this.onMessage(msg);
      } catch (e) {
        this.onError(e as Error, { bufferSize: this.buffer.length });
      }
      // loop to attempt parsing next message (if any)
    }
  }
}
