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

TCP 전용
- STT_TCP_FRAMING=raw|len32|newline
- STT_TCP_INIT_HEX=0a0b0c (연결 직후 송신할 HEX)
- STT_TCP_BYE_HEX=ff00 (종료 시 송신할 HEX)

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
# TCP 예시
# STT_PROTOCOL=tcp
# STT_ENDPOINT=127.0.0.1:9001
# STT_TCP_FRAMING=len32
# STT_TCP_INIT_HEX=0a0b
# STT_TCP_BYE_HEX=ff
```

### 실전/테스트 팁
- ping 값은 양수여야 하며, NaN/0/음수는 자동 비활성화됩니다.
- TCP framing이 알 수 없는 값이면 raw로 폴백됩니다.
- HEX 페이로드는 짝수 길이의 16진수여야 하며, 잘못된 값은 무시됩니다.
- resample은 현재 L16에 한해 지원합니다.
- 테스트 환경(Jest 등)에서는 fs.watch가 비활성화되어 핸들 누수 없이 종료됩니다.
- INIT/BYE/프레이밍/레이트/인코딩 조합별로 에코 서버로 검증 가능하며, 모든 옵션은 통합 테스트로 커버됩니다.
