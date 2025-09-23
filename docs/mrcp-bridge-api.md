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