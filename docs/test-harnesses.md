# STT Test Harnesses (Unified)

세 가지 테스트 서버 (WebSocket / TCP / gRPC) 모두 동일한 개념의 환경 변수, 로깅 포맷, 캡처 구조를 사용하도록 통합되었습니다.

- 오디오 패킷을 일정 간격으로 집계해 JSON 요약을 생성하며, 설정된 `FORWARD_WS_URL` 로만 전송합니다. 기본 연결(WS/TCP/gRPC)에는 더 이상 요약 JSON 을 직접 보내지 않습니다.
- `OUTBOUND_PACKET_INTERVAL` 과 `FORWARD_WS_MAX_QUEUE` 등 집계/전달 관련 환경 변수는 세 서버에서 동일한 의미로 동작합니다.

## 공통 환경 변수
| 변수 | 설명 | 기본값 |
|------|------|--------|
| PORT / STT_TEST_PORT / STT_TEST_TCP_PORT / GRPC_TEST_PORT | 리스닝 포트 (프로토콜별 우선순위) | 프로토콜별 내부 기본(WS:8080 / TCP:7070 / gRPC:55051) |
| WS_PATH / PATHNAME | WebSocket 경로 | /stt |
| TCP_FRAMING | TCP 프레이밍(raw|len32|newline) | raw |
| AUDIO_ENCODING | 오디오 인코딩 (PCMU|L16) | PCMU |
| CHANNELS | 채널 수 (1=mono, 2=rx/tx 분리) | 1 |
| LOG_SAMPLES | 통계 주기당 샘플 미리보기 개수 | 8 |
| LOG_JSON | 1/true 시 JSON 로그 (info/debug/error) | 0 (gRPC 테스트 서버는 1) |
| CAPTURE_DIR | 캡처 파일 저장 디렉터리 | captures |
| CAPTURE_WAV | 1/true 시 gRPC: 추가로 디코딩된 mono 16bit WAV 작성 (PCMU→L16) | 0 |
| MESSAGE_INTERVAL_MS | 주기적 안내/echo 텍스트 송신 간격 (WS/TCP) | 3000 |
| ANNOUNCEMENT_TEXT | TCP 하네스 안내 문구 템플릿 (`{time}`, `{sentence}` 치환; 빈 문자열이면 비활성) | 기본 안내문 |
| ECHO_TEXT | 설정 시 partial/주기/환영 메시지 모두 고정 텍스트 사용 | (없음) |
| CONVERSATION_LOOKUP_URL | 대화 메타데이터 조회 REST 엔드포인트 (미설정 시 비활성) | (없음) |
| CONVERSATION_LOOKUP_QUERY_PARAM | 대화 ID 쿼리 파라미터 이름 | conversation_id |
| CONVERSATION_LOOKUP_TIMEOUT_MS | 외부 조회 HTTP 타임아웃(ms) | 3000 |
| CONVERSATION_LOOKUP_CACHE_SECONDS | 동일 conversation 응답 캐시 유지 시간(s) | 30 |
| TRANSCRIPT_INTERVAL | gRPC partial transcript N 마다 생성 | 12 |
| FINAL_DELAY_MS | gRPC final transcript 지연 | 250 |
| BACKPRESSURE_ENABLED | gRPC 테스트 서버: 내부 큐 지연 시뮬레이션 | 0 |
| BACKPRESSURE_MAX_QUEUE | gRPC 큐 최대 길이 | 200 |
| BACKPRESSURE_PROCESS_MS | gRPC 오디오 프레임 처리 지연(ms) | 0 |
| RANDOM_STREAM_ERROR_RATE | gRPC partial 시 확률적 stream error 주입 | 0 |
| RANDOM_STREAM_ERROR_CODES | gRPC stream error 후보 코드 | INTERNAL,RESOURCE_EXHAUSTED,ABORTED |
| RANDOM_FINAL_ERROR_RATE | gRPC final 전 확률적 final error 주입 | 0 |
| RANDOM_FINAL_ERROR_CODES | gRPC final error 코드 후보 목록 | INTERNAL |
| CPU_SPIN_MS | partial/final 직전 busy spin (부하) | 0 |
| GRPC_TEST_AUTH_TOKEN | gRPC Authorization Bearer 토큰 | (없음) |
| GRPC_TEST_CHANNELS | gRPC 캡처 채널 수 (1=모노, 2=가상 스테레오 분리) | 1 |
| PCMU_MONO_EXPORT | 채널>1 + PCMU 시 채널0 모노 파일 추가 생성 | 1 |
| GRPC_TEST_TLS_CERT/KEY/CA | gRPC TLS/mTLS 설정 | (없음) |
| GRPC_TEST_PROTO_PATH | proto 직접 경로 지정(탐색 실패 대비) | (자동 탐색) |
| STT_GRPC_FORCE_PCMU_8K | gRPC 클라이언트(Forwarder) PCMU 시 8kHz 강제 (1/true=on) | 1 |
| STT_GRPC_PCMU_SAMPLE_RATE | PCMU 강제 샘플레이트 override (실험용: 8000/16000 등) | 8000 |

## 캡처 파일 구조
모든 서버는 `CAPTURE_DIR` 하위에 세션별 3개(또는 2개) 파일을 생성:
- WebSocket / TCP:
  - `<proto>_TIMESTAMP_IP_combined.<ext>` (전체 프레임 순서)
  - `<proto>_TIMESTAMP_IP_rx.<ext>` (채널0)
  - `<proto>_TIMESTAMP_IP_tx.<ext>` (채널1 존재 시)
  - 확장자: L16 -> .l16, PCMU -> .pcmu
- gRPC:
  - `grpc_TIMESTAMP_peer_random_combined.<ext>` (ext: pcmu|l16)
  - `grpc_TIMESTAMP_peer_random_rx.<ext>` (채널 1; 모노일 경우 combined 과 동일)
  - `grpc_TIMESTAMP_peer_random_tx.<ext>` (채널 2 사용 시 생성)
  - `grpc_TIMESTAMP_peer_random_combined_mono.pcmu` (채널=2 + PCMU + PCMU_MONO_EXPORT=1 일 때 채널0 순차 모노)
  - `grpc_TIMESTAMP_peer_random_meta.json` (init 시점 메타: 세션/모델/초기 파라미터/env)
  - `grpc_TIMESTAMP_peer_random_final.json` (종료 시점 타이밍 메트릭)
  - (옵션) `grpc_TIMESTAMP_peer_random.wav` (`CAPTURE_WAV=1`일 때; PCMU는 L16으로 디코딩됨)

## 로깅 포맷
- LOG_JSON=1: `{ ts, level, msg, ...keys }` JSON 한 줄
- LOG_JSON=0: `[level] message k=v ...`
- 공통 메시지 키 예시: `conn, send_text, stats, capture_saved, close, socket_error, ws_error, listening`
- gRPC 서버는 기존 기능 로그(ready, transcript, error events) 외 `capture_saved`, `meta_saved` 추가

## 사용 예시
### WebSocket
```bash
LOG_JSON=1 CAPTURE_DIR=captures_ws PORT=18080 node server.js
```

### TCP
```bash
LOG_JSON=1 CAPTURE_DIR=captures_tcp PORT=17070 TCP_FRAMING=len32 CHANNELS=2 AUDIO_ENCODING=L16 node server.js
```

### gRPC
```bash
LOG_JSON=1 CAPTURE_DIR=captures_grpc GRPC_TEST_PORT=15551 TRANSCRIPT_INTERVAL=5 FINAL_DELAY_MS=400 node server.js
```

## ECHO_TEXT
테스트 재현성을 위해 지정하면 모든 주기적/partial 텍스트가 동일 문자열 (gRPC final은 `(final)` suffix)로 고정됩니다.

## 캡처 재생 / 변환 가이드
gRPC 캡처는 init.encoding 값에 따라 원시 포맷이 달라집니다.

채널 분리( GRPC_TEST_CHANNELS=2 ) 시:
- LINEAR16: combined = 인터리브(LRLR...), rx = L 채널, tx = R 채널
- PCMU: combined = 인터리브(L,R,L,R...), rx/tx 각각 디인터리브된 8bit μ-law
WAV(`CAPTURE_WAV=1`)는 채널 수에 맞게 1 또는 2 채널 헤더로 작성, PCMU는 디코딩(L16) 후 인터리브.

| 확장자 | 의미 | 재생 방법 (Linux 예) |
|--------|------|----------------------|
| .pcmu  | G.711 μ-law 8k 모노 | `sox -t raw -r 8000 -e mu-law -c 1 file.pcmu -d` |
### PCMU 다채널 재생 시나리오
다채널(2) PCMU 캡처에서:
1. `*_combined.pcmu` 는 인터리브 L,R,L,R... 패턴.
2. `*_rx.pcmu` 는 채널0 (L), `*_tx.pcmu` 는 채널1 (R) 추출.
3. 새로 추가된 `*_combined_mono.pcmu` 는 L 채널만 연속 저장 → 가장 단순 재생/분석용.

재생 예 (모노 채널 확인):
```bash
sox -t raw -r 8000 -e mu-law -c 1 grpc_xxx_combined_mono.pcmu -d
```
스테레오 복원(인터리브 combined 를 활용):
```bash
sox -t raw -r 8000 -e mu-law -c 2 grpc_xxx_combined.pcmu out.wav
```
채널 분리된 rx/tx 두 개를 다시 스테레오로 합치기:
```bash
sox -M \
  -t raw -r 8000 -e mu-law -c 1 grpc_xxx_rx.pcmu \
  -t raw -r 8000 -e mu-law -c 1 grpc_xxx_tx.pcmu \
  out_stereo.wav
```
| .l16   | Linear PCM 16-bit little-endian 8k 모노 | `sox -t raw -r 8000 -e signed -b 16 -c 1 file.l16 -d` |
| .wav   | (옵션) 디코딩된 Linear16 (CAPTURE_WAV=1) | 직접 재생 가능 (`sox file.wav -d` 등) |

Windows (PowerShell) 예시 (SoX 설치 가정):
```powershell
sox -t raw -r 8000 -e mu-law -c 1 .\grpc_XXXX_rx.pcmu .\out.wav
start .\out.wav
```

FFmpeg 사용 예:
```bash
ffmpeg -f mulaw -ar 8000 -ac 1 -i grpc_XXXX_rx.pcmu out.wav
ffmpeg -f s16le -ar 8000 -ac 1 -i grpc_XXXX_rx.l16 out.wav
```

노이즈로 들리는 경우 대부분 PCMU 파일을 PCM으로 잘못 해석했기 때문입니다. 확장자가 `.pcmu` 인 경우 반드시 mulaw 인코딩 옵션을 지정해야 합니다.

### 재생 속도가 너무 빠르거나 느린 경우 (WAV 포함)
증상: `CAPTURE_WAV=1`로 생성된 WAV를 재생했을 때 음성이 빨리 (혹은 느리게) 재생되는 현상.

원인:
1. 실제 오디오가 8000Hz인데 플레이어가 16000/48000 등 다른 레이트로 추정.
2. PCMU(μ-law)는 표준적으로 8000Hz인데 클라이언트가 잘못된 `sample_rate_hz` 값을 init으로 보냈을 때 헤더/플레이어 혼선.
3. LINEAR16 이지만 init 에 잘못된 sample_rate_hz 가 들어와 헤더 레이트와 실제 샘플 간 불일치.

서버 동작 (현재 버전):
- encoding=PCMU 일 때는 어떤 값이 오더라도 경고 로그(`pcmu_sample_rate_mismatch_force_8000`) 출력 후 8000Hz 로 강제.
- encoding=LINEAR16 일 때 `sample_rate_hz` (허용 값 8000/16000/48000) 사용. 리스트 밖이면 경고(`unexpected_linear16_sample_rate`).
- meta JSON 에 `audio.declaredSampleRateHz` 와 `audio.effectiveSampleRateHz` 기록 → WAV 헤더는 `effectiveSampleRateHz` 기준.

해결/점검 절차:
1. meta 파일에서 `effectiveSampleRateHz` 확인.
2. 플레이어 강제 지정 재생 (예: sox):
  ```bash
  sox file.wav -r <effectiveRate> -d
  ```
3. 필요 시 재샘플링/재인코딩:
  ```bash
  ffmpeg -i file.wav -ar 8000 fixed.wav
  ```
4. PCMU 원시 캡처를 직접 재생 시 샘플레이트를 8000 으로 반드시 명시:
  ```bash
  sox -t raw -r 8000 -e mu-law -c 1 file.pcmu -d
  ```

WAV 가 빨리 들린다면 대부분 실제 8000Hz 데이터를 16000Hz 로 재생한 케이스입니다. meta 의 effective 값이 8000이면 플레이어 레이트를 8000으로 강제하세요.

### 추가 자동 진단 (파이널 메타 stats)
`*_final.json` 파일에 `stats.derivedSampleRateHz` 가 있다면 서버가 수신 바이트와 경과 시간으로 계산한 추정 샘플레이트입니다.

| 필드 | 의미 |
|------|------|
| audio.declaredSampleRateHz | 클라이언트 init 가 보낸 값 |
| audio.effectiveSampleRateHz | WAV 헤더에 사용된 값 (PCMU 강제 8000) |
| stats.derivedSampleRateHz | 바이트/시간으로 역산한 값 (±15% 이상 차이면 경고) |
| stats.totalAudioBytes | 전체 수신 오디오 바이트 (인터리브 포함) |

경고 로그 예시:
`sample_rate_mismatch_detected declared=16000 effective=16000 derived=7980`

이 경우 실제 데이터는 8k, 클라이언트가 16k 를 선언한 상황 → 플레이어 8k 로 재생하면 정상.

### TCP 와 gRPC PCMU 일관성
TCP 테스트 서버는 단순히 수신한 바이트를 1바이트=1샘플(PCMU)로 가정(표준 8k)하여 캡처합니다. gRPC 경로에서도 Forwarder 가 기본적으로 PCMU 를 8k 로 강제해 두 서버 간 재생 속도 일관성을 맞춥니다. 필요 시 `STT_GRPC_PCMU_SAMPLE_RATE` 로 실험값을 지정할 수 있으나 일반적인 전화 음성/μ-law 환경에서는 8000Hz 유지가 권장됩니다.

## 향후 개선 아이디어
- gRPC 캡처에 채널 분리(가능 시) 및 오디오 포맷 헤더 파일 추가 (메타 JSON 구현 완료)
- 공통 헬스체크 엔드포인트(/health) TCP 제공 (현재 WS/HTTP 만)
- CLI wrapper (`node scripts/run-test-server --proto=grpc ...`)

---
본 문서는 세 테스트 하네스 동작을 일관되게 맞추기 위한 내부 개발 참고용입니다.
