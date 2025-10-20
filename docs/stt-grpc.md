# gRPC STT 연동 가이드 (초안)

## 개요
`proto/speech_transcription.proto` 에 정의된 `SpeechTranscription` 서비스의 `StreamingRecognize` 메서드는 양방향 스트리밍으로 오디오 업스트림 및 실시간 텍스트 다운스트림을 제공합니다.

## 환경 변수 (클라이언트 Forwarder)
내장 gRPC 서버는 2025-09-30 날짜로 제거되었습니다. 이제 모든 gRPC 관련 설정은 외부 STT 서비스(또는 `stt_grpc_test` 테스트 서버)에 접속하는 클라이언트 Forwarder 기준입니다.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| STT_PROTOCOL | grpc | STT 포워더를 gRPC 로 사용하려면 `grpc` |
| STT_ENDPOINT | localhost:50051 | gRPC 서버 (host:port) |
| STT_RATE | 8000 | SessionInit sample_rate_hz |
| STT_ENCODING | L16 | L16 또는 PCMU (SessionInit encoding 매핑) |
| STT_RECONNECT_ENABLED | false | (공통) 재연결 기본 토글 (WS/TCP/gRPC 기본값) |
| STT_GRPC_RECONNECT_ENABLED | (없음) | gRPC 전용 재연결 토글 (없으면 STT_RECONNECT_ENABLED 사용) |
| STT_GRPC_RECONNECT_INITIAL_MS | (없음) | 초기 backoff (기본 1000ms 가정) |
| STT_GRPC_RECONNECT_MAX_MS | (없음) | 최대 backoff (기본 5000~15000 범위 권장) |
| STT_GRPC_RECONNECT_FACTOR | 2.0 | 지수 증가 배수 |
| STT_GRPC_RECONNECT_JITTER | 0.3 | 0~1 사이 Jitter 비율 |
| STT_GRPC_AUTH_TOKEN | (없음) | Metadata Authorization Bearer 토큰 (클라이언트가 전송) |
| STT_GRPC_TLS_ENABLED | false | 클라이언트 TLS 활성화 |
| STT_GRPC_TLS_CA_FILE | (없음) | 루트 CA 번들 (self-signed / 사설 CA) |
| STT_GRPC_TLS_CERT_FILE | (없음) | mTLS 클라이언트 cert |
| STT_GRPC_TLS_KEY_FILE | (없음) | mTLS 클라이언트 key |
| STT_GRPC_TLS_OVERRIDE_AUTHORITY | (없음) | SNI/authority override (LB/SAN 불일치) |
| STT_GRPC_KEEPALIVE_MS | (없음) | keepalive ping 주기 (ms) |
| TRACEPARENT | (없음) | 분산 추적 traceparent 헤더 값 |

삭제/폐기(deprecated)된 변수: `GRPC_ENABLED`, `GRPC_PORT`, `GRPC_TLS_CERT`, `GRPC_TLS_KEY`, `GRPC_TLS_CA`, `GRPC_AUTH_TOKEN` (내장 서버 제거로 더 이상 사용되지 않음)

## 외부 gRPC STT 서버 사용
내장 서버는 제거되었습니다. 아래 두 가지 선택지가 있습니다:

1. 실제 벤더/내부 STT gRPC 서비스 엔드포인트 (예: `stt.example.com:443`)
2. 레포 내 테스트용 시뮬레이터: `stt_grpc_test` 디렉터리

### 테스트 서버 실행 예
```
cd stt_grpc_test
npm install
set GRPC_TEST_PORT=55051
npm start
```

Forwarder 클라이언트 환경 예 (PowerShell):
```
set STT_PROTOCOL=grpc
set STT_ENDPOINT=localhost:55051
set STT_GRPC_AUTH_TOKEN=secret123
set STT_GRPC_TLS_ENABLED=0
npm start
```

TLS/mTLS 클라이언트 예:
```
set STT_GRPC_TLS_ENABLED=1
set STT_GRPC_TLS_CA_FILE=certs/ca.pem
set STT_GRPC_TLS_CERT_FILE=certs/client.crt
set STT_GRPC_TLS_KEY_FILE=certs/client.key
set STT_GRPC_TLS_OVERRIDE_AUTHORITY=stt.example.com
```

## 스트리밍 절차 요약 (클라이언트)
1. 스트림 오픈 후 첫 메시지로 `init` 필드(`SessionInit`) 전송
2. `audio` 메시지(순차 sequence 증가) 반복 전송
3. 필요 시 `control` 메시지로 PAUSE/RESUME/FINALIZE 등 사용
4. 마지막 오디오에 `end_of_stream=true` 설정하거나 FINALIZE 제어 메시지 전송
5. 서버는 `ready` → `transcript`(partial/final) → `control_ack` → 종료 순으로 응답 가능

## 예제 (pseudo-code / Node.js)
```js
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const def = protoLoader.loadSync('proto/speech_transcription.proto', { longs: String, enums: String, defaults: true, oneofs: true });
const pkg = grpc.loadPackageDefinition(def);
const meta = new grpc.Metadata();
meta.set('authorization', 'Bearer secret123');
const client = new pkg.audiohook.stt.v1.SpeechTranscription('localhost:50051', grpc.credentials.createInsecure());
const stream = client.StreamingRecognize(meta);
stream.on('data', msg => console.log('RX', msg));
stream.write({ init: { language_code: 'ko-KR', sample_rate_hz: 8000, encoding: 'LINEAR16', enable_interim_results: true } });
// 오디오 chunk 예시 (PCM16 LE 모노)
stream.write({ audio: { data: Buffer.alloc(320), sequence: 0 } });
// ...
stream.end();
```

## 내부 구현 구성요소
- `audiohook/src/server/stt-forwarder.ts` : `GrpcForwarder` bidirectional stream 생성 / 재연결 관리 / transcript 집계
- `proto/speech_transcription.proto` : 서비스 / 메시지 정의
- `stt_grpc_test/server.js` : 독립 테스트 gRPC STT 시뮬레이터 (프로덕션 서버 대체용 아님)

## 향후 계획 (추천)
- OpenTelemetry TraceContext → gRPC Metadata 변환 (traceparent)
- 백프레셔 및 큐 사이즈 메트릭 수집 (Prometheus exporter)
- Vendor plugin 레이어를 gRPC 응답에도 적용 (현재 로그 중심)
- AudioChunk 압축(옵션) / Opus 지원

## 장애 대응 & 재연결 (지수 + Jitter)
`GrpcForwarder` 는 스트림 오류/종료 시 지수 백오프 + 중앙 정렬 Jitter 로 재연결을 시도합니다.

지연 계산:
```
attempt = 0,1,2,...
raw = base * factor^attempt
delay = clamp(raw, 10, max)
jitterRange = delay * JITTER   # JITTER = STT_GRPC_RECONNECT_JITTER (기본 0.3)
finalDelay = delay - jitterRange/2 + random(0, jitterRange)
```
성공 시 attempt=0으로 리셋. 실패 시 attempt 증가.

예시 로그:
```
STT gRPC reconnect attempt=3 in 4200 ms (base=1000 max=15000 factor=2 jitter=0.3)
```

## 클라이언트 TLS (Forwarder)
환경 변수로 TLS/mTLS 활성화:
```
set STT_PROTOCOL=grpc
set STT_ENDPOINT=stt.example.com:443
set STT_GRPC_TLS_ENABLED=1
set STT_GRPC_TLS_CA_FILE=certs/ca.pem
set STT_GRPC_TLS_CERT_FILE=certs/client.crt
set STT_GRPC_TLS_KEY_FILE=certs/client.key
set STT_GRPC_TLS_OVERRIDE_AUTHORITY=stt.example.com
```

문제 해결:
- self-signed: CA 파일 지정
- SAN 불일치: override authority 설정
- handshake 실패: 서버 측 포트/방화벽/TLS 버전 확인

## Trace 전파
`TRACEPARENT` 설정 시 Metadata `traceparent` + init.trace_context.traceparent 동시 삽입 → 다운스트림에서 동일 Trace 스팬 연결 용이.

## 부분/최종 Transcript 집계 & Vendor Hook
Partial 은 내부 버퍼에 저장, Final 수신 시 결합 후 로그 및 vendor `handleTranscript(final=true)` 호출.
Final 이 아닌 partial 도 vendor hook 에 final=false 로 전달.

## 벤치마크 스크립트
`scripts/grpc_bench.ts` : 다중 세션 무음 패킷 전송으로 Throughput 관찰.
```
npx ts-node scripts/grpc_bench.ts --sessions=12 --seconds=20 --rate=8000 --bytes=320
```
지표: writes/sec, transcripts/sec, finals.

개선 아이디어: 지연 측정 (write→final), 히스토그램(p95,p99), 실제 WAV feeding.

## 변경 이력
- 2025-09-30 : 내장 gRPC 서버 제거, 문서/환경 변수 정리 (GRPC_* → STT_GRPC_* 클라이언트 전용)
- 2025-09-29 : 클라이언트 TLS, 지수+Jitter 재연결, trace 전파, transcript hook, 벤치 스크립트 추가
- 2025-09-29 : 초기 초안 추가
