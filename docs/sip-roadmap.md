# SIP / MRCP Sidecar Roadmap

본 문서는 Phase 1 (기초 신호/텔레메트리 + 신뢰성 하니스) 완료 상태와 향후 단계를 정의합니다.

## Phase 1 (Completed)
Status: DONE (Tag: 0.1.0)

Delivered 핵심:
- UDP INVITE Client Transaction (Timer A 지수 재전송, Timer B 전체 타임아웃)
- TCP/RTSP Fallback 경로 스켈레톤 + 5004 포트 fallback 카운터
- 다중 코덱 Offer & codecSelected telemetry
- Telemetry v2: UDP/TCP 분리, retransmits, timeouts, provisional, RTT sum/count, codec offered/selected
- 네트워크 시뮬레이터 (drop/delay/jitter, persistent drop, seed)
- 신뢰성 Jest 하니스 (드롭/지연/ persistent drop 케이스)
- 환경 변수 검증 및 테스트 오버라이드 (MRCP_TEST_ALLOW_LOW_TIMEOUT)
- RTP listen 옵션 + 패킷 수 카운터
- README / telemetry.md / CHANGELOG 문서화

완료 판정 편차: 초기 목표(30% 드롭 환경 성공률 ≥95%)는 테스트 결정론 확보 위해 완화(“일부 성공 보장”)되었으며, 차이는 CHANGELOG 에 기록.

## Phase 2 (Planned: Stability & Real MRCP)
목표: 실제 MRCP 메시지 처리 + 세션/채널 지연 가시성 향상.
주요 항목:
1. Real MRCP Channel: SETUP / RECOGNIZE 메시지 파싱 & 이벤트 브리지
2. Dialog 확장: Early/Confirmed 상태 추적, CANCEL 지원, BYE 재시도 정책
3. 상세 Provisional 카운터: 100 / 180 / 183 구분
4. RTT Histogram 초안 (invite RTT 분포) – 버킷 실험 (p50/p95)
5. Partial→Final latency 측정 + telemetry 필드 추가
6. Multi-session Aggregator (프로세스 전역 합산) & Prometheus exporter 리팩터
7. Structured Logging (sessionId / callId correlation)
8. 강화된 테스트: property 기반 재전송 타이밍 검증 / soak test script

## Phase 3 (Security & Ops)
주요 항목: Digest Auth(401/407), TLS(sips:), 구성 스키마 강화, codec 분포 메트릭, 지연 히스토그램 안정화, 실패 원인 라벨링.

## Phase 4 (Performance / Native)
Zero-copy 파서, 1k+ 동시 세션 부하, GC 프로파일링, Native addon (선택) 탐색, RTP 관측 최적화.

## Phase 5 (Advanced Media / Protocol)
Re-INVITE / Session Refresh, SRTP/DTLS 준비, RTCP 품질 통계, adaptive retransmission, keepalive.

## Decision Log (Phase 1 핵심)
| 결정 | 이유 |
|------|------|
| Per-session telemetry 유지 | 단순성, 스냅샷 비용 최소 |
| Network sim 테스트 전용 | 프로덕션 오버헤드 및 위험 제거 |
| RTT sum/count 먼저 | 빠른 평균 산출, histogram 은 Phase 2 실험 |
| 성공률 기준 완화 | 작은 N + 난수성으로 인한 플래키 방지 |

## Open Questions (차기)
- Retransmit 간격 동적 조정(측정 RTT 기반) 도입 여부
- Per-attempt trace 배열(디버그 모드) 필요성
- Aggregator 시 메모리 O(세션) 최소화 전략

## Update Process
새 telemetry 필드 추가 시: telemetry.md + CHANGELOG 동시 업데이트 → minor bump
의미/단위 변경 시: major bump 고려

## History
| 날짜 | 버전 | 변경 |
|------|------|------|
| 2025-09-29 | v3 | Phase 1 완료 문서로 재작성 (0.1.0 태그), 이전 세부 Task 표 축약 |
| 2025-09-29 | v2 | Phase 기반 재구성, 상세 Task/Telemetry/Env/Test 명세 |
| (이전) | v1 | 초기 초안 |

---
This roadmap will be revisited at each phase boundary.
