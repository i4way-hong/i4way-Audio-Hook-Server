# STT gRPC Test Server

경량 gRPC STT 테스트 서버 (내장 서비스와 독립적으로 동작)\n
기능 요약:
- Bidirectional StreamingRecognize (init -> ready -> audio partial/final)
- HealthCheck
- UploadContext (phrases count echo)
- Authorization 메타데이터 (옵션)
- TLS / mTLS (옵션)
- transcript 주기 및 final 지연 환경 변수로 조정

## 환경 변수 (.env 또는 PowerShell $env:...)
| 변수 | 기본 | 설명 |
|------|------|------|
| GRPC_TEST_PORT | 55051 | 리스닝 포트 |
| GRPC_TEST_AUTH_TOKEN | (없음) | 설정 시 Authorization: Bearer 토큰 필요 |
| GRPC_TEST_TLS_CERT / KEY | (없음) | 서버 인증서/키 경로 (존재 시 TLS) |
| GRPC_TEST_TLS_CA | (없음) | 설정 시 mTLS (클라이언트 인증 요구) |
| TRANSCRIPT_INTERVAL | 12 | audio.sequence N 마다 partial 전송 |
| FINAL_DELAY_MS | 250 | end_of_stream / FINALIZE 후 final 지연(ms) |
| ECHO_TEXT | (없음) | 설정 시 partial/ final 텍스트를 고정 문자열로 통일 (테스트 재현성) |
| RANDOM_FINAL_ERROR_RATE | 0 | 0~1 사이 확률로 final 대신 에러(event) 주입 (복구 시나리오 테스트) |
| LATENCY_LOG | 1 | 1/true 일 때 초기화→partial/종료 latency 로그(debug) 출력 |
| BACKPRESSURE_ENABLED | 0 | 1/true 시 오디오 프레임을 내부 큐에 적재하여 처리 지연 시뮬레이션 |
| BACKPRESSURE_MAX_QUEUE | 200 | 큐 최대 길이 (초과 시 RESOURCE_EXHAUSTED error 이벤트) |
| BACKPRESSURE_PROCESS_MS | 0 | 각 오디오 프레임 처리(소비) 인위적 지연 ms |
| CPU_SPIN_MS | 0 | partial/final 전송 직전에 busy spin 할 시간 (CPu 부하) |
| RANDOM_STREAM_ERROR_RATE | 0 | 스트림 중(partial 타이밍) 비致fatal 에러 이벤트 삽입 확률 |
| RANDOM_STREAM_ERROR_CODES | INTERNAL,RESOURCE_EXHAUSTED,ABORTED | 위 확률 적용 시 랜덤 선택 코드 목록 |
| RANDOM_FINAL_ERROR_CODES | INTERNAL | final 에러 주입 시 사용할 코드 후보 목록 |
| GRPC_TEST_PROTO_PATH | (자동 탐색) | 기본 proto 경로 탐색 실패 시 명시적 지정 (speech_transcription.proto 위치) |

## 실행
```
cd stt_grpc_test
npm install
npm start
```

헬스체크 (로그 확인): 서버 시작 시 JSON 로그 출력 / HealthCheck RPC 호출 가능

## 간단 클라이언트 샘플 (grpcurl)
init -> ready 수신 테스트:
```
grpcurl -plaintext -d '{"init":{"language_code":"ko-KR","sample_rate_hz":8000,"encoding":"LINEAR16"},"client_session_id":"demo"}' localhost:55051 audiohook.stt.v1.SpeechTranscription/StreamingRecognize
```
(위는 단발 unary가 아니므로 스트리밍 유지 필요; grpcurl --stdin 등 활용)

## 주의 / 팁
- proto-loader 설정(keepCase=false) 때문에 JS 객체에서 proto의 snake_case 필드가 camelCase로 노출됩니다. 예: `server_session_id` -> `serverSessionId`, `model_id` -> `modelId`. 서버/클라이언트 코드 모두 camelCase로 접근/전송하도록 유지하세요.
- 실제 STT 엔진 아님: 음성 처리 없이 sequence 기반 샘플 partial 문장 생성
- 재현성 필요하면 `ECHO_TEXT="hello" TRANSCRIPT_INTERVAL=3` 같이 설정
- 장애 시나리오: `RANDOM_FINAL_ERROR_RATE=0.2` 로 20% 확률 final error 주입
- 스트림 중 오류: `RANDOM_STREAM_ERROR_RATE=0.1 RANDOM_STREAM_ERROR_CODES=INTERNAL,ABORTED`
- Backpressure: `BACKPRESSURE_ENABLED=1 BACKPRESSURE_PROCESS_MS=15 BACKPRESSURE_MAX_QUEUE=50`
- CPU 부하: `CPU_SPIN_MS=5` (주의: busy loop라 단일 스레드 100% 가까이 갈 수 있음)
- latency 측정: debug 로그에서 firstPartialLatencyMs / sessionDurationMs 확인
- mTLS 사용 시 클라이언트도 동일 CA로 서명된 cert/key 필요
- proto 경로 문제 발생 시: `GRPC_TEST_PROTO_PATH=../proto/speech_transcription.proto` 형태로 절대/상대 지정
