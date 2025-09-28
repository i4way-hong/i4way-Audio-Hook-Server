# MRCP Signaling Telemetry

이 문서는 `openSession()` 으로 생성된 세션의 `session.getTelemetry()` 스냅샷 필드와 의미를 정의합니다.

## 사용 방법
```ts
const session = await openSession({ endpoint, profileId, codec: 'PCMU' });
const snap = session.getTelemetry();
console.log(snap);
```
스냅샷은 불변 객체이며 호출 시점까지 누적된 카운터 snapshot 입니다.

## 필드 정의
| 필드 | 타입 | 의미 |
|------|------|------|
| version | number | Telemetry 스키마 버전 (현재 1) |
| partialCount | number | 수신한 partial (중간) 결과 이벤트 수 |
| finalCount | number | 최종 결과 이벤트 수 |
| errorCount | number | `emitter.emit('error', ...)` 로 관찰된 오류 이벤트 수 |
| lastFinalLatencyMs | number? | 마지막 final 결과 이벤트에 포함된 latencyMs 값 (있다면) |
| startedAt | number (epoch ms) | Telemetry 인스턴스 생성 시각 |
| resultEventsTotal | number | result 이벤트 총 개수 (partial + final) |
| resultTextBytes | number | result 이벤트의 text 필드 UTF-8 바이트 누적 합 |
| inviteRetries | number? | SIP INVITE 재시도 횟수 (성공 혹은 실패까지 시도한 추가 횟수; 1회 이상일 때만 노출) |
| inviteTimeouts | number? | SIP INVITE 시도 중 timeout 으로 간주된 횟수 (1회 이상일 때만 노출) |
| sipAttempts | number | SIP INVITE 시도 총 수 (timeout 포함) |
| sipSuccess | number | SIP INVITE 성공 횟수 (현재 구현에서는 0 또는 1) |
| sipFail | number | SIP INVITE 완전 실패(모든 재시도 실패) 횟수 |
| rtspDescribeAttempts | number | RTSP DESCRIBE 시도 횟수 (재시도 포함) |
| rtspDescribeFail | number | DESCRIBE 최종 실패 횟수 (fallback 유발) |
| rtspSetupAttempts | number | RTSP SETUP 시도 횟수 |
| rtspSetupFail | number | SETUP 최종 실패 횟수 (SDP port fallback 사용) |
| fallback5004Count | number | DESCRIBE / SETUP 모두 실패하여 최종 5004 기본 포트 fallback 사용한 횟수 |
| sessionsSip | number | 이 Telemetry 객체 하에서 SIP 전송방식 세션 수 (현재 0 또는 1) |
| sessionsRtsp | number | RTSP 전송방식 세션 수 (현재 0 또는 1, fallback 포함) |
| lastErrorCode | string? | 마지막 오류 이벤트의 `code` (예: SIP_INVITE_FAILED, RTSP_FALLBACK_5004 등) |
| rtpPacketsReceived | number? | (옵션) RTP listen 활성화 시 관측된 RTP 패킷 수 |

### inviteRetries 계산식
- 시도 횟수 = attempts
- 최초 attempt 는 재시도가 아니므로 `inviteRetries = attempts - 1` (단, attempts > 1 일 때만).
- 성공이든 실패든 최종 종료 시점에 누적.

### inviteTimeouts 증가 조건
- 개별 attempt 에서 timeout string 을 포함한 실패 메시지가 발생한 경우.

## Snapshot 호출 비용
단순한 POJO 생성이므로 가볍습니다. 고빈도(초당 수 회) 호출 가능하지만, 밀리초 단위 polling 은 권장하지 않습니다.

## Error Buffer (`session.getBufferedErrors()`)
- 최근 최대 10개의 error 이벤트 객체를 보관.
- Telemetry 카운터와는 별개로, 초기 listener 부착 이전 오류도 접근 가능.

## 확장 가이드
새로운 카운터 추가 시:
1. `MrcpTelemetry` private 필드 & 증가 메서드 추가
2. `snapshot()` 리턴 객체에 필드 포함 (0일 때 노출 여부 정책 결정)
3. 테스트 추가 (성공/실패/경계 케이스)

## 예시 출력 (version 1)
```json
{
  "version": 1,
  "partialCount": 3,
  "finalCount": 1,
  "errorCount": 0,
  "lastFinalLatencyMs": 712,
  "startedAt": 1758871500123,
  "resultEventsTotal": 4,
  "resultTextBytes": 57,
  "inviteRetries": 1,
  "inviteTimeouts": 1,
  "sipAttempts": 2,
  "sipSuccess": 1,
  "sipFail": 0,
  "rtspDescribeAttempts": 0,
  "rtspDescribeFail": 0,
  "rtspSetupAttempts": 0,
  "rtspSetupFail": 0,
  "fallback5004Count": 0,
  "sessionsSip": 1,
  "sessionsRtsp": 0,
  "lastErrorCode": "SOME_CODE",
  "rtpPacketsReceived": 42
}
```

## 주의 사항
- 카운터는 프로세스 내 단일 세션 객체 기준 (현재 구현은 세션별 Telemetry). 프로세스 전역 집계가 필요하면 별도 aggregator 레이어 추가 권장.
- Native binding 경로에서도 동일 구조를 유지하도록 추후 확장 시 snapshot 정합성 유지.

## 향후(v2) 확장 예정
- SIP UDP / TCP 분리 카운터 (예: sipUdpAttempts, sipUdpSuccess 등)
- 전역 aggregator (multi-process) 예시
