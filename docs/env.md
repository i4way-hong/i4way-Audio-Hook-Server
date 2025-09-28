# MRCP / STT 환경 변수 정리

| 변수 | 기본값 | 설명 |
|------|--------|------|
| MRCP_DISABLE_NATIVE | (unset) | 설정 시 native binding 사용하지 않고 TS fallback 경로 강제 사용 |
| MRCP_FORCE_RTSP | (unset) | SIP 프로필 조건이어도 강제로 RTSP 경로만 사용 |
| MRCP_RTP_PORT_MIN | 40000 | 로컬 RTP 포트 할당 최소값 (짝수/연속 사용 가정) |
| MRCP_RTP_PORT_MAX | 40100 | 로컬 RTP 포트 할당 최대값 |
| MRCP_RTSP_DESCRIBE_RETRIES | 3 | RTSP DESCRIBE 재시도 횟수 (총 시도 수) |
| MRCP_RTSP_SETUP_RETRIES | 2 | RTSP SETUP 재시도 횟수 (총 시도 수) |
| MRCP_SIP_INVITE_RETRIES | 1 | SIP INVITE 재시도 횟수 (총 시도 수) |
| MRCP_SIP_INVITE_TIMEOUT_MS | 4000 | SIP INVITE 단일 attempt timeout(ms) |
| MRCP_DISABLE_FALLBACK5004 | (unset) | 설정 시 RTSP 협상 완전 실패에도 5004 fallback 하지 않고 에러 발생 |
| MRCP_RESULT_PARTIAL_INTERVAL_MS | 1200 | ResultSimulator partial 이벤트 간격 |
| MRCP_RESULT_FINAL_AFTER_MS | 7000 | 첫 partial 이후 final 이벤트 발생 지연 |
| MRCP_RESULT_TEXT | "hello world,quick test,audio hook demo" | 시뮬레이터가 랜덤 선택하는 문장 풀(쉼표/세미콜론 구분) |
| MRCP_TEST_DEBUG | (unset) | 설정 시 RTSP/SIP 네트워크 파싱 디버그 로그 출력 |
| MRCP_ENABLE_RTP_LISTEN | (unset) | 세션 생성 시 추가 UDP 소켓 바인드 후 수신 RTP 패킷 카운트 (관측용) |
| MRCP_ENABLE_SIP_V2 | (unset) | SIP UDP INVITE 스켈레톤 활성화 (실패 시 TCP → RTSP 폴백) |

## 사용 예
PowerShell:
```powershell
$env:MRCP_SIP_INVITE_RETRIES=2
$env:MRCP_SIP_INVITE_TIMEOUT_MS=2500
npm test
```

Bash:
```bash
export MRCP_SIP_INVITE_RETRIES=2
export MRCP_SIP_INVITE_TIMEOUT_MS=2500
npm test
```

## 튜닝 가이드
- 재시도 횟수 증가는 초기 연결 지연(latency) 증가와 트래픽 재시도로 인한 부하 상승 가능.
- RTP 포트 범위는 방화벽 규칙 및 동시 세션 수(capacity)에 맞춰 조정.
- 시뮬레이터용 interval/after 값은 실제 엔진 응답 패턴과 유사하게 튜닝.

## 주의
- `MRCP_FORCE_RTSP` 와 SIP 프로필 동시 사용 시 SIP 로직이 완전히 건너뛰어지므로 SIP 카운터는 0 으로 남습니다.
- Min/Max 포트 범위가 좁거나 충돌 시 `No free RTP port` 오류가 발생할 수 있습니다.

## Metrics 관련
- `/metrics` 엔드포인트는 활성 세션 telemetry snapshot 합산을 노출
- `MRCP_ENABLE_RTP_LISTEN` 활성화 시 `mrcp_rtp_packets_received_total` 증가
- SIP UDP 플래그 활성화 여부는 현재 별도 카운터로 구분되지 않고 sipAttempts 에 합산 (향후 v2 분리 예정)
