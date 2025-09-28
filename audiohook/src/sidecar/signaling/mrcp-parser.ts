/*
 Minimal MRCP message parser (skeleton).
 MRCPv2 message framing (simplified):
   Start-Line: MRCP/2.0 <message-type> <request-id> <channel-id> <request-state?>
   Followed by headers each on its own line: Name: value
   An empty line (CRLFCRLF) then optional body (length may be inferred from Content-Length or present until socket framing boundary).

 For now we only parse a simplified variant used by test scaffolding:
   - Accepts any first line, splits by spaces
   - Collects headers into a lowercase map
   - Extracts Content-Length (number) if present
   - Returns remaining body slice (not validating length thoroughly yet)
*/

export interface MrcpMessage {
  startLine: string;
  version?: string; // e.g. MRCP/2.0
  messageType?: string; // e.g. RESPONSE, EVENT, REQUEST (simplified token)
  requestId?: string; // numeric or token
  channelId?: string; // channel identifier
  requestState?: string; // COMPLETE / IN-PROGRESS (for responses)
  headers: Record<string,string>;
  body: string;
  contentLength?: number;
}

export function parseMrcpMessage(raw: string): MrcpMessage {
  const boundaryIdx = raw.indexOf('\r\n\r\n');
  if (boundaryIdx === -1) {
    throw new Error('MRCP message missing header/body boundary');
  }
  const headerPart = raw.substring(0, boundaryIdx);
  const body = raw.substring(boundaryIdx + 4);
  const lines = headerPart.split(/\r\n/);
  if (!lines.length) throw new Error('Empty MRCP message');
  const startLine = lines[0];
  const tokens = startLine.trim().split(/\s+/);
  const [version, messageType, requestId, channelId, requestState] = tokens;
  const headers: Record<string,string> = {};
  for (let i=1;i<lines.length;i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.indexOf(':');
    if (c === -1) continue;
    const k = line.substring(0,c).trim().toLowerCase();
    const v = line.substring(c+1).trim();
    headers[k] = v;
  }
  let contentLength: number | undefined;
  if (headers['content-length']) {
    const n = Number(headers['content-length']);
    if (Number.isFinite(n) && n >= 0) contentLength = n;
  }
  return {
    startLine,
    version,
    messageType,
    requestId,
    channelId,
    requestState,
    headers,
    body,
    contentLength,
  };
}

export function isMrcpEventMessage(msg: MrcpMessage): boolean {
  // Heuristic: messageType 'EVENT' or presence of header like 'event-name'
  return (msg.messageType?.toUpperCase() === 'EVENT') || !!msg.headers['event-name'];
}
