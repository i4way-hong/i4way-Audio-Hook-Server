# AudioHook Reference Implementation

// ...existing content...

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
  -[serveruri] 또는 --uri <uri>: AudioHook 서버 WS/WSS URI
  -wavfile <path>: 전송할 WAV 파일 경로(미지정 시 톤 발생기 사용)
  -api-key <apikey>: API Key (Base64-url 세트 형식)
  -client-secret <base64>: 메시지 서명용 클라이언트 시크릿(Base64)
  -custom-config <json>: open 메시지의 customConfig로 전달할 JSON 문자열
  -language <code>: 테스트에 사용할 언어 코드
  -supported-languages: 서버의 지원 언어 목록 조회
  -session-count <n>: 동시 세션 수 (기본 1, 1~1024)
  -max-stream-duration <sec|ptxs>: 오디오 전송 최대 지속시간(초 또는 ISO-8601 PTxS)</sec|ptxs>
  -connection-probe: 프로브만 수행(오디오는 max-stream-duration 지정 시에만 송신). --wavfile와 동시 사용 불가
  -orgid <uuid>: 조직(테넌트) ID UUID (미지정 시 랜덤 생성)
  -connection-rate <rps>: 초당 세션 생성 평균 속도(기본 50, 0.1~10000)
  -session-log-level <level>: 세션 로그 레벨(fatal|error|warn|info|debug|trace, 기본 info)
  -wavfile 미지정 시 톤 소스 사용.
  -connection-probe와 --wavfile은 상호 배타.

  ### WebSocket 테스트: `stt_websocket_test/server.js`
  - Env: PORT(또는 STT_TEST_PORT), WS_PATH(기본 /stt)
  - 기능: 텍스트/바이너리 수신 로그, INIT/bye 처리, 3초마다 한글 텍스트 송신
  
  ### TCP 테스트: `stt_tcp_test/server.js`
  - Env: PORT(또는 STT_TEST_TCP_PORT), TCP_FRAMING(raw|len32|newline), INIT_HEX, BYE_HEX
  - 기능: 프레이밍별 수신/송신, 3초마다 한글 텍스트 송신

