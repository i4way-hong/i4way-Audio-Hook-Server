# 다음 진행 사항(업데이트: 2025-09-18)

벤더 미확정 전제를 기준으로, 즉시 적용 가능한 작업을 우선 배치했습니다. 각 작업은 수락 기준을 명시해 CI/운영 안정성을 보장합니다.

원칙
- 프로토콜/핸드셰이크는 프로파일로 추상화(WS/TCP 공통 인터페이스 + INIT/BYE/ping/프레이밍을 설정으로 제어)
- 기본값은 안전(fail-fast)·에코 서버 호환 유지, 타이머/소켓/파일 핸들은 테스트 종료 시 항상 정리
- 변경은 테스트 우선, 기존 동작의 하위 호환 유지(필요 시 strict 모드 플래그로 강화)

스프린트 1: 안정화·최소 커버리지(최우선)
1) 설정 검증 강화(행동 변화 없이 메시지 개선)
- 작업: 음수/NaN ping 상세 에러 메시지, 알 수 없는 TCP 프레이밍 경고(또는 strict 모드에서 거절), HEX 파싱 오류 시 오프셋/바이트 로그, .env 샘플 보강
- 수락 기준:
  - 잘못된 값 입력 시 명확한 에러/경고 로그가 남고 프로세스가 일관되게 종료 또는 폴백됨
  - config-validation.test 확장 케이스 100% 통과, 오픈 핸들 누수 0

2) TCP half-close/백프레셔 경로 보강
- 작업: FIN 수신 시 쓰기 중단·우아한 종료; write:false→'drain' 재개; 에코 서버 기반 통합 테스트 추가
- 수락 기준:
  - half-close/강제 종료/대용량 쓰기에서 리소스 누수 없음(open-handle 0)
  - drain 경로 통합 테스트 3회 연속 green

3) 리샘플링 최소 매트릭스 준비(unskip 일부)
- 작업: 8k↔16k mono/stereo 단위 테스트(경계 클램핑·채널 독립성); 큰 프레임 경고 로그; 간단 성능 마이크로벤치(평균/표준편차)
- 수락 기준:
  - resample-matrix 일부 케이스 unskip 후 CI 안정 green
  - L16→resample→PCMU 크기/무음 특성 E2E 검증 통과

4) 문서/.env 업데이트
- 작업: README STT 섹션에 프로파일 개념, 프레이밍(raw|len32|newline), INIT/BYE 예시(JSON/HEX), ping 토글, resample on/off 사례 추가; .env 기본값 정리
- 수락 기준:
  - 새 키/예시/제약이 문서화되고 현 코드와 불일치 없음

스프린트 2: 매트릭스·스캐폴딩·가시성
1) 테스트 매트릭스 확장
- 작업: 포맷/채널/레이트 × resample on/off × WS 옵션(init/ping/bye on/off) 교차; WS/TCP 큰 프레임 분할/결합·부분 경계; 동적 포트; 리소스 정리 보강
- 수락 기준: 전체 매트릭스 3회 연속 green, “no tests”/open-handle 미발생

2) gRPC/MRCP 스캐폴딩(벤더 무관)
- 작업: 공통 Forwarder 인터페이스 준수; gRPC bidi proto 초안 + 미니 에코 서버/클라 + 통합 테스트; MRCP v2 RTSP 컨트롤 채널 스텁 + 설정 검증, RTP 송신기 스텁
- 수락 기준: start/stop/send happy-path 테스트 통과, 유효성·로그 의미 있음

3) 로깅 회전/보존 강화
- 작업: 자정 회전/선제 크기 회전/보존 청소 케이스 추가, CI 아티팩트 업로드로 산출물 검증
- 수락 기준: 보존일 지난 파일 삭제·-1 파일 생성 일관 검증

스프린트 3: 품질·벤더 대비
1) 리샘플러 고품질 옵션 설계
- 작업: FIR/windowed-sinc 설계 메모, quality=fast|high 플래그, 경고 임계값 튜닝
- 수락 기준: API/플래그 확정, fast 기본값으로 성능 회귀 없음

2) 프로파일 기반 핸드셰이크 어댑터
- 작업: INIT/BYE/ping/프레이밍을 조합하는 “핸드셰이크 프로파일” 정의(JSON 선언→동작), 설정 검증·예시 추가
- 수락 기준: 벤더 스펙 미확정 상태에서도 프로파일 교체만으로 실험 가능

CI 안정성(지속)
- OS/Node 매트릭스(ubuntu/macos/windows × LTS/latest), open-handle 탐지, 동적 포트, 회전 로그 아티팩트 업로드
- 수락 기준: 매트릭스 전부 green, 플래키 0, 타임아웃/핸들 누수 0

벤더 확정 전/후 전환 계획
- 확정 전: 에코 서버·프로파일 기반 통합 테스트로 회귀 안전망 유지
- 확정 후: 프로파일 추가 + 설정 키만 문서 반영 → 매트릭스에 신규 프로파일 라인 인입

체크리스트(스프린트 1)
- [x] config-validation 강화(메시지·로그)
- [x] TCP half-close/drain 처리 + 통합 테스트(기반 반영)
- [x] 8k↔16k mono/stereo 단위 테스트 + 큰 프레임 경고(리샘플 매트릭스 활성화)
- [x] README/.env STT 섹션 보강
- [x] STT 연동용 WebSocket 테스트 서버(stt_connection_test) 추가

---

# 이전 계획(보관)

## 다음 진행 사항 및 선택 과제

이 문서는 남은 선택 과제와 권장 다음 진행 단계를 요약합니다.

## 다음 진행(권장 순서)
1) 외부 STT 사양 확정
   - 핸드셰이크(초기 메시지/메타데이터), 바이너리 프레임 포맷, 인증 정책 정리.
   - 현재 구현은 연결 직후 바이너리 오디오만 송신.
2) STT WebSocket 포워더 확장
   - 사양에 맞게 초기 메시지 전송, 주기적 ping, 종료 시그널 추가.
   - 오류/재연결 전략(백오프, 세션 별 재시도) 설계.
3) 리샘플링 지원
   - 프레임 레이트 불일치 시 on-the-fly 리샘플링(예: 8k↔16k). 현재는 경고만 출력.
   - 품질/성능 검토 후 SoX/FFT 기반 또는 간단한 linear interpolation 구현.
4) grpc/mrcp/tcp 포워더 구현 여부 결정 및 구현
   - 공통 인터페이스 유지(SttForwarder) + 프로토콜별 어댑터.
5) 테스트 보강
   - 단위: 포워더 인코딩/채널/레이트 처리, 파일 회전/보존 로직.
   - 통합: 실제 STT 서버(또는 에코 서버)와의 end-to-end.
6) 운영 모니터링/메트릭
   - RTT, 전송 지연, 실패율, 재연결 횟수, 파일 회전/삭제 통계.
   - Prometheus 지표 또는 CloudWatch 지표 연계.

## 남은 선택 과제
- 리샘플러 유틸 추가(성능 벤치 포함).
- STT 인증/헤더 갱신(토큰 갱신 주기, 401 재시도).
- S3 업로드 파이프라인(멀티파트/재시도/백오프) 확정.
- 로그 트랜스포트 TypeScript 버전으로 교체 검토(`src/utils/rotating-log-stream.ts`).
- 세션 종료 시 잔여 큐 플러시/백프레셔 정책 재검토.
- 환경변수 체계 문서화/샘플 값 추가.

## 변경 요약(이번 커밋)
- STT 포워더: 프레임 레이트 불일치 시 1회 경고, L16 인터리브 전송 개선.
- .env: STT/로그 변수 보강, RECORDING_DIR로 키 변경.
- Dockerfile/소스 전반: LOG_ROOT_DIR → RECORDING_DIR로 치환.
- 문서(description.md) 업데이트 및 정리.

9월 17일 작업 후 진행할 일들들 → 실행 계획

1. 외부 STT 핸드셰이크/프레이밍 정의 반영(WebSocket/TCP)
   - 설계
     - WebSocket: 연결 직후 초기 메타데이터(JSON) 송신, 주기적 ping(옵션), 종료 시 BYE 메시지(옵션).
     - TCP: 원시 바이트 외에 길이프리픽스(len32BE)·newline 분절 등 선택 가능하도록 프레이밍 옵션화.
   - 구현
     - `audiohook/src/server/stt-forwarder.ts`
       - WebSocketForwarder: on('open')에 초기 JSON 송신, setInterval ping, stop()에서 종료 프레임 전송(옵션).
       - TcpForwarder: `.env` 기반 프레이밍(raw|len32|newline) 적용, 필요 시 INIT/BYE 바이트 시퀀스 송신.
     - `.env` 제안 키(기본값으로 비활성):
       - STT_WS_INIT_JSON, STT_WS_PING_SEC, STT_WS_BYE_JSON
       - STT_TCP_FRAMING=raw|len32|newline, STT_TCP_INIT_HEX, STT_TCP_BYE_HEX
     - 문서 보강: description.md(STT 섹션) 업데이트.
   - 수용 기준
     - 샘플 에코 서버에서 초기/오디오/종료 프레임 순서 및 분절이 명세대로 수신됨.
   - 상태: 코드/문서 반영 완료, WS/TCP 에코 통합 테스트 추가 완료(기본 전달·프레이밍 검증). 대상 STT 서비스의 최종 스키마 확인 후 값만 조정하면 즉시 호환 가능.

2. 리샘플링 추가(예: 8k↔16k 등)
   - 설계
     - 우선 8k↔16k 선형보간(Linear Interpolation) 경량 구현, 모노/스테레오 모두 지원.
     - 성능 여유 시 windowed sinc/소규모 FIR로 대체 가능.
   - 구현
     - `audiohook/src/audio/resample.ts` 신규: `resampleL16(input:Int16Array, inRate, outRate, channels)`.
     - `stt-forwarder.ts`에서 frame.rate≠stt.rate 시 변환 후 buildPayload.
     - `.env` 플래그: STT_RESAMPLE_ENABLED=true|false(기본 false).
   - 수용 기준
     - 8k 입력→16k STT 설정 시 출력 길이·에너지 레벨이 기대 범위, 왜곡 없는지 청감/간단 SNR 체크.

3. 통합 테스트 추가(STT 에코 서버 등)
   - 설계
     - WS/TCP 에코 서버를 테스트 중에 기동하여 수신 바이트 누적·검증.
     - 인코딩(L16/PCMU), 모노/스테레오, 레이트(리샘플링 on/off) 조합 테스트.
   - 구현
     - `test/stt/echo-ws.test.ts`: ws 서버 스핀업→Forwarder 연결→프레임 송신→수신 검증.
     - `test/stt/echo-tcp.test.ts`: net 서버 스핀업→프레이밍 옵션별 수신 검증.
     - 테스트 유틸: 고정 패턴 오디오 프레임 생성기.
   - 수용 기준
     - CI에서 안정 통과, 누수 없이 종료(소켓/타이머 clean).

4. gRPC 또는 MRCP 포워더 구현
   - gRPC
     - 설계: 양방향 스트리밍 API(proto 합의 필요). 메타 전송→오디오 청크→종료.
     - 구현: `GrpcForwarder`(@grpc/grpc-js) 스텁→실제 proto 확정 후 매핑.
   - MRCP
     - 권고: 외부 게이트웨이(예: SIP/MRCP 브리지) 연동 또는 별도 서비스로 분리. 직접 구현 시 RTP/MRCP 세션 관리 부담 큼.
   - 수용 기준
     - 합의된 사양으로 연결/오디오 전송/정상 종료가 재연 가능(에코/Mock로 E2E 검증).

5. 로그 회전/보존 테스트 작성
   - 설계
     - 크기 회전: maxMegabytes를 작게 두고 연속 write로 -0, -1 파일 생성 검증.
     - 보존: 과거 날짜 파일(접두사-YYYY-MM-DD[-N].log) 미리 만들어 `_cleanupOldLogs()` 실행 후 삭제 확인.
   - 구현
     - `test/log/rotating-file-transport.test.ts`: tmp 디렉터리 사용, transport 인스턴스 생성 후 write·검증.
     - 시간 의존성은 날짜 문자열 조작과 인스턴스 필드(currentDate) 주입으로 우회.
   - 수용 기준
     - 회전/보존 규칙이 기대대로 동작, 잔여 핸들/스트림 누수 없음.