# UniMRCP 연동 스켈레톤 가이드

구성 요소
- server.ts: 사이드카 진입점. 시그널링 모듈을 로드해 RTP 목적지와 엔진 이벤트를 수신합니다.
- signaling/module-example.ts: JS 예시 모듈(데모용). 실제 UniMRCP 연동을 대체할 수 없습니다.
- signaling/unimrcp-signaling.ts: UniMRCP 연동 스켈레톤. 네이티브 애드온 또는 외부 데몬과 연계하도록 준비되어 있습니다.

환경 변수(.env)
- MRCP_SIDECAR_SIGNALING=module
- MRCP_SIDECAR_SIGNALING_MODULE=./audiohook/src/sidecar/signaling/unimrcp-signaling
- MRCP_RTP_PORT_MIN=40000
- MRCP_RTP_PORT_MAX=40100
- (테스트용) MRCP_REMOTE_RTP_IP, MRCP_REMOTE_RTP_PORT

모듈 API 계약(server.ts가 기대하는 형태)
- openSession(args): Promise<{ remoteIp, remotePort, payloadType, emitter, close }>
  - args: { endpoint, profileId, codec, sampleRate, language? }
  - 반환 객체의 emitter는 아래 이벤트 객체를 그대로 emit 해야 합니다.
    - { type: 'result', ... }
    - { type: 'closed', reason? }
    - { type: 'error', message, cause? }

unimrcp-signaling.ts 스켈레톤
- 네이티브 애드온(Node-API) 또는 외부 데몬과 연계하는 두 경로를 지원합니다.
- node-gyp-build를 통해 ./native 폴더의 애드온을 우선 로드하려 시도합니다.
- 네이티브 바인딩이 없으면 환경변수 기반의 fallback(데모)로 동작합니다.

네이티브 바인딩에서 제공해야 하는 함수
- openSession(args & { rtpPortMin, rtpPortMax }): Promise<{ remoteIp, remotePort, payloadType, handle }>
  - RTSP(MRCPv1)/SIP(MRCPv2) 시그널링 및 SDP 협상 수행
  - 로컬 RTP 포트는 [rtpPortMin, rtpPortMax] 범위 내에서 할당
- onEvent(handle, cb)
  - MRCP 이벤트(인식 완료, 에러, 종료 등)를 JSON 직렬화 가능한 객체로 콜백
- closeSession(handle): Promise<void>

이벤트 브리지 규칙
- result: { type: 'result', text?: string, nbest?: any, confidences?: number[] }
- closed: { type: 'closed', reason?: string }
- error:  { type: 'error', message: string, cause?: any }

방화벽/포트
- 제어: RTSP(기본 8060) 또는 SIP(기본 5060)
- RTP: MRCP_RTP_PORT_MIN~MAX 인바운드 허용

테스트 순서
1) .env 수정 후 사이드카 실행: npm run sidecar
2) 앱에서 MRCP 브릿지를 사이드카로 설정(이미 설정됨)
3) MRCP_REMOTE_RTP_IP/PORT로 임시 목적지 지정하여 프레임 전송 확인(엔진 연동 전)
4) 네이티브/데몬 구현이 준비되면 MRCP_REMOTE_RTP_* 제거, 실제 SDP 결과 사용
