import { parseMrcpMessage, isMrcpEventMessage } from '../../src/sidecar/signaling/mrcp-parser';

describe('mrcp-parser', () => {
  test('parses basic message with body', () => {
    const raw = [
      'MRCP/2.0 RESPONSE 123 CHANNEL-1 COMPLETE',
      'Content-Type: application/json',
      'Content-Length: 13',
      '',
      '{"ok":true}',
    ].join('\r\n');
    const msg = parseMrcpMessage(raw);
    expect(msg.version).toBe('MRCP/2.0');
    expect(msg.messageType).toBe('RESPONSE');
    expect(msg.requestId).toBe('123');
    expect(msg.contentLength).toBe(13);
    expect(msg.body).toBe('{"ok":true}');
  });

  test('throws on missing boundary', () => {
    const raw = 'MRCP/2.0 RESPONSE 1 CHAN COMPLETE\r\nContent-Length: 0';
    expect(() => parseMrcpMessage(raw)).toThrow(/boundary/);
  });

  test('event heuristic', () => {
    const raw = [
      'MRCP/2.0 EVENT 55 CHANNEL-9',
      'Event-Name: START-OF-INPUT',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n');
    const msg = parseMrcpMessage(raw);
    expect(isMrcpEventMessage(msg)).toBe(true);
  });
});
