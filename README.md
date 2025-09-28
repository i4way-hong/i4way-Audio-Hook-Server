# AudioHook Reference Implementation

# Audiohook Sidecar - UniMRCP Integration Guide

## 네이티브 UniMRCP SDK 연동 빌드

Windows PowerShell

```
$env:GYP_DEFINES='use_unimrcp_sdk=1'
$env:UNIMRCP_SDK_DIR='C:\unimrcp\sdk'
$env:APR_DIR='C:\unimrcp\deps\apr'
$env:SOFIA_DIR='C:\unimrcp\deps\sofia'
npm run build:native
```

Linux/macOS

```
export GYP_DEFINES='use_unimrcp_sdk=1'
export UNIMRCP_SDK_DIR=/opt/unimrcp
export APR_DIR=/opt/apr
export SOFIA_DIR=/opt/sofia-sip
npm run build:native
```

## 런타임 설정
- MRCP_RTP_PORT_MIN/MRCP_RTP_PORT_MAX: 로컬 RTP 포트 범위
- MRCP_SIDECAR_SIGNALING=module, MRCP_SIDECAR_SIGNALING_MODULE=./audiohook/src/sidecar/signaling/unimrcp-signaling
 - MRCP_ENABLE_RTP_LISTEN=1 : 세션 당 임의 UDP 포트 바인드하여 수신 RTP 헤더 패킷 카운트 (관측/테스트 용)
 - MRCP_ENABLE_SIP_V2=1 : SIP UDP 1단계 스켈레톤 활성화 (INVITE 재전송 + 200 OK SDP 파싱)

## 프로파일 매핑
- ah-mrcpv1: RTSP(MRCPv1)
- ah-mrcpv2: SIP(MRCPv2)

## RTP ptime 협상
- SDP a=ptime을 파싱해 합의된 ptime을 사용합니다.

## CI 빌드
- .github/workflows/native.yml 참조(Windows/Ubuntu에서 SDK 유무에 따라 조건부 빌드)

## STT 포워더 설정 가이드

환경 변수 키(.env)
- STT_ENABLED=true|false
- STT_PROTOCOL=websocket|tcp|grpc|mrcp
- STT_ENDPOINT=ws://host:port 또는 127.0.0.1:9000, tcp://host:port, [ipv6]:port
- STT_API_KEY=베어러 토큰(옵션, WebSocket)
- STT_HEADERS={"X-Custom":"v"} (옵션, WebSocket, JSON)
- STT_ENCODING=L16|PCMU
- STT_RATE=8000|16000|44100|48000
- STT_MONO=true|false (true면 0번 채널만 전송)
- STT_RESAMPLE_ENABLED=true|false (샘플레이트 미스매치 시 자동 변환)

WebSocket 전용
- STT_WS_INIT_JSON={"type":"init","sampleRate":8000} (연결 직후 송신)
- STT_WS_PING_SEC=30 (0/음수/NaN이면 비활성화)
- STT_WS_BYE_JSON={"type":"bye"} (종료 시 송신)
- STT_WS_LOG_ASCII=1 (옵션) 수신 텍스트 로그의 비ASCII 문자를 \uXXXX로 이스케이프

TCP 전용
- STT_TCP_FRAMING=raw|len32|newline
- STT_TCP_INIT_HEX=0a0b0c (연결 직후 송신할 HEX)
- STT_TCP_BYE_HEX=ff00 (종료 시 송신할 HEX)

### 수신 로그 미리보기
- WebSocket
  - 텍스트: `STT WS recv text: <앞 200자 미리보기>`
  - 바이너리: `STT WS recv binary (<N> bytes)`
- TCP
  - 프레이밍 len32/newline을 파싱해 텍스트 미리보기 로깅: `STT TCP recv text: <앞 200자>`
  - raw 모드는 청크 단위로 UTF-8 디코드해 미리보기 로깅

### 핸드셰이크 프로파일 예시
- WebSocket: INIT(JSON) → 바이너리 오디오 → BYE(JSON)
- TCP len32: INIT(hex) → len32BE 길이프리픽스 프레임 → BYE(hex)
- TCP newline: 프레임 뒤에 \n 추가

### 샘플 .env
```
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
# 콘솔 인코딩 문제 회피용(옵션)
# STT_WS_LOG_ASCII=1

# TCP 예시
# STT_PROTOCOL=tcp
# STT_ENDPOINT=127.0.0.1:7070
# STT_TCP_FRAMING=len32
# STT_TCP_INIT_HEX=0a0b
# STT_TCP_BYE_HEX=ff
```

## 로깅 요약
- 개발 모드(NODE_ENV != production)
  - 콘솔: 사람이 읽기 쉬운 pretty 형식(pino-pretty)
  - 파일: JSON 라인, 날짜/크기 기반 회전 및 보존 적용
- 운영 모드(NODE_ENV = production)
  - 콘솔/파일: JSON 라인, 파일은 회전/보존 적용
- 파일명 규칙: `logs/<prefix>-YYYY-MM-DD[-N].log` (기본 prefix=app)

## 테스트 서버
- Client Data 생성기 `client_data_generator/client_data_generator/run_client.cmd`
  - 음성 데이터 생성기
  - 로컬 wav 파일을 재생하려면 아래와 같이 cmd 파일 수정
    --> npm start -- --uri wss://audiohook.i4way.co.kr/api/v1/audiohook/ws --api-key R2VuZXN5c2Nsb3Vk --client-secret YTEyMzQ1Njc4OQ== 
    --wavfile C:\cti\001-ed_sheeran_-_shape_of_you.wav

  ### 클라이언트 실행 옵션 요약 (index.ts)
  - [serveruri] 또는 --uri <uri>: AudioHook 서버 WS/WSS URI
  - wavfile <path>: 전송할 WAV 파일 경로(미지정 시 톤 발생기 사용)
  - api-key <apikey>: API Key (Base64-url 세트 형식)
  - client-secret <base64>: 메시지 서명용 클라이언트 시크릿(Base64)
  - custom-config <json>: open 메시지의 customConfig로 전달할 JSON 문자열
  - language <code>: 테스트에 사용할 언어 코드
  - supported-languages: 서버의 지원 언어 목록 조회
  - session-count <n>: 동시 세션 수 (기본 1, 1~1024)
  - max-stream-duration <sec|ptxs>: 오디오 전송 최대 지속시간(초 또는 ISO-8601 PTxS)</sec|ptxs>
  - connection-probe: 프로브만 수행(오디오는 max-stream-duration 지정 시에만 송신). --wavfile와 동시 사용 불가
  - orgid <uuid>: 조직(테넌트) ID UUID (미지정 시 랜덤 생성)
  - connection-rate <rps>: 초당 세션 생성 평균 속도(기본 50, 0.1~10000)
  - session-log-level <level>: 세션 로그 레벨(fatal|error|warn|info|debug|trace, 기본 info)
  - wavfile 미지정 시 톤 소스 사용.
  - connection-probe와 --wavfile은 상호 배타.

  ### WebSocket 테스트: `stt_websocket_test/server.js`
  - Env: PORT(또는 STT_TEST_PORT), WS_PATH(기본 /stt)
  - 기능: 텍스트/바이너리 수신 로그, INIT/bye 처리, 3초마다 한글 텍스트 송신
  
  ### TCP 테스트: `stt_tcp_test/server.js`
  - Env: PORT(또는 STT_TEST_TCP_PORT), TCP_FRAMING(raw|len32|newline), INIT_HEX, BYE_HEX
  - 기능: 프레이밍별 수신/송신, 3초마다 한글 텍스트 송신

## 추가 문서
* `docs/telemetry.md` - MRCP 세션 Telemetry 필드 정의 및 사용 예시
* `docs/env.md` - MRCP/STT 관련 환경 변수 목록 및 튜닝 가이드
* `docs/status-2025-09-26.md` - 최근 EOD 진행 상황 요약

## Metrics (Prometheus)
Sidecar HTTP 서버(/metrics 경로)에서 세션별 telemetry 누산 결과를 노출합니다.

예시 응답:
```
# HELP mrcp_sessions Current sessions registered
# TYPE mrcp_sessions counter
mrcp_sessions 1
# HELP mrcp_sip_attempts_total Total SIP attempts
# TYPE mrcp_sip_attempts_total counter
mrcp_sip_attempts_total 2
# HELP mrcp_rtp_packets_received_total Total RTP packets observed (receive or send proxy)
# TYPE mrcp_rtp_packets_received_total counter
mrcp_rtp_packets_received_total 15
```

활용 방법:
1. `curl http://127.0.0.1:<sidecar-port>/metrics`
2. Prometheus `scrape_config`에 대상 추가
3. Grafana 대시보드에 카운터 그래프 구성 (rate() 함수 활용)

## RTP Listen 옵션
`MRCP_ENABLE_RTP_LISTEN=1` 설정 시 세션 생성 시 부가 UDP 소켓을 임의 포트에 바인드해 수신 RTP 헤더(V=2) 패킷을 감지하고 `rtpPacketsReceived` 카운터를 증가시킵니다.

주의:
- 실제 RTP 스트림을 미러링하거나 termination 하지 않음 (관측 목적)
- 많은 트래픽 환경에서는 소켓 처리 비용 증가 가능

## SIP UDP (Experimental)
`MRCP_ENABLE_SIP_V2=1` 활성화 시 순서:
1. UDP INVITE 전송 (지수 백오프 재전송, 기본 5회)
2. 200 OK SDP 수신 시 ACK (best-effort) → 세션 transport=sip
3. 실패 시 TCP INVITE 재시도 (기존 skeleton)
4. 다시 실패 시 RTSP → 최종 실패 시 fallback 5004 (비활성화 가능)

제한:
- 인증, CANCEL, 재등록, Dialog state machine 없음
- Provisional (100/180) 단순 무시 (200 OK 필요)
- 추후 telemetry v2 에서 UDP/TCP 분리 카운터 예정

환경 변수 조합 예시 (PowerShell):
```powershell
$env:MRCP_ENABLE_SIP_V2=1
$env:MRCP_ENABLE_RTP_LISTEN=1
```

## 빠른 시나리오 예시
1. UDP SIP 서버(or mock) 준비 (200 OK with SDP 반환)
2. Sidecar 실행 후 `/metrics` 로 sipAttempts 증가 확인
3. RTP 패킷 몇 개 전송 → `mrcp_rtp_packets_received_total` 증가 관측

## Real UniMRCP Integration (RTSP v1)

다음 절차로 실제 UniMRCP RTSP 서버와 세션 협상을 검증할 수 있습니다.

### 1. UniMRCP 서버 준비
로컬 또는 컨테이너로 UniMRCP 서버를 실행하고 다음을 확인:
* RTSP 제어 포트: 8060/TCP (기본)
* RTP 포트 범위: 예) 40000-40050/UDP (서버 설정과 sidecar 환경변수 일치 필요)
* 서버 설정 예시는 `configs/unimrcp/` 참고

### 2. Sidecar 환경 변수
PowerShell 예시:
```
$env:STT_PROTOCOL = 'mrcp'
$env:STT_ENDPOINT = 'rtsp://127.0.0.1:8060/unimrcp'
$env:MRCP_FORCE_RTSP = '1'        # (SIP 스켈레톤 우회)
$env:MRCP_RTP_PORT_MIN = '41000'
$env:MRCP_RTP_PORT_MAX = '41020'
# 선택: 재시도/타임아웃 튜닝
# $env:MRCP_RTSP_DESCRIBE_RETRIES = '2'
# $env:MRCP_RTSP_SETUP_RETRIES    = '1'
```

실행:
```
npm run sidecar
```

### 3. 세션 열기 (간단 스니펫)
```ts
import { openSession } from './audiohook/src/sidecar/signaling/unimrcp-signaling';

(async () => {
  const session = await openSession({ endpoint: process.env.STT_ENDPOINT! });
  console.log('telemetry', session.getTelemetry());
  console.log('remoteRtpPort', session.remotePort);
})();
```

### 4. Telemetry 확인 포인트
* describeAttempts / setupAttempts == 1 (정상 협상)
* fallback5004Count == 0
* transport == 'rtsp'
* lastErrorCode 없음

### 5. 문제 해결 (Troubleshooting)
| 증상 | 원인 | 조치 |
|------|------|------|
| ECONNREFUSED 8060 | 서버 미기동/방화벽 | 서버 실행 및 포트 허용 |
| DESCRIBE 실패 반복 | 서버 설정/리소스 경로 불일치 | endpoint path (`/unimrcp`) 확인 |
| SETUP 500 | RTP 범위 충돌/플러그인 오류 | 서버 로그 확인, RTP 범위 조정 |
| fallback5004Count=1 | 모든 협상 실패 | 네트워크/포트/환경변수 재검증 |

### 6. RTP 송출(추가 구현 필요)
현재 리포는 RTP 미디어 패킷 송신/RECOGNIZE 명령 전체 구현은 최소화되어 있으므로 실제 음성 인식까지 검증하려면:
1. SDP에서 remote audio m= 줄의 포트 추출
2. PCMU(또는 L16) 패킷 20ms 간격 송신 (dgram/UDP)
3. MRCP RECOGNIZE 메시지 전송 로직 추가 (Channel-Identifier, Content-Type 세팅)
4. 이벤트(RECOGNITION-COMPLETE) 파싱

### 7. 향후 확장 (SIP v2)
`sip-v2.ts` 는 간소화된 TCP INVITE 스켈레톤입니다. 실제 SIP/UDP 트랜잭션 지원이 필요하면:
1. UDP 소켓 생성 + INVITE (Via/From/To/Call-ID/CSeq) 빌드
2. 100 Trying, 180 Ringing, 200 OK 처리
3. ACK 전송 후 SDP 기반 RTP 동일 처리
4. 재전송/분기 타이머(T1/T2) 적용

로드맵 초안은 별도 `docs/sip-roadmap.md` 로 이어질 수 있습니다.

### 8. Fallback 비활성화(선택 개선)
현재 5004 fallback 은 협상 완전 실패 시 telemetry 관찰용입니다. 운영 환경에서 원치 않으면 코드 내 fallback 조건에 환경 변수 가드를 추가할 수 있습니다 (예: `MRCP_DISABLE_FALLBACK5004`).

---
추가 확장이 필요하면 README 하단에 항목을 증설하거나 전용 문서를 생성하는 것을 권장합니다.

