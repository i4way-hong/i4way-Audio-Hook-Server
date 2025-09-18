# 앱 `src/` 디렉터리 개요

이 폴더는 Fastify 기반 앱 레이어로, AudioHook 코어(`audiohook/`)를 사용해 WebSocket 엔드포인트를 노출하고, 플러그인(Secrets/DynamoDB) 초기화 및 샘플/시뮬레이터를 제공합니다.

## 최상위 파일
- `src/index.ts`
  - Fastify 서버 부트스트랩. 로깅(pino) 설정, WebSocket 등록, 라우트 및 플러그인 등록.
  - 라우트: `/api/v1/audiohook/ws`, `/api/v1/voicetranscription/ws`, `/api/v1/loadtest/ws`.
- `src/audiohook-sample-endpoint.ts`
  - AudioHook 프로토콜 샘플 WS 엔드포인트. 최소 동작 예시 제공.
- `src/audiohook-load-test-endpoint.ts`
  - 부하/성능 검증용 WS 엔드포인트. 대량 연결/프레임 테스트에 사용.
- `src/audiohook-vt-endpoint.ts`
  - 음성 전사(Voice Transcription) WS 엔드포인트. 시뮬레이터/실전 STT로 확장 진입점.
- `src/authenticator.ts`
  - 세션 인증 로직(API 키 검증 등) 훅.
- `src/create-audiohook-session.ts`
  - AudioHook 서버 세션 생성/초기화 유틸. 엔드포인트 핸들러에서 공통 사용.
- `src/recordedsession.ts`
  - 세션 기록/파일 저장 연계 헬퍼(세션 라이프사이클과 파일 기록 관리).
- `src/service-lifecycle-plugin.ts`
  - 서버 시작/종료 훅 등록. 리소스 초기화·정리 처리.
- `src/secrets-plugin.ts`
  - 시크릿 로딩/캐싱 Fastify 플러그인(AWS Secrets Manager 또는 `.env`).
- `src/dynamodb-plugin.ts`
  - DynamoDB 연결/리소스 Fastify 플러그인.
- `src/dynamodb-utils.ts`
  - DynamoDB 접근 헬퍼(테이블 접근, 공통 쿼리/직렬화).
- `src/datamodel-teststatus.ts`
  - 테스트 상태/메타데이터 데이터모델 정의.
- `src/session-websocket-stats-tracker.ts`
  - 세션 WebSocket 통계/지표 추적(RTT 등) 유틸.
- `src/agentassist-hack.ts`
  - Agent Assist 관련 임시/샘플 처리(빠른 통합을 위한 유틸성 코드).
- `src/wav-writer-demo.ts`
  - WAV 파일 기록 데모(로컬 파일 저장 예시).
- `src/simulated-transcripts.ts`
  - 단순 전사 시뮬레이터 예시. 프레임에서 채널별 버퍼를 추출해 이벤트를 생성, `session.sendEvent`로 전송.

## 앱 역할(서버/클라이언트)
- 기본적으로 이 애플리케이션은 WebSocket 서버입니다(Fastify 기반).
- STT 포워딩이 활성화되면, 각 세션에서 외부 STT 서비스에 대한 WebSocket/TCP 클라이언트 역할을 추가로 수행합니다(오디오 프레임을 외부로 스트리밍).

## `src/sim-transcribe/` 하위
- `src/sim-transcribe/simulated-transcripts.ts`
  - 세션에 VAD(Voice Activity Detection)를 적용해 음성/무음 이벤트를 감지하고, 전사 엔티티로 변환해 전송.
  - 일시정지/재개, 언어 업데이트 처리, 프레임 채널별 처리(스테레오 권장) 포함.
- `src/sim-transcribe/make-transcript.ts`
  - VAD 이벤트를 AudioHook 전사 엔티티 포맷으로 변환하는 로직.
- `src/sim-transcribe/voice-activity-detection/voice-activity-detection.ts`
  - VAD 핵심 로직(버퍼 입력 → 음성/무음 이벤트 검출).
- `src/sim-transcribe/voice-activity-detection/energy-calculator.ts`
  - 프레임 에너지 계산 유틸.
- `src/sim-transcribe/voice-activity-detection/event-type.ts`
  - VAD 이벤트 타입 정의.
- `src/sim-transcribe/voice-activity-detection/voice-event.ts`
  - VAD 이벤트 데이터 구조 정의.

## 참고(코어 연계)
- 코어는 `audiohook/` 폴더에 있으며, 서버 세션/오디오 프레임/프로토콜 정의가 포함됨.
- 파일 저장 및 STT 포워딩은 코어(`audiohook/src/server/*`, `audiohook/src/utils/*`)와 설정(`.env`)로 제어합니다.

## `audiohook/` 코어 모듈 개요
- `audiohook/index.ts`
  - 코어 전체 재노출 배럴. `audiohook/src`의 export를 외부로 노출.
- `audiohook/httpsignature.ts`
  - HTTP Message Signatures 배럴(서명 빌더/검증기 재노출).
- `audiohook/src/index.ts`
  - 서브 배럴. audio/client/protocol/server/utils 하위 모듈을 export.

### audiohook/src/audio
- `audioframe.ts`
  - 오디오 프레임 표현(형식 PCMU/L16, 샘플레이트, 채널), 채널 분리/형식 변환(PCMU↔L16) 유틸 포함.
- `ulaw.ts`
  - u-Law(PCMU) ↔ Linear16 변환 LUT/헬퍼.
- `wav.ts`
  - WAV 파일 쓰기/헤더 관리 `WavFileWriter` 구현.
- `index.ts`
  - 오디오 서브모듈 배럴.

### audiohook/src/client
- `clientsession.ts`
  - 클라이언트 세션 인터페이스/타입 정의.
- `clientsessionimpl.ts`
  - AudioHook 클라이언트 세션 구현(WebSocket 클라이언트 역할, 미디어 송신 등).
- `mediasource.ts`
  - 마이크/파일 등 미디어 소스 추상화.
- `index.ts`
  - 클라이언트 서브모듈 배럴.

### audiohook/src/httpsignature
- `structured-fields.ts`
  - RFC 8941 Structured Fields 파서/직렬화 유틸.
- `signature-builder.ts`
  - HTTP 메시지 서명 생성기.
- `signature-verifier.ts`
  - HTTP 메시지 서명 검증기.
- `index.ts`
  - HTTP Signature 서브모듈 배럴.

### audiohook/src/protocol
- `core.ts`
  - AudioHook 프로토콜 핵심 타입/상수.
- `message.ts`
  - 클라이언트/서버 간 메시지 스키마(Open/Update/Audio/Close 등).
- `entities.ts`
  - 공통 이벤트 엔티티 기본형.
- `entities-transcript.ts`
  - 전사(transcript) 엔티티 정의.
- `entities-agentassist.ts`
  - Agent Assist 관련 엔티티 정의.
- `validators.ts`
  - 메시지/엔티티 유효성 검사기.
- `index.ts`
  - 프로토콜 서브모듈 배럴.

### audiohook/src/server
- `serversession.ts`
  - 서버 세션 인터페이스/이벤트 정의.
- `mediadata.ts`
  - WS 수신 바이트를 `AudioFrame`으로 포장하는 헬퍼.
- `serversessionimpl.ts`
  - 서버 세션 구현(WebSocket 서버측). 파일 기록, 회전, 삭제 감지, 설정 핫리로드, STT 포워딩 훅 포함.
- `stt-forwarder.ts`
  - STT 전송 어댑터. WebSocket과 TCP 구현 제공(원격 STT로 바이너리 오디오 스트리밍). gRPC/MRCP는 스텁 상태.
  - WebSocket: 연결/에러/종료 로깅, 선택적 초기/종료 메시지 전송, 주기 핑, 수신 텍스트/바이너리 로그(미리보기) 지원.
  - TCP: 연결/종료/백프레셔 로깅, 선택적 INIT/BYE(hex) 전송, 프레이밍(raw/newline/len32) 지원, 수신 텍스트 로그(프레이밍 파싱) 지원.
- `index.ts`
  - 서버 서브모듈 배럴.

### audiohook/src/utils
- `config.ts`
  - 녹음 관련 설정 로더(.env 파일/환경변수 핫리로드), 변경 이벤트 발행.
- `stt-config.ts`
  - STT 포워딩 설정 로더(.env 핫리로드). 프로토콜/엔드포인트/헤더/인코딩/샘플레이트 등.
- `logger.ts`
  - 로깅 유틸.
- `promise.ts`
  - Promise 유틸.
- `streamduration.ts`
  - 스트림 시간/오프셋 계산 유틸.
- `timeprovider.ts`
  - 시간 소스 추상화.
- `error.ts`
  - 에러 정규화/스택 로깅 유틸.
- `index.ts`
  - 유틸 서브모듈 배럴.

---

## 구성(.env) 요약

### 애플리케이션 로깅
- `LOG_LEVEL`(기본: development=debug, production=info): 로그 레벨.
- `LOG_DIR`(기본: `./logs`): 로그 파일 저장 디렉터리.
- `LOG_PREFIX`(기본: `app`): 로그 파일 접두사. `prefix-YYYY-MM-DD[-N].log` 형식으로 저장.
- `LOG_MAX_MB`(기본: 50): 파일당 최대 크기(MB). 초과 시 같은 날짜의 `-N` 파일로 롤오버.
- `LOG_RETENTION_DAYS`(기본: 7): 보존 일수. 경과 파일은 자동 삭제.

로깅은 콘솔와 파일에 동시에 출력됩니다.
- 개발: 콘솔은 사람이 읽기 좋은 pretty 포맷, 파일은 JSON 라인.
- 운영: 콘솔/파일 모두 JSON 라인. 파일은 날짜/크기 기반 회전 + 보존일수 정리.

### STT 포워딩
- `STT_ENABLED`(true/false): 외부 STT로 오디오 프레임 포워딩 활성화.
- `STT_PROTOCOL`(`websocket` | `tcp` | `grpc` | `mrcp`): 포워딩 프로토콜. 현재 WebSocket과 TCP가 구현됨(기본 전송은 바이너리 스트리밍), gRPC/MRCP는 스텁.
- `STT_ENDPOINT`: 외부 STT 엔드포인트.
  - WebSocket: `ws://...` 또는 `wss://...`
  - TCP: `host:port`, `[ipv6]:port`, 또는 `tcp://host:port`
- `STT_API_KEY`(선택): `Authorization: Bearer`로 전송할 토큰(WebSocket에 한함).
- `STT_HEADERS`(선택): 추가 헤더(JSON 문자열, WebSocket에 한함 `{ "x-api-key": "..." }`).
- `STT_ENCODING`(`L16` | `PCMU`): 전송 오디오 인코딩.
- `STT_RATE`(8000|16000|44100|48000): 샘플레이트.
- `STT_MONO`(true/false): 모노 전송 여부(true면 0번 채널만 전송).
- WebSocket 옵션(선택):
  - `STT_WS_INIT_JSON`: 연결 직후 보낼 텍스트(JSON) 페이로드.
  - `STT_WS_BYE_JSON`: 종료 전 보낼 텍스트(JSON) 페이로드.
  - `STT_WS_PING_SEC`: 주기 핑 간격(초).
  - `STT_WS_LOG_ASCII`=1: 수신 텍스트 로그에서 비ASCII 문자를 `\uXXXX`로 이스케이프(콘솔 인코딩 문제 회피용).
- TCP 옵션(선택):
  - `STT_TCP_FRAMING` = `raw` | `newline` | `len32`: 송수신 프레이밍 모드.
  - `STT_TCP_INIT_HEX`: 연결 직후 보낼 헥스 문자열.
  - `STT_TCP_BYE_HEX`: 종료 전에 보낼 헥스 문자열.

주의: 외부 STT 서버의 핸드셰이크/프레이밍 요구사항(초기 메시지, 메타데이터, 바이너리 프레임 포맷 등)은 서비스별로 다릅니다. 현재 구현은 설정에 따라 프레이밍(raw/newline/len32) 및 초기/종료 페이로드를 지원합니다. 필요 시 프로토콜에 맞춰 `audiohook/src/server/stt-forwarder.ts`를 확장하세요.

### 녹음(파일 기록)
- `RECORDING_TO_FILE_ENABLED`(true/false): WAV 파일 기록 on/off.
- `RECORDING_DIR`: 녹음 파일 출력 루트(예: `./recordings`).
- `RECORDING_IMMEDIATE_ROTATE`(true/false): 경로 변경 시 즉시 회전 여부.
- `RECORDING_S3_BUCKET`(선택): 지정 시 업로드 파이프라인과 연계.

---

## 로깅 구현 상세
- 콘솔 + 파일 동시 출력: `pino` 멀티 타깃 트랜스포트 사용.
- 파일 회전: `src/rotating-file-transport.js` 커스텀 트랜스포트 워커(CommonJS) 사용.
  - 파일명: `prefix-YYYY-MM-DD.log`, 크기 초과 시 `prefix-YYYY-MM-DD-1.log`처럼 증가.
  - 날짜 변경 시 자동 회전, 보존일수 초과 파일 정리.
- 참고: pretty 출력물을 회전 파일로 기록하는 대체 트랜스포트(`src/pretty-rotating-file-transport.js`)도 포함되어 있으나, 기본 설정은 파일을 JSON 라인으로 기록합니다.

---

## 테스트 서버/도구
- `stt_websocket_test/server.js`
  - 간단한 STT WebSocket 테스트 서버. 텍스트/바이너리 수신 로그, `{"type":"init"}`/`{"type":"bye"}` 처리, 3초마다 한글 텍스트 전송.
  - 환경변수: `PORT`(또는 `STT_TEST_PORT`), `WS_PATH`(기본 `/stt`).
- `stt_tcp_test/server.js`
  - 간단한 STT TCP 테스트 서버. 프레이밍(raw/newline/len32) 지원, 3초마다 한글 텍스트 전송, 수신 바이트 로그.
  - 환경변수: `PORT`(또는 `STT_TEST_TCP_PORT`), `TCP_FRAMING`, `INIT_HEX`, `BYE_HEX`.
