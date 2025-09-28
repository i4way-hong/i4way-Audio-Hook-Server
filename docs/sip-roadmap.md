# SIP (MRCPv2) 확장 로드맵

현재 상태(summary):
- `sip-v2.ts` 는 실 SIP/UDP 대신 단순 TCP 소켓을 이용한 최소 INVITE 스켈레톤 (retry/timeout telemetry 목적)
- Via/From/To/Call-ID/Contact/CSeq/Max-Forwards 등 정식 SIP 헤더 미구현
- SDP 처리: 최소 수준 (answer만 필요 부분 파싱)
- 재전송 타이머(T1/T2), Transaction Layer, Dialog State 미구현

## 목표 단계
| 단계 | 범위 | 산출물 | 리스크 |
|------|------|--------|--------|
| 1 | UDP 소켓 기반 INVITE/200/ACK 왕복 | 기본 SIP handshake | NAT 환경, 포트 바인딩 실패 |
| 2 | Transaction Layer (ClientInvite / Non-Invite) + retransmit | 신뢰성 향상 | 타임아웃 파라미터 튜닝 필요 |
| 3 | Dialog state (Early/Confirmed) + BYE 처리 | 세션 수명 관리 | 상태 동기화 버그 |
| 4 | SIP Error (4xx/5xx/6xx) 매핑 → telemetry 확장 | 세분화된 오류 코드 | 매핑 과도 세분화시 복잡도 증가 |
| 5 | SDP 방향성 (sendrecv/sendonly) & codec 협상 확장 | 미디어 호환성 | Codec 테이블 관리 |
| 6 | Auth (Digest) 선택적 지원 | 보안 요구 대응 | 재시도 루프 관리 |
| 7 | TLS (sips:) 지원 | 암호화 | 인증서 배포/검증 |
| 8 | 회선 품질 통계(RTCP) 수집 (확장) | 품질 지표 | 추가 포트 처리 |

## 세부 구현 노트
### 1. UDP INVITE 기본
- dgram socket bind (0.0.0.0:0)
- INVITE 헤더 필수 요소:
```
INVITE sip:asr@host:5060 SIP/2.0
Via: SIP/2.0/UDP <local-ip>:<port>;branch=z9hG4bK<rand>
Max-Forwards: 70
From: <sip:client@local>;tag=<tag>
To: <sip:asr@host>
Call-ID: <uuid@local>
CSeq: 1 INVITE
Contact: <sip:client@<local-ip>:<port>>
Content-Type: application/sdp
Content-Length: <len>\r\n\r\n<SDP>
```
- 100 Trying / 180 Ringing 수신은 로그만
- 200 OK 수신 시 SDP 파싱 후 ACK 전송

### 2. Transaction Layer
- INVITE Client Transaction 상태: Calling → Proceeding → Completed
- Timer A (retransmit INVITE), Timer B (overall timeout)
- Non-invite(ACK 제외) 재전송 규칙 별도

### 3. Telemetry 확장 필드 제안
| 필드 | 설명 |
|------|------|
| sipProvisional | 1xx 수신 횟수 |
| sipInviteTimeouts | 재전송 최대 후 실패 |
| sipError4xx / 5xx / 6xx | 최종 응답 카테고리 카운트 |
| sipAuthChallenges | 401/407 횟수 |

### 4. 설정(Environment) 추가 제안
| 변수 | 기본 | 설명 |
|------|------|------|
| MRCP_SIP_TRANSPORT | udp | udp|tcp|tls 선택 |
| MRCP_SIP_RETRANS_T1_MS | 500 | Timer T1 |
| MRCP_SIP_RETRANS_T2_MS | 4000 | Timer T2 (상한) |
| MRCP_SIP_INVITE_MAX_RETRANS | 7 | INVITE 재전송 최대 |
| MRCP_SIP_DNS_SRV | 0 | SRV lookup 활성화 여부 |

### 5. BYE 처리
- 세션 종료 시 BYE 생성, 200 OK 수신 또는 타임아웃 로깅
- Telemetry: `sipByeSent`, `sipByeAcksMissing` (필요 시)

### 6. 인증 (Digest)
- 401/407 응답 시 WWW-Authenticate / Proxy-Authenticate 파싱
- nonce / realm / qop 처리
- HA1 / HA2 / response 계산 후 Authorization 헤더 포함 재전송

### 7. TLS
- `dgram` 대신 `tls.connect` (TCP 기반) 또는 `DTLS` (난이도 상승, 별도 라이브러리 검토)
- 인증서 핀닝/검증 옵션 환경변수화

### 8. 테스트 전략
| 유형 | 기법 |
|------|------|
| 단위 | 헤더 빌더, branch/tag 생성기 pure test |
| 통합(mock) | UDP 에코/지연/드롭 소켓 harness |
| 회귀 | 시나리오: 정상, 180만 반복 후 200, 4xx 즉시, 재전송 타임아웃 |
| 성능 | 초당 N INVITE 동시 세션 수립 영향 측정 |

### 9. 점진 배포 전략
1. UDP INVITE only (fallback 기존 로직 유지)
2. 환경변수로 SIPv2 실험 플래그 (`MRCP_ENABLE_SIP_V2=1`)
3. 안정성 및 telemetry 검증 후 기본값 전환 평가

---
향후 변경 시 이 문서 업데이트: 구현된 단계에 체크 표시 + 실제 필드명/환경명 최종 확정.
