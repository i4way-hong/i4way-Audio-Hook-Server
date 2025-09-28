import { MrcpStreamParser } from '../../src/sidecar/signaling/mrcp-stream-parser';

function buildMsg(len: number, body: string): string {
  return [
    'MRCP/2.0 EVENT 1 CHAN START',
    `Content-Length: ${len}`,
    '',
    body,
  ].join('\r\n');
}

describe('MrcpStreamParser', () => {
  test('parses single message', () => {
    const msgs: any[] = [];
    const p = new MrcpStreamParser(m => msgs.push(m));
    const body = '{"a":1}';
    p.push(Buffer.from(buildMsg(body.length, body)));
    expect(msgs.length).toBe(1);
    expect(msgs[0].body).toBe(body);
  });

  test('parses multiple concatenated messages', () => {
    const msgs: any[] = [];
    const p = new MrcpStreamParser(m => msgs.push(m));
    const b1 = '{"x":1}';
    const b2 = '{"y":2}';
    const raw = buildMsg(b1.length, b1) + buildMsg(b2.length, b2);
    p.push(raw);
    expect(msgs.length).toBe(2);
  });

  test('invalid content-length triggers onError and resets buffer', () => {
    let err: Error | null = null;
    const p = new MrcpStreamParser(() => {}, (e) => { err = e; });
    const raw = [
      'MRCP/2.0 EVENT 1 CHAN START',
      'Content-Length: 999999999', // too big
      '',
      '',
    ].join('\r\n');
    p.push(raw);
    expect(err).toBeTruthy();
  });
});
