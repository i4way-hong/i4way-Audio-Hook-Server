# AudioHook Reference Implementation

Fastify 기반 AudioHook 샘플 서버와 STT(음성 인식) 포워딩, UniMRCP 사이드카 통합을 실험할 수 있는 레퍼런스 프로젝트입니다. AudioHook 프로토콜의 서버/클라이언트 구현, 테스트 하니스, 그리고 운영 환경에서 바로 적용 가능한 로깅·측정 구성을 포함합니다.

> **목표**: “AudioHook 서버를 바로 띄우고, 외부 STT 서비스나 UniMRCP 엔진과 빠르게 연동/검증할 수 있는 단일 레포지터리”

---

## ✨ 주요 특징



---
## 🧩 소스 코드 모듈 구조

상위 레벨은 두 축으로 구성됩니다.
1. `src/` : Fastify 서버 애플리케이션 계층(엔드포인트, 세션 생성, 플러그인, 로깅/라이프사이클)
2. `audiohook/` : 프로토콜 코어와 세션 엔진, STT 포워딩, 사이드카(MRCP, SIP), 공용 유틸

### `src/` 주요 파일
- `index.ts` : Fastify 서버 부트스트랩, WebSocket 라우트 등록(`/api/v1/audiohook/ws`, `/api/v1/voicetranscription/ws`, `/api/v1/loadtest/ws`), 로깅 초기화.
- `authenticator.ts` : API 키 / 서명 검증 훅 (요청 헤더 검사 및 거부/허용 로직).
- `conversation-lookup.ts` : 외부 Conversation 메타데이터 조회 + 캐시 TTL 관리.
- `create-audiohook-session.ts` : 클라이언트에서 세션 생성시 AudioHook 코어 세션 객체 팩토리.
- `recordedsession.ts` : 세션 오디오 기록(파일/WAV) 관리, `RECORDING_DIR`에 파일 생성.
- `session-websocket-stats-tracker.ts` : WebSocket 세션별 통계(프레임 수, 바이트 등) 집계.
- `simulated-transcripts.ts` : 샘플/모의 Transcript 이벤트 생성(테스트·데모 용).
- `audiohook-*-endpoint.ts` (`sample`, `vt`, `load-test`) : 다양한 사용 시나리오를 위한 추가 WS 엔드포인트 예제.
- `wav-writer-demo.ts` : 오디오 스트림을 WAV로 변환·저장하는 데모 스크립트.
- `service-lifecycle-plugin.ts` : 서버 시작/종료 훅, Health/Ready 처리 및 리소스 정리.
- `secrets-plugin.ts` / `dynamodb-plugin.ts` / `dynamodb-utils.ts` : 외부 비밀 관리 및 DynamoDB 연동 유틸.
- `pretty-rotating-file-transport.js` / `rotating-file-transport.js` : pino 로그 회전/pretty 출력 커스텀 트랜스포트.

### `audiohook/src` 디렉터리
- `protocol/` : AudioHook 이벤트·엔티티 타입 정의(`core.ts`, `message.ts`, `validators.ts`) 및 Transcript/AgentAssist 등 엔티티 스키마.
- `server/` : 서버 측 세션 로직(`serversession.ts`/`serversessionimpl.ts`), 오디오 프레임(`mediadata.ts`), STT 포워더(`stt-forwarder.ts`, `stt-forwarder-mrcp.ts`), Vendor 플러그인 로딩.
- `client/` : 클라이언트 세션 구현(`clientsession.ts`/`clientsessionimpl.ts`)과 미디어 소스 인터페이스(`mediasource.ts`).
- `audio/` : 오디오 포맷 변환(μ-law 인코딩 `ulaw.ts`), 리샘플링(`resample.ts`), 공통 AudioFrame 생성.
- `httpsignature/` : HTTP Message Signature 생성/검증 로직(keyId, canonical string 구성 등).
- `sidecar/` : UniMRCP/SIP 사이드카. `signaling/` 내 `unimrcp-signaling.ts`, SIP UDP(`sip-udp.ts`), RTP/네트워크 시뮬레이터(`network-sim.ts`), Telemetry(`metrics.ts`, `telemetry.ts`), 프로토 정의(`proto/mrcp_sidecar.proto`).
- `utils/` : 공용 구성 및 헬퍼(`config.ts`, `logger.ts`, `promise.ts`, `timeprovider.ts`, `streamduration.ts`, STT 환경 파서 `stt-config.ts`).
- `index.ts` : 코어 export 집합(엔티티/세션/유틸 re-export).

### 상호작용 흐름(요약)
1. 클라이언트가 WebSocket `/api/v1/audiohook/ws` 연결 → `create-audiohook-session.ts` 통해 서버 세션 생성.
2. 오디오 프레임 수신 → `server/mediadata.ts` → 선택된 STT 포워더(`stt-forwarder.ts`)에서 프로토콜별 변환(리샘플·인코딩) 후 외부 STT 엔진 전송.
3. Conversation 메타데이터 필요 시 `conversation-lookup.ts` 조회 결과가 Init 메시지/별도 메타 이벤트로 STT 서버에 전파.
4. Transcript 결과(웹소켓/gRPC/TCP/MRCP) → Vendor 파서/핸들러 → 로그 및 세션 이벤트로 되돌림.
5. 사이드카 사용 시 MRCP Signaling(`unimrcp-signaling.ts`)이 RTP 포트 할당·SIP 절차/Telemetry 수집.

### 설계 포인트
- 포워더는 공통 `buildPayload()` 경로로 오디오 형식을 정규화 → STT 전송 모듈별 최소화된 중복.
- gRPC Forwarder는 재접속(backoff+jitter)과 metadata 병합을 자체 처리(프로토 init 메시지 확장).
- WebSocket Forwarder는 INIT JSON 파싱 실패 시 메타데이터를 별도 프레임으로 강등 전송(복원력 확보).
- TCP Forwarder는 다양한 프레이밍(raw/len32/newline) + TLS 옵션을 환경변수로 스위치.
- MRCP Bridge는 별도 사이드카 프로세스와의 추상화 레이어를 통해 AudioHook와 UniMRCP 자원 분리.

### 확장 방법 힌트
- 새 STT 벤더 변환 로직: `server/stt-vendor-plugin.ts`에 플러그인 추가 후 환경변수 `STT_VENDOR_PLUGIN` 지정.
- 추가 인증 스킴: `httpsignature/` 또는 `authenticator.ts`에 헤더 파서 확장.
- 새로운 미디어 포맷: `audio/` 디렉터리에 변환기 추가 후 `buildPayload()` 분기 확장.
- 사이드카 기능 확장: `sidecar/signaling/` 하위에 모듈 추가하고 `MRCP_SIDECAR_SIGNALING_MODULE` 환경변수로 경로 지정.

## 개발서버 접속 정보
IP : 172.168.10.24 
계정 : appadm/Genesys!@#

## 🐳 Docker & Compose (요약)

프로덕션 실행 시 다단계(multi-stage) Docker 빌드를 사용합니다.

1. Builder 단계: `node:22` 이미지를 사용해 `npm ci` → `npm run build` → 필요 JS 헬퍼(`rotating-file-transport.js` 등) 복사 → `npm prune --production`.
2. Runtime 단계: `node:22-slim` 기반, `dist/`만 포함, 비루트 `node` 사용자로 실행.

핵심 포인트:
- `bytebuffer` 등 런타임 필요한 모듈은 devDependencies가 아닌 dependencies에 있어야 `npm prune` 후에도 유지.
- 로컬 프리빌트 패키지(`audiohook-sample-server-*.tgz`)가 COPY 되어야 오프라인 빌드 성공.
- 환경 변수는 Compose `env_file` 또는 `docker run --env-file`로 주입 (이미지 내부 `.env`는 재빌드 없이는 변경 반영 X).

예시(Compose 서비스 스니펫):
```yaml
services:
   app:
      build: .
      image: audiohook-app:latest
      env_file: ./compose/app.env
      volumes:
         - ./logs:/app/logs:Z
         - ./recordings:/app/recordings:Z
      expose:
         - "3000"
```
(`:Z`는 SELinux 컨텍스트 자동 조정이 필요한 RHEL/Rocky 계열에서 사용)

## 📐 표준 디렉터리 레이아웃 (/opt/audiohook)

운영 서버 권장 구조:
```
/opt/audiohook/
   src/            # Git clone 또는 릴리즈 체크아웃
   configs/        # .env, Nginx, Traefik, UniMRCP 설정
   logs/           # 컨테이너 로그 바인드 마운트
   recordings/     # WAV 녹음 파일 (권한 주의)
   compose/        # docker-compose*.yaml 오버레이 모음
```
볼륨 마운트 시 절대 경로 사용(`/opt/audiohook/logs` → `/app/logs`). 상대 경로나 `../recordings` 형태는 권한/워크디렉터리 변경 시 실패(EACCES, ENOENT) 가능.

## 🔀 Load Balancing (Nginx / Traefik 오버레이)

스케일 아웃 시 동일 애플리케이션 컨테이너를 2개 이상 띄우고 단일 진입점을 구성:

1. 기본 `app`, `app2` 서비스에서 `ports:` 제거 후 `expose: ["3000"]` 유지 (외부에 직접 바인딩 금지).
2. `lb` (Nginx) 컨테이너가 3000 포트를 하나만 host에 publish 하고 upstream 으로 `app:3000`, `app2:3000` 라운드 로빈.
3. WebSocket 업그레이드 헤더 보존(`Upgrade`, `Connection`, `Sec-WebSocket-*`).
4. HTTP Signature 검증을 위해 `proxy_set_header Host $http_host;` 와 포트 포함 authority 유지.

Traefik을 사용할 경우 Docker label 기반:
```yaml
   app:
      labels:
         - traefik.enable=true
         - traefik.http.routers.audiohook.rule=Host(`example.com`)
         - traefik.http.services.audiohook.loadbalancer.server.port=3000
```
LB 오버레이 파일(`docker-compose.lb.yaml`)을 분리하여 필요할 때만 추가하는 방식을 권장: `docker compose -f docker-compose.yaml -f docker-compose.lb.yaml up -d`.

## 🎙 Recording & 권한

녹음 디렉터리 환경 변수: `RECORDING_DIR=/app/recordings` (절대 경로 권장).

권한 체크리스트:
- 호스트 디렉터리 생성 후: `chown 1000:1000 recordings logs` (컨테이너 내 `node` UID/GID 가 1000 가정).
- SELinux Enforcing 환경: `:Z` 또는 사전 `chcon -Rt svirt_sandbox_file_t /opt/audiohook/{logs,recordings}`.
- 상대 경로(`../recordings`) 사용 시 Fastify 실행 context가 달라지면 `EACCES`/`ENOENT` 발생 가능.

## 🧬 gRPC Forwarding 확장 변수

추가 제어 옵션(재접속/연결 유지/TLS/Auth):
| 변수 | 설명 |
|------|------|
| `STT_GRPC_RECONNECT_ENABLED` | 끊김 발생 시 재접속 기능 on/off |
| `STT_GRPC_RECONNECT_INITIAL_MS` | 최초 backoff 시작(ms) |
| `STT_GRPC_RECONNECT_MAX_MS` | 최대 backoff(ms) |
| `STT_GRPC_RECONNECT_FACTOR` | 지수 증가 계수 |
| `STT_GRPC_RECONNECT_JITTER` | 지터 비율(0~1) |
| `STT_GRPC_KEEPALIVE_MS` | 주기적 keepalive ping(ms) |
| `STT_GRPC_TLS_ENABLED` | TLS 활성화 여부 |
| `STT_GRPC_TLS_CA_FILE` | CA 번들 경로 |
| `STT_GRPC_TLS_CERT_FILE` / `KEY_FILE` | 클라이언트 cert/key (mTLS) |
| `STT_GRPC_TLS_OVERRIDE_AUTHORITY` | SNI/authority 오버라이드(내부 LB/SAN 불일치 해결) |
| `STT_GRPC_AUTH_TOKEN` | Bearer 토큰 혹은 커스텀 인증 값 |

재접속 전략은 로그에 backoff 단계가 기록되며, 최종 실패 시 오류 이벤트로 세션 종료.

## 🔏 HTTP Signature 검증 주의점

서명 실패 흔한 원인:
1. Host 헤더 포트 누락 (LB에서 `Host: example.com`만 전달, 실제는 `example.com:3000`).
2. Shared secret Base64 이중 인코딩: 이미 Base64 원문이면 다시 인코딩하지 말 것.
3. @authority, @request-target 포함 순서/소문자 구분 문제.
4. 타임스탬프 드리프트(서명 시각 > 허용 윈도우). NTP 싱크 권장.
5. LB 재작성으로 인한 헤더 손실 (`x-api-key`, `authorization`).

체크팁: 서버 로그에서 signature 검증 실패 시 제공되는 debug context (canonical string)를 캡처하여 클라이언트 측 재구성 비교.

## 🧩 STT_WS_SUBPROTOCOL 주의

`STT_WS_SUBPROTOCOL` 값은 **단일 토큰**이어야 하며 인라인 주석 금지:
```
STT_WS_SUBPROTOCOL=audiohook-v1   # (X) ← 주석 붙이면 전체 문자열로 인식
STT_WS_SUBPROTOCOL=audiohook-v1   # (O) ← 별도 주석 줄 사용
```
잘못된 값은 “Invalid or duplicated subprotocol” 로그 후 연결 실패를 유발.

## 🚨 Common Pitfalls & 해결

| 증상 | 원인 | 해결 |
|------|------|------|
| MODULE_NOT_FOUND(bytebuffer) | devDependencies로 분류되어 prune 제거 | `dependencies`로 이동 후 재빌드 |
| EACCES recordings | 상대 경로 + 권한/SELinux 컨텍스트 미조정 | 절대 경로 + `chown 1000:1000` + `:Z` |
| Signature verification failed | Host 포트/secret/base64 불일치 | Nginx `$http_host` 사용, secret 형식 확인 |
| Invalid/duplicated subprotocol | 값에 공백/주석 포함 | 단일 토큰만 설정 |
| 포트 충돌(app/app2) | 두 서비스 모두 `ports: 3000:3000` | LB 사용 시 `ports:` 제거하고 `expose:`만 |
| gRPC 재접속 불가 | 재접속 변수 미설정 | `STT_GRPC_RECONNECT_ENABLED=true` 등 backoff 변수 튜닝 |

## 🔐 Security & Hardening

- 비루트 실행: Dockerfile에서 `USER node`.
- 최소 권한 볼륨: 로그/녹음 디렉터리만 마운트, 소스는 read-only 이미지.
- SELinux/방화벽: Rocky/RHEL 계열은 `firewalld`로 3000, (MRCP RTP 범위) 포트만 오픈. 컨테이너 볼륨 `:Z` 옵션.
- Rate Limiting / API Key: Upstream LB(Nginx/Traefik)에서 IP 기반 제한 + `x-api-key` 헤더 검증.
- TLS: LB 계층(Termination) + 내부는 plaintext. gRPC TLS 필요 시 forwarder TLS 변수 사용.
- Observability: Prometheus 메트릭을 통해 비정상 증가(오류율, 재접속 횟수) 감지 후 자동 알림.

## 📝 Change Log & Next Steps

- 상세 변경 이력: `CHANGELOG.md`
- 향후 계획/아이디어: `NEXT_STEPS.md`, `PRODUCT_PLAN.md`
- 배포 상세(SELinux, LB 패턴, 예시 compose): `DEPLOY.md`

권장 후속 작업:
1. CI에 container build/test 단계 추가(GitHub Actions → multi-stage 이미지).
2. Signature canonical string 검증용 통합 테스트 추가.
3. Traefik 라벨 기반 동적 스케일 e2e 테스트.
4. STT 프로토콜별 QoS/지연 측정 스크립트.

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

추가적으로 `audiohook-sample-server-1.0.3.tgz` 는 AudioHook 코어 패키지의 프리빌드 번들입니다.

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
| `LOG_TIMEZONE` | (서버 로컬) | 로그와 세션 통계에 출력할 타임존 ID. 예) `Asia/Seoul`. 잘못된 값이면 서버 기본 타임존으로 폴백. |
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
- `CONVERSATION_LOOKUP_RETRY_ATTEMPTS`, `CONVERSATION_LOOKUP_RETRY_DELAY_MS`: 초기 조회가 비어 있을 때 백그라운드 재시도 횟수/간격(ms). 기본값은 0회, 1500ms.

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

## 🧪 STT 테스트 하니스 & Client Data Generator

프로덕션 STT 서비스 없이도 AudioHook 포워더를 검증·부하 측정·프로토콜 비교할 수 있는 경량 프로젝트 모음입니다. 각 하니스는 최소 의존성, 빠른 기동, 캡처 파일 저장, 메타데이터 확인을 지원합니다.

### 공통 특징
- 단일 `server.js` + 소형 `package.json` → 빠른 설치(`npm install --no-audit --no-fund`).
- 캡처: `captures/`에 수신/송신/결합(combined) 오디오를 PCMU 로 저장 → 파형/지터 후처리 가능.
- 메타데이터: Init 또는 별도 conversation metadata JSON 그대로 로깅.
- 확장: `server.js`에 간단한 파서 추가로 partial/final transcript 시뮬레이션.

### 선택 가이드
| 목적 | 권장 프로젝트 |
|------|---------------|
| WebSocket 프로토콜/서브프로토콜 검증 | `stt_websocket_test` |
| TCP 프레이밍(raw/len32/newline) 및 backpressure 테스트 | `stt_tcp_test` |
| 재접속/메타데이터/TLS gRPC 스트리밍 검증 | `stt_grpc_test` |
| 대량 동시 연결, RTT/지연 통계, WAV/톤 전송 부하 | `client_data_generator` |

---
### WebSocket (`stt_websocket_test/`)
파일: `server.js`, `.env`, `captures/`

기능:
- INIT/BYE JSON 프레임 수신/로그.
- 3초 주기 샘플 텍스트(한글) 송신.
- 캡처 파일: `<timestamp>_<ip>_<port>_{rx,tx,combined}.pcmu`

환경 변수:
- `PORT` / `STT_TEST_PORT`: 포트 지정.
- `WS_PATH`: 기본 `/stt`.

실행:
```powershell
cd stt_websocket_test
npm install --no-audit --no-fund
npm start
```

AudioHook 예시:
```
STT_PROTOCOL=websocket
STT_ENDPOINT=ws://localhost:8080/stt
```

체크리스트: INIT 병합 여부, 메타데이터 개수, 캡처 파일 생성, 텍스트 수신 로그.

---
### TCP (`stt_tcp_test/`)
파일: `server.js`, `.env`, `captures/`

기능:
- 프레이밍 모드: `raw` / `len32` / `newline`.
- INIT/BYE Hex 페이로드 송신/로그.
- UTF-8 텍스트 프레임 미리보기.

환경 변수:
- `PORT` / `STT_TEST_TCP_PORT`
- `TCP_FRAMING`
- `INIT_HEX` / `BYE_HEX`

AudioHook 예시:
```
STT_PROTOCOL=tcp
STT_ENDPOINT=127.0.0.1:7070
STT_TCP_FRAMING=len32
STT_TCP_INIT_HEX=0a0b
STT_TCP_BYE_HEX=ff
```

체크리스트: 길이 헤더 파싱, newline CRLF 처리, BYE 후 정상 종료.

---
### gRPC (`stt_grpc_test/`)
파일: `server.js`, `.env`, `README.md`, `captures/`

기능:
- `StreamingRecognize` 유사 스트림.
- Init 메시지 내 `tags` / `vendor_params` / metadata 반영.
- partial/final transcript 확장 지점 제공.

권장 AudioHook 환경 변수:
```
STT_PROTOCOL=grpc
STT_ENDPOINT=localhost:50051
STT_GRPC_RECONNECT_ENABLED=true
STT_GRPC_RECONNECT_INITIAL_MS=500
STT_GRPC_RECONNECT_MAX_MS=15000
STT_GRPC_RECONNECT_FACTOR=2.0
STT_GRPC_RECONNECT_JITTER=0.3
STT_GRPC_FORCE_PCMU_8K=true
STT_GRPC_TLS_ENABLED=false
```

테스트 포인트: 재접속 backoff 로그, PCMU 8K 강제 여부, metadata envelope 병합/별도 이벤트 관찰.

실행:
```powershell
npm run start:grpc-test
```

---
### Client Data Generator (`client_data_generator/`)
목적: 다중 세션 생성, RTT(tdigest) 통계, WAV/톤 스트리밍, Poisson 기반 연결 간격으로 부하 시뮬레이션.

핵심 소스:
- `index.ts`: CLI 엔트리, 옵션 파싱, 세션 시작 시간 분포 생성, RTT 집계.
- `clientwebsocket.ts`: HTTP Message Signature 헤더 자동 구성.
- `mediasource-wav.ts`: WAV 읽기 → 프레임(200ms) → 다운믹/PCMU 변환 → 이벤트.
- `mediasource-tone.ts`: 단색 톤/프로브 스트림.

주요 옵션:
| 옵션 | 설명 |
|------|------|
| `--uri` | 대상 wss:// 서버 URI |
| `--wavfile <path>` | WAV 파일 전송(없으면 tone) |
| `--session-count <n>` | 동시 세션 수(1~1024) |
| `--connection-rate <r>` | 초당 연결 생성 평균 속도 |
| `--max-stream-duration <sec|PTxS>` | 오디오 길이 제한 |
| `--connection-probe` | 톤 기반 최소 테스트(음성 미전송) |
| `--api-key <key>` | API Key 값 |
| `--client-secret <base64>` | 서명 시크릿(Base64) |
| `--custom-config <json>` | open 메시지 customConfig |
| `--supported-languages` | 지원 언어 목록 요청 |
| `--session-log-level <level>` | 세션별 로그 레벨 |

실행 예시:
```powershell
cd client_data_generator
npm install
node dist/src/index.js wss://localhost:3000/api/v1/audiohook/ws --session-count 50 --connection-rate 25 --wavfile ./samples/test.wav --api-key TESTKEY== --client-secret AbCdEf== --max-stream-duration 30 --session-log-level warn
```

RTT 출력: 30초마다 tdigest 기반 percentiles(min/p50/p95/p99 등) → 지연 추세 분석.

활용 시나리오:
- p95 RTT 급증 지점으로 서버 스케일 임계 파악.
- Signature 검증 부하 측정(API Key + client-secret vs 미사용 비교).
- 인코딩/리샘플 옵션 변경 시 전송률·지연 영향 확인.

확장 아이디어:
- 결과 CSV/JSON 내보내기.
- WAV 파일 목록 순환(다양한 길이/포맷 혼합 부하).
- partial transcript 자동 검증 스크립트.

중단/종료: Ctrl+C 1회 → 우아한 종료, 2회 → 즉시 종료.


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

