# AudioHook Reference Implementation

Fastify 기반 AudioHook 샘플 서버와 STT(음성 인식) 포워딩, UniMRCP 사이드카 통합을 실험할 수 있는 레퍼런스 프로젝트입니다. AudioHook 프로토콜의 서버/클라이언트 구현, 테스트 하니스, 그리고 운영 환경에서 바로 적용 가능한 로깅·측정 구성을 포함합니다.

> **목표**: “AudioHook 서버를 바로 띄우고, 외부 STT 서비스나 UniMRCP 엔진과 빠르게 연동/검증할 수 있는 단일 레포지터리”

---

## ✨ 주요 특징

- Fastify + WebSocket 기반 AudioHook 서버 (`src/`)
- AudioHook 코어 라이브러리(`audiohook/`)와 HTTP signatures, VAD, 파일 기록 등 재사용 가능한 모듈
- STT 포워딩(WebSocket/TCP/gRPC/MRCP) 및 대화 메타데이터 조회 파이프라인
- 가벼운 STT 테스트 하니스(WS/TCP/gRPC)와 클라이언트 데이터 생성 도구
- UniMRCP 사이드카 빌드 및 telemetry 수집, Prometheus 노출
- 풍부한 환경 변수/문서화: `docs/*.md`, `.env` 기반 구성, 로깅/측정 템플릿

---

## 📁 저장소 구조 개요

| 경로 | 설명 |
|------|------|
| `src/` | Fastify 앱 레이어. WS 엔드포인트, 플러그인(DynamoDB, Secrets), 서비스 라이프사이클 관리. |
| `audiohook/` | AudioHook 코어(프로토콜, 서버/클라이언트 세션, 오디오 유틸, STT 포워더 등). |
| `stt_websocket_test/`, `stt_tcp_test/`, `stt_grpc_test/` | 각 프로토콜별 STT 서버 하니스. 최근 메타데이터 로깅/미리보기 기능이 추가됨. |
| `client_data_generator/` | 대량 세션/오디오 생성기. WAV 재생, 텍스트 스트림 출력을 시뮬레이션. |
| `configs/` | UniMRCP 및 기타 외부 서비스 예시 설정. |
| `docs/` | 환경 변수, Telemetry, SIP 로드맵 등 심화 문서. |
| `scripts/` | RTP 패킷 송출 등 보조 스크립트. |
| `recordings/`, `logs/` | 기본 출력 디렉터리(WAV 녹음, 회전 로그). |

추가적으로 `audiohook-sample-server-1.0.2.tgz` 는 AudioHook 코어 패키지의 프리빌드 번들입니다.

---

## 🛠 사전 준비

- Node.js **22.x 이상**
- npm **10 이상**
- (옵션) UniMRCP SDK 및 의존성(APR, Sofia-SIP) – 사이드카 네이티브 빌드 시 필요

---

## 🚀 빠른 시작

1. 의존성 설치

   ```powershell
   npm install
   ```

2. 환경 변수 구성: `.env` 파일을 생성하거나 쉘 환경에서 직접 설정합니다. 기본값과 상세 설명은 [환경 변수](#환경-변수-요약)를 참고하세요.

3. 개발 서버 실행

   ```powershell
   npm start
   ```

   기본적으로 `127.0.0.1:3000`에서 AudioHook WebSocket 엔드포인트(`/api/v1/audiohook/ws`, `/api/v1/voicetranscription/ws`, `/api/v1/loadtest/ws`)가 올라옵니다.

---

## ⚙️ 스크립트 모음

| 명령 | 설명 |
|-------|------|
| `npm run setup` | 프로젝트 의존성 설치. |
| `npm start` | Fastify 서버 실행. |
| `npm test` | Jest 테스트. (필요 시 `test:jest` VS Code 작업 사용 가능) |
| `npm run build` | TypeScript 컴파일 + ESLint. |
| `npm run buildcheck` | 타입체크(emit 없음) + ESLint. |
| `npm run sidecar` | UniMRCP 사이드카 서버 실행. |
| `npm run sidecar:mock` | MRCP 사이드카 모의 서버. |
| `npm run start:grpc-test` | gRPC STT 하니스 가동(`stt_grpc_test/`). |
| `npm run send:rtp` | `scripts/send_rtp_pcmu_example.ts` 실행, RTP 송신 예제. |

---

## 🌐 환경 변수 요약

아래는 자주 사용하는 항목만 발췌한 것입니다. 전체 목록과 세부 설명은 `docs/env.md`, `docs/telemetry.md`를 참고하세요.

### 애플리케이션 & 로깅

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `LOG_LEVEL` | dev=`debug`, prod=`info` | 로깅 레벨. |
| `LOG_DIR` | `./logs` | 로그 파일 위치. |
| `LOG_PREFIX` | `app` | 회전 로그 파일 접두사. |
| `LOG_MAX_MB` | `50` | 로그 파일 최대 크기(MB). |
| `LOG_RETENTION_DAYS` | `7` | 로그 보존 일수. |
| `SERVERPORT` / `SERVERHOST` | `3000` / `127.0.0.1` | Fastify 서버 바인딩. |

개발 모드에서는 콘솔에 `pino-pretty` 포맷을, 운영 모드에서는 JSON 라인을 출력합니다. 모든 모드에서 회전 파일이 함께 기록됩니다.

### STT 포워딩

| 변수 | 값 예시 | 설명 |
|------|---------|------|
| `STT_ENABLED` | `true`/`false` | 외부 STT 포워딩 활성화. |
| `STT_PROTOCOL` | `websocket` \| `tcp` \| `grpc` \| `mrcp` | 포워딩 프로토콜 선택. |
| `STT_ENDPOINT` | `ws://host:port/path` 등 | 대상 엔드포인트. |
| `STT_ENCODING` | `L16` \| `PCMU` | 오디오 인코딩. |
| `STT_RATE` | `8000`, `16000`, ... | 샘플레이트. |
| `STT_MONO` | `true`/`false` | 모노 전송 여부. |
| `STT_RESAMPLE_ENABLED` | `true`/`false` | 샘플레이트 자동 변환. |

**WebSocket 전용**

- `STT_WS_INIT_JSON`, `STT_WS_BYE_JSON`: 연결 직후/종료 전 전송할 JSON 메시지.
- `STT_WS_PING_SEC`: 주기 핑(초, 0/음수면 비활성화).
- `STT_WS_LOG_ASCII`: 수신 텍스트 로그에서 비ASCII 문자 이스케이프.

**TCP 전용**

- `STT_TCP_FRAMING`: `raw` \| `len32` \| `newline` 프레이밍 모드.
- `STT_TCP_INIT_HEX`, `STT_TCP_BYE_HEX`: 연결 직후/종료 전 헥스 페이로드.

**대화 메타데이터 조회**

- `CONVERSATION_LOOKUP_URL`: 세션이 열릴 때 외부 API 호출로 메타데이터 조회.
- `CONVERSATION_LOOKUP_QUERY_PARAM`: 조회 시 사용할 쿼리 파라미터명.
- `CONVERSATION_LOOKUP_TIMEOUT_MS`, `CONVERSATION_LOOKUP_CACHE_SECONDS`: 호출 타임아웃과 캐시 TTL.

조회된 메타데이터는 WebSocket/TCP/gRPC 포워더에 자동 병합되어, STT 하니스가 동일한 conversation 정보를 수신할 수 있습니다.

### 샘플 `.env`

```ini
STT_ENABLED=true
STT_PROTOCOL=websocket
STT_ENDPOINT=ws://localhost:8080/stt
STT_ENCODING=L16
STT_RATE=8000
STT_MONO=true
STT_RESAMPLE_ENABLED=false
STT_WS_INIT_JSON={"type":"init","sampleRate":8000}
STT_WS_PING_SEC=30
STT_WS_BYE_JSON={"type":"bye"}
# STT_WS_LOG_ASCII=1

# TCP 예시
# STT_PROTOCOL=tcp
# STT_ENDPOINT=127.0.0.1:7070
# STT_TCP_FRAMING=len32
# STT_TCP_INIT_HEX=0a0b
# STT_TCP_BYE_HEX=ff
```

---

## 🧪 STT 테스트 하니스

프로덕션 STT 서비스 없이도 AudioHook 포워더를 검증할 수 있는 경량 서버들입니다.

### WebSocket (`stt_websocket_test/server.js`)

```powershell
cd stt_websocket_test
npm install --no-audit --no-fund
npm start
```

- 환경 변수: `PORT`(또는 `STT_TEST_PORT`), `WS_PATH`(기본 `/stt`)
- 기능: 텍스트/바이너리 수신 로그, INIT/BYE 처리, 3초마다 한글 텍스트 전송, 메타데이터 미리보기

### TCP (`stt_tcp_test/server.js`)

```powershell
cd stt_tcp_test
npm install --no-audit --no-fund
npm start
```

- 환경 변수: `PORT`(또는 `STT_TEST_TCP_PORT`), `TCP_FRAMING`, `INIT_HEX`, `BYE_HEX`
- 기능: 프레이밍(raw/newline/len32) 처리, 수신 텍스트 미리보기, 3초 주기 메시지

### gRPC (`stt_grpc_test/server.js`)

```powershell
npm run start:grpc-test
```

- AudioHook의 gRPC 스트리밍 프로토콜을 모사합니다.
- 최근 업데이트로 `conversation_id`를 포함한 메타데이터 필드가 전파됩니다.

### Client Data Generator (`client_data_generator/`)

대량 세션 부하 테스트나 WAV 전송을 시뮬레이션 할 수 있습니다. `run_client.cmd`를 수정하여 서버 URI, API 키, WAV 파일 등을 지정하세요. 세부 옵션은 `client_data_generator/README.md`와 `client_data_generator/src/index.ts`에 정리되어 있습니다.

---

## 📡 로깅 & Telemetry

- `pino` 멀티 타깃을 이용해 콘솔 + 파일(JSON) 로그를 동시에 남깁니다.
- `logs/<prefix>-YYYY-MM-DD[-N].log` 형식으로 날짜/사이즈 기반 회전.
- Telemetry 누산 결과는 사이드카 HTTP 서버 `/metrics` 엔드포인트에서 Prometheus 포맷으로 노출됩니다.

예시:

```
# HELP mrcp_sessions Current sessions registered
# TYPE mrcp_sessions counter
mrcp_sessions 1
# HELP mrcp_sip_attempts_total Total SIP attempts
# TYPE mrcp_sip_attempts_total counter
mrcp_sip_attempts_total 2
```

---

## 🎯 UniMRCP 사이드카 (고급)

AudioHook 서버에서 외부 UniMRCP 엔진과 협상을 수행할 수 있도록 사이드카 모듈을 제공합니다. SDK와 네이티브 확장을 준비한 뒤 빌드/실행하세요.

### 네이티브 빌드

**Windows PowerShell**

```powershell
$env:GYP_DEFINES='use_unimrcp_sdk=1'
$env:UNIMRCP_SDK_DIR='C:\unimrcp\sdk'
$env:APR_DIR='C:\unimrcp\deps\apr'
$env:SOFIA_DIR='C:\unimrcp\deps\sofia'
npm run build:native
```

**Linux/macOS**

```bash
export GYP_DEFINES='use_unimrcp_sdk=1'
export UNIMRCP_SDK_DIR=/opt/unimrcp
export APR_DIR=/opt/apr
export SOFIA_DIR=/opt/sofia-sip
npm run build:native
```

### 런타임 핵심 변수

- `MRCP_SIDECAR_SIGNALING=module`
- `MRCP_SIDECAR_SIGNALING_MODULE=./audiohook/src/sidecar/signaling/unimrcp-signaling`
- `MRCP_RTP_PORT_MIN`, `MRCP_RTP_PORT_MAX`: RTP 포트 범위
- `MRCP_ENABLE_RTP_LISTEN`: RTP 관측용 보조 소켓 활성화
- `MRCP_ENABLE_SIP_V2`: SIP UDP 스켈레톤 활성화
- `MRCP_TEST_ALLOW_LOW_TIMEOUT`: SIP 타이머 하한 우회(테스트 전용)

SIP/RTP/Telemetry 관련 환경 변수 표와 테스트용 네트워크 시뮬레이터 옵션은 `docs/telemetry.md`, `docs/mrcp-bridge-api.md`와 동기화되어야 합니다.

### 빠른 시나리오

1. UniMRCP 서버를 준비하고 포트를 확인합니다 (`configs/unimrcp/` 참고).
2. 사이드카 실행:

   ```powershell
   npm run sidecar
   ```

3. 세션 오픈 스니펫:

   ```ts
   import { openSession } from './audiohook/src/sidecar/signaling/unimrcp-signaling';

   (async () => {
     const session = await openSession({ endpoint: process.env.STT_ENDPOINT! });
     console.log('telemetry', session.getTelemetry());
   })();
   ```

4. Telemetry로 describe/setup 시도, fallback5004 카운터 등을 확인하며 튜닝합니다.

문제 해결, RTP 송출, SIP UDP 확장 관련 추가 팁은 기존 README 내용과 동일하게 아래 문서에서 다룹니다.

---

## ✅ 테스트 & 품질 점검

- **유닛 테스트**: `npm test`
- **타입 체크**: `npm run buildcheck` (tsc noEmit + ESLint)
- **로그 확인**: 개발 모드에서 콘솔 pretty 로그 + `logs/` 파일을 함께 확인하세요.

CI 파이프라인 예시는 `.github/workflows/native.yml`을 참고하세요.

---

## 📚 참고 문서

- `docs/env.md` – 환경 변수 튜닝 가이드
- `docs/telemetry.md` – MRCP Telemetry 항목 및 Prometheus 연계
- `docs/mrcp-bridge-api.md`, `docs/mrcp-bridge-umc.md` – MRCP 연동 상세
- `docs/sip-roadmap.md` – SIP 확장 로드맵
- `docs/status-2025-09-26.md` – 최근 진행 상황 요약

추가 안내나 기능 확장이 필요하면 이 README나 개별 문서를 업데이트해 주세요.

---

## 🤝 기여 & 지원

이 레포지터리는 AudioHook 통합을 빠르게 실험하고 학습할 수 있도록 설계되었습니다. 개선 아이디어나 버그 리포트는 이슈/PR 형태로 공유해주세요. 운영 환경으로 이관할 때는 로그/보안/네트워크 정책을 조직 표준에 맞춰 조정하는 것을 권장합니다.

