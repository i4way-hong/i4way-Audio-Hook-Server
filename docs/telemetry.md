<!-- Consolidated Phase 1 Telemetry Document -->
# Telemetry Reference (Phase 1 Completion)

본 문서는 MRCP Sidecar 세션/프로토콜 Telemetry 전 범위를 Phase 1 마감 시점 기준으로 통합 정리합니다.

## 1. 수집 레이어 개요
| 레이어 | 역할 | 비고 |
|--------|------|------|
| Per-Session Telemetry (MrcpTelemetry) | 세션 단위 이벤트/카운터 누적 | `session.getTelemetry()` |
| Prometheus Exporter | 누적/집계/라벨 변환 | /metrics_endpoint |
| Network Simulator (테스트) | UDP 송신 drop/지연 주입 | 테스트 전용 env 제어 |

## 2~12 세부 (기존 문단 통합)
아래는 Phase 1 동안 정의된 모든 필드/메트릭/시뮬레이터 변수입니다. 중복 표기는 최신 규칙으로 재정렬했습니다.

## 2. 세션/결과 이벤트 필드
| 필드 | 타입 | 설명 |
|------|------|------|
| version | number | Telemetry 스키마 버전 (현재 2) |
| startedAt / endedAt | number(ms) | 세션 시작/종료 시각 |
| sessionDurationMs | number? | 종료 후 계산 |
| partialCount / finalCount | number | 인식 이벤트 수 |
| resultEventsTotal | number | partial + final |
| resultTextBytes | number | 텍스트 결과 UTF-8 총 바이트 |
| lastFinalLatencyMs | number? | 최종 결과 latency 필드 |
| errorCount | number | error 이벤트 수 |
| lastErrorCode | string? | 마지막 error code |
| sessionsClosed | number | (현재 0|1) 세션 종료 기록 |

## 3. SIP / RTSP / Fallback 카운터
| 필드 | 설명 |
|------|------|
| sipAttempts / sipSuccess / sipFail | 전체 SIP 시도/성공/최종 실패 |
| sipUdpAttempts / sipUdpSuccess / sipUdpFail | UDP 경로 세부 |
| sipTcpAttempts / sipTcpSuccess / sipTcpFail | TCP 경로 세부 |
| inviteRetries | (attempts - 1) 재전송 횟수 (>0 시 노출) |
| inviteTimeouts | Timer B 기반 실패 횟수 |
| sipProvisional | 1xx 수신 횟수 |
| sipInviteRetransmits | 1차 전송 이후 재전송 카운트 |
| sipCodecOffered / sipCodecSelected | SDP offer codec 개수 / answer 선택명 |
| sipInviteRttSumMs / sipInviteRttCount | RTT 누적/샘플 수 |
| sessionsSip | SIP로 확립된 세션 (0|1) |
| sessionsRtsp | RTSP로 확립된 세션 (0|1) |
| fallback5004Count | SIP/RTSP 모두 실패 후 단순 포트 fallback |

파생: averageInviteRttMs = Sum / Count.

## 4. RTSP 세부
| 필드 | 설명 |
|------|------|
| rtspDescribeAttempts / rtspDescribeFail | DESCRIBE 재시도/최종 실패 |
| rtspSetupAttempts / rtspSetupFail | SETUP 재시도/최종 실패 |

## 5. RTP 관측
| 필드 | 설명 |
|------|------|
| rtpPacketsReceived | MRCP_ENABLE_RTP_LISTEN 활성 시 관찰 패킷 수 |

## 6. MRCP 채널 (Stub)
| 필드 | 설명 |
|------|------|
| sessionsMrcpChannel | Stub 채널 생성 세션 카운터 |

## 7. Prometheus 매핑 (요약)
| Metric | From | 비고 |
|--------|------|------|
| mrcp_sip_attempts_total | sipAttempts | counter |
| mrcp_sip_invite_timeouts_total | inviteTimeouts | counter |
| mrcp_sip_invite_retransmits_total | sipInviteRetransmits | counter |
| mrcp_sip_provisional_total | sipProvisional | counter |
| mrcp_rtp_packets_received_total | rtpPacketsReceived | counter |
| mrcp_sip_codec_offered | sipCodecOffered | gauge |
| mrcp_sip_codec_selected{codec} | sipCodecSelected | gauge=1 label codec |
| mrcp_sessions | sessionsSip + sessionsRtsp + fallback | counter aggregate |

## 8. 네트워크 시뮬레이터 ENV (테스트)
| 변수 | 설명 |
|------|------|
| MRCP_SIP_TEST_PACKET_DROP_RATE | 1차 전송(또는 persistent) 드롭 확률 |
| MRCP_SIP_TEST_PACKET_DELAY_MS | 고정 지연 |
| MRCP_SIP_TEST_PACKET_JITTER_MS | +/- 지터 범위 |
| MRCP_SIP_TEST_SEED | RNG 시드 |
| MRCP_SIP_TEST_PERSISTENT_DROP | '1' 재전송에도 확률 적용 |
| MRCP_SIP_TEST_LOG | '1' 결정 로그 출력 |
| MRCP_TEST_ALLOW_LOW_TIMEOUT | SIP 타임아웃 하한 우회 (테스트) |

## 9. 사용 예시 (코드)
```ts
const session = await openSession({ endpoint: 'sip://127.0.0.1:5060/unimrcp', profileId: 'ah-mrcpv2', codec: 'PCMU', sampleRate: 8000 });
// ... 음성 처리 후
session.close();
const snap = session.getTelemetry();
console.log('inviteTimeouts', snap.inviteTimeouts);
```

## 10. PromQL 예시
```
rate(mrcp_sip_invite_retransmits_total[5m])
rate(mrcp_sip_invite_timeouts_total[5m]) / rate(mrcp_sip_attempts_total[5m])
rate(mrcp_rtp_packets_received_total[1m])
```

## 11. 트러블슈팅 매핑
| 증상 | 확인 우선 순위 |
|------|----------------|
| SIP 빈번 타임아웃 | inviteTimeouts, sipInviteRttSumMs 증가, 네트워크 시뮬레이터 비의도 설정 여부 |
| RTT 급증 | averageInviteRttMs 추세 + drop_rate env 확인 |
| RTP 무수신 | rtpPacketsReceived=0 + SDP remotePort 검사 |

## 12. 버전 이력
| 버전 | 변경 요약 |
|------|-----------|
| v2 | SIP UDP/TCP 분리 카운터, codec metrics, RTT 집계, network simulator hook |
| v1 | 기본 세션/RTSP 카운터 |

## 13. Phase 2 미리보기 (제안)
- RTT histogram (p50/p95/p99)
- codec negotiation 실패 유형 카운터 (unsupported-answer, answer-mismatch)
- retransmit 분포(hist)
- 채널 이벤트 latency 측정 (partial→final)

---
Phase 1 완료 기준 문서. 변경 시 CHANGELOG 및 본 문서 동시 갱신.
