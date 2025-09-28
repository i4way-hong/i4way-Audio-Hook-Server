# MRCP Bridge API 스펙 초안

목표
- AudioHook 서버가 수신한 오디오 프레임(L16/PCMU)을 UniMRCP 같은 MRCP 서버(MRCPv1/v2)로 전달해 STT(ASR) 세션을 수행하기 위한 최소 브릿지 인터페이스.
- 구현 난이도가 높은 RTSP/SIP + MRCP/RTP 스택은 브릿지 내부에서 캡슐화하고, 외부(AudioHook)는 순수 TypeScript 인터페이스로 제어.

용어
- MRCPv1: RTSP(TCP) 제어 채널 + RTP 오디오 채널
- MRCPv2: SIP 제어 채널 + RTP 오디오 채널
- 리소스(resource): speechrecog(ASR) / speechsynth(TTS)

전송 형식
- 오디오: PCMU(8k) 또는 L16(8k/16k/44.1k/48k), mono
- 제어: RTSP(MRCPv1) 또는 SIP(MRCPv2), 서버로부터 인식 이벤트/리절트 수신

상태 머신 개요
1) create → connectControl(RTSP/SIP) → mrcpSetup(Session-INIT/SETUP) → startRtp(sendonly) → streaming(sendAudio…) → teardown(close)

에러/종료
- 브릿지는 네트워크/프로토콜 오류를 BridgeEvent("error")로 보고.
- close() 호출 또는 RTSP TEARDOWN/SIP BYE 수신 시 BridgeEvent("closed").

TypeScript 인터페이스(요약)
- 자세한 타입은 `audiohook/src/mrcp/types.ts` 참고

- MrcpBridge
  - connect(endpoint, options) → Promise<MrcpSession>
  - sendAudio(payload: Buffer, opts?: { rtpTimestamp?: number })
  - close(reason?: string) → Promise<void>
  - on(event, listener)

- MrcpSessionOptions
  - resource: 'speechrecog' | 'speechsynth'
  - codec: 'PCMU' | 'L16'
  - sampleRate: 8000 | 16000 | 44100 | 48000
  - mono: boolean
  - language?: string
  - vendorHeaders?: Record<string,string>

- BridgeEvent(발췌)
  - 'rtsp-connected' { remote: string }
  - 'rtp-started' { localRtpPort: number, payloadType: number }
  - 'result' { nbest?: any, text?: string, confidences?: number[] }
  - 'closed' { reason?: string }
  - 'error' { message: string, cause?: unknown }

오디오 타이밍
- 기본: 브릿지가 자체 RTP 타이밍/타임스탬프 생성(8000Hz clock) 후 패킷화.
- 고급: sendAudio({ rtpTimestamp })로 외부 제공 가능.

리샘플/인코딩 책임
- AudioHook 포워더가 stt-config에 따라 L16↔PCMU, 8k/16k 리샘플을 선행. 브릿지는 Buffer(코덱 일치)를 RTP에 적재.

보안/네트워크
- RTSP/SIP 인증/암호화는 향후 확장(초안에서는 미포함). 방화벽에서 제어 채널(TCP/UDP)과 RTP(UDP) 범위 허용 필요.

환경 변수 제안(초안)
- STT_PROTOCOL=mrcp
- STT_MRCP_VERSION=1|2
- STT_ENDPOINT=rtsp://host:8060 (v1) 또는 sip:host:5060 (v2)
- STT_ENCODING=L16|PCMU
- STT_RATE=8000|16000|...
- STT_MONO=true
- STT_MRCP_RESOURCE=speechrecog
- STT_MRCP_LANGUAGE=ko-KR
- STT_MRCP_RTP_LOCAL_MIN=40000
- STT_MRCP_RTP_LOCAL_MAX=40100

샘플 시퀀스
1) forwarder.start() → bridge.connect()
2) forwarder.send(frame) → 리샘플/인코딩 → bridge.sendAudio(buf)
3) forwarder.stop() → bridge.close()

제한/향후
- 이 초안은 제어/이벤트 필드를 의도적으로 축소. 실제 구현 시 UniMRCP 서버 특성 및 사용 버전(v1/v2)에 맞춰 확장.

다음 단계 제안

- MrcpBridge 실제 구현체 작성(예: Node 애드온 또는 외부 게이트웨이/프로세스와 IPC)
- createSttForwarder('mrcp', ...)에서 브릿지 주입 경로 추가(환경 변수 또는 DI 컨테이너)
- UniMRCP 서버/클라이언트 템플릿의 포트/리소스/코덱을 환경과 일치시켜 검증 에코/Mock 세션으로 왕복 테스트

## Sidecar / Mock Bridge 사용 가이드

AudioHook는 `STT_MRCP_BRIDGE` 환경 변수로 커스텀 브릿지를 로드합니다. 별칭과 경로 자동 보정이 지원됩니다.

지원 별칭 (대소문자 구분 없음 가정 X):
- `sidecar` → `../mrcp/bridge-sidecar`
- `umc` → `../mrcp/bridge-umc`
- `mock` → `../mrcp/bridge-mock`

### 1) MRCP Sidecar Mock 서버 실행

로컬 개발용 간단 모의 서버가 `scripts/mrcp-sidecar-mock.ts` 로 추가되어 있습니다.

```bash
npm run sidecar:mock
```

기본 바인딩: `ws://127.0.0.1:9090/mrcp`

포트 변경:
```bash
MRCP_SIDECAR_PORT=9191 npm run sidecar:mock
```

### 2) AudioHook 설정 (PowerShell 예)

```powershell
$env:STT_PROTOCOL='mrcp'
$env:STT_ENDPOINT='rtsp://dummy-unimrcp:8060/unimrcp' # 혹은 sip: 주소 (실제 sidecar는 그대로 문자열만 사용)
$env:STT_MRCP_BRIDGE='sidecar'   # 또는 절대/상대 경로
$env:MRCP_SIDECAR_URL='ws://127.0.0.1:9090/mrcp'
$env:STT_ENCODING='L16'
$env:STT_RATE='16000'
```

### 3) 동작 흐름 (Mock)
1. forwarder.start() → sidecar 브릿지 WebSocket 연결
2. `init` JSON 전송
3. 서버가 `rtsp-connected`, 이어서 `rtp-started` 이벤트를 JSON으로 송신
4. 오디오 바이너리 프레임 누적(16KB 기준) → `result` 이벤트 모의 텍스트 송신
5. forwarder.stop() → `bye` → 서버 `closed` 이벤트 후 소켓 종료

### 4) 문제 해결 (Troubleshooting)
| 증상 | 원인 | 조치 |
|------|------|------|
| Failed to load STT_MRCP_BRIDGE | 잘못된 경로/별칭 | `sidecar`, `mock` 처럼 별칭 사용 또는 상대경로(`../mrcp/bridge-sidecar`) 재설정 |
| No result events | 오디오 프레임 미전송 | 인바운드 오디오 생성/전달 경로 확인 (MediaDataFrame 생성 코드) |
| 즉시 mock 으로 폴백 | 모듈 export 문제 | default export 또는 module.exports 가 connect 함수 가진 객체인지 확인 |

### 5) 확장 아이디어
- result 이벤트에 n-best, confidence 필드 시뮬레이션 추가
- 오류 주기적 삽입(네트워크/timeout)으로 재연결 로직 검증
- RTP timestamp 외부 제공 path 시험용 옵션 노출
