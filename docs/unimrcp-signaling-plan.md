# UniMRCP Signaling 구현 작업 계획

## 목표
RTSP(MRCPv1) 기반 기본 세션 수립(DESCRIBE → SETUP)과 간단한 MRCP 결과 시뮬레이션을 제공하고, 향후 SIP(MRCPv2)/Native 확장에 대비한 구조를 마련한다.

## 범위 (이번 단계) 및 진행 현황
| # | 항목 | 상태 | 비고 |
|---|------|------|------|
| 1 | RTSP SETUP 요청 및 응답 파싱(server_port) | 완료 | `rtspSetup()` 구현 |
| 2 | openSession RTSP 경로 DESCRIBE+SETUP 연속 수행 | 완료 | local RTP 포트 할당 + SETUP 실패 시 SDP 포트 활용 |
| 3 | MRCP partial/final 결과 시뮬레이션 | 완료 | 환경변수 기반 타이머 (partial/final) |
| 4 | SIP 경로 guard 및 경고 | 완료 | `SIP_NOT_IMPLEMENTED` 코드 이벤트 방출 |
| 5 | 에러/폴백 처리 세분화 | 완료 | `RTSP_DESCRIBE_FAILED`, `RTSP_SETUP_FAILED`, `RTSP_FALLBACK_5004` 코드 |
| 6 | 결과 인터벌/타이밍 환경변수 도입 | 완료 | `MRCP_RESULT_PARTIAL_INTERVAL_MS` 등 도입 |
| 7 | RTSP 플로우 단위 테스트 | 완료 | mock RTSP 서버 기반 DESCRIBE/SETUP/SETUP 실패 경로 테스트 |
| 8 | 문서/타입/리팩토링 최종 패스 | 진행중 | types.ts 분리 (이벤트/세션 타입), native 이벤트 필터링 추가 |

## 환경 변수 제안
| 변수 | 기본값 | 설명 |
|------|--------|------|
| MRCP_RESULT_PARTIAL_INTERVAL_MS | 1200 | partial result 주기 |
| MRCP_RESULT_FINAL_AFTER_MS | 7000 | final result 발생 시점(첫 partial 이후 누적) |
| MRCP_RESULT_TEXT | (고정 문장) | 결과 텍스트 기본값(쉼표로 구분 시 랜덤 선택) |
| MRCP_RTP_PORT_MIN | 40000 | 로컬 RTP 포트 범위 시작 |
| MRCP_RTP_PORT_MAX | 40100 | 로컬 RTP 포트 범위 끝 |

## 플로우 개요 (RTSP)
```mermaid
graph TD;
A[openSession()] --> B[RTSP DESCRIBE];
B -->|200 OK + SDP| C[Parse SDP m=audio, a=ptime];
C --> D[Allocate local RTP port];
D --> E[RTSP SETUP (Transport: RTP/AVP;unicast;client_port=R1-R2)];
E -->|200 OK + Transport server_port| F[Store remote RTP ip/port];
F --> G[Emit session ready];
G --> H[Start MRCP result timers (partial/final)];
```

## 에러 및 폴백 전략
| 단계 | 에러 유형 | 대응 |
|------|-----------|------|
| DESCRIBE | timeout / non-200 | SIP 프로필이면 SIP 시도 후 실패 시 fallback → simple stub (5004) |
| SETUP | timeout / non-200 / Transport 헤더 결손 | DESCRIBE SDP의 포트(pt)만 사용(서버 포트 미확정) → 최종 fallback 기본 포트 5004 |
| 결과 타이머 | interval 설정 오류 | 기본값으로 대체 후 경고 |

## 테스트 시나리오
1. 정상 DESCRIBE + SETUP → remotePort 추출 성공
2. DESCRIBE 성공, SETUP 실패 → fallback 포트 경고 노출
3. partial/final 이벤트 시간 순서 및 개수 검증
4. 환경 변수 변경에 따른 partial 주기 단축 확인

## 후속(이번 범위 외)
- SIP INVITE/200/ACK/INFO or MRCP channel over TCP 구현
- Grammar/RECOGNIZE 실제 MRCP message encoding/decoding
- Native binding 통합 및 성능 계측

---
문서 버전: v0.4 (Error Code Enum, SIP Placeholder, Telemetry 추가)

## v0.4 변경 사항
- Error Code Enum `MrcpErrorCode` 도입 (문자열 상수 치환)
- SIP Placeholder 모듈 `sip-client.ts` 추가 (향후 INVITE 트랜잭션 구현 위치 명시)
- Telemetry 수집 유틸 `telemetry.ts` 추가 (partialCount/finalCount/errorCount/lastFinalLatency)
- `unimrcp-signaling.ts` 에 telemetry 및 enum 통합

## 다음 단계 제안 (v0.5+)
| 항목 | 내용 |
|------|------|
| SIP Happy Path | INVITE → 200 OK → ACK 단일 트랜잭션 구현 및 SDP answer 파싱 |
| MRCP Message Frame | 최소한의 MRCP start-line + header 파서/빌더 |
| Grammar / Recognize | 실제 RECOGNIZE 요청/COMPLETE 이벤트 시뮬레이트 또는 native 연동 |
| Metrics Export | Telemetry snapshot을 외부 Prometheus exporter 혹은 로그 집계로 노출 |
| Timeout 세분화 | DESCRIBE/SETUP 개별 timeout + retry 정책 구현 |
