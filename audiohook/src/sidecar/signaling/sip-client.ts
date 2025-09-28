/*
  SIP (MRCPv2) Placeholder Module
  --------------------------------
  목적:
    - 향후 INVITE / 200 OK / ACK 시그널링 및 MRCP 채널 설정 로직 구현 위치
    - 현재는 타입/스텁만 정의하여 unimrcp-signaling.ts에서 guard 후 대체할 수 있도록 함

  TODO (향후 단계):
    1. INVITE 생성 (Via, From/To, Call-ID, CSeq, Contact, SDP Offer)
    2. 트랜잭션 레벨 타임아웃 및 재전송 정책 (RFC 3261 T1/T2 기반)
    3. 100 Trying / 180 Ringing / 200 OK 처리 및 SDP Answer 파싱
    4. ACK 전송 및 MRCP Channel (TCP) Establish
    5. MRCP 메시지 framing (start-line + headers + body) encoder/decoder
    6. BYE / 재협상 (Re-INVITE) / 세션 종료 처리
    7. 에러 코드 매핑 (네트워크/프로토콜/SDP 불일치)

  Notes:
    - 단순화를 위해 첫 구현은 UDP (stateless) INVITE → 200 OK → ACK happy path 중심
    - 추후 DNS SRV / 로드밸런싱 / TLS(sips:) 고려
*/

export interface SipInviteResult {
  remotePort: number;
  payloadType?: number;
  ptimeMs?: number;
}

export async function performSipInvite(endpoint: string, localIp: string, localPort: number, payloadType: number): Promise<SipInviteResult> {
  // 현재는 unimplemented 상태: 상위에서 guard 후 사용되지 않음.
  throw new Error('SIP signaling not yet implemented (placeholder)');
}
