# Client Data Generator 사용법

AudioHook 서버(WebSocket)에 테스트 오디오를 전송하고, 다수의 동시 세션을 생성해 기능/부하 검증을 할 수 있는 샘플 클라이언트입니다.

- 위치: `app/client_data_generator/`
- 실행 진입점: `npm start` (ts-node)
- 실행 스크립트(Windows 예): `run_client.cmd`

## 사전 준비
- Node.js 18 이상 (권장: 20+)
- AudioHook WS/WSS 서버 URI (예: `ws://localhost:8080/stt` 또는 `wss://<host>/api/v1/audiohook/ws`)
- (선택) API Key, Client Secret(Base64)

## 설치
```powershell
cd d:\ws2\audiohook\audiohook-reference-implementation\app\client_data_generator
npm ci
```

## 빠른 시작 (Windows PowerShell)
1) 로컬 WAV 파일 전송
```powershell
cd d:\ws2\audiohook\audiohook-reference-implementation\app\client_data_generator
npm start -- --uri ws://localhost:8080/stt --wavfile "C:\\audio\\sample_8k.wav"
```

2) WAV 미지정 시 톤(신호음) 발생기로 송출
```powershell
npm start -- --uri ws://localhost:8080/stt
```

3) 동시 세션/부하 설정
```powershell
# 동시 10세션, 초당 5세션 생성, 각 세션 최대 30초 송출
npm start -- --uri ws://localhost:8080/stt `
  --session-count 10 `
  --connection-rate 5 `
  --max-stream-duration 30
```

4) 연결 프로브(오디오 미송신)
```powershell
npm start -- --uri ws://localhost:8080/stt --connection-probe
```

5) 운영(또는 테스트) 서버로 인증 포함 전송
```powershell
npm start -- --uri wss://example.com/api/v1/audiohook/ws `
  --api-key R2VuZXN5c2Nsb3Vk `
  --client-secret YTEyMzQ1Njc4OQ== `
  --wavfile "C:\\audio\\call_16k.wav"
```
    예1) 파일 재생 새션 2개, 초당 2개 세션발생, 스트림길이 60초
    npm start -- --uri ws://127.0.0.1:3000/api/v1/audiohook/ws --api-key R2VuZXN5c2Nsb3Vk --client-secret YTEyMzQ1Njc4OQ== --wavfile C:\cti\001-ed_sheeran_-_shape_of_you.wav --session-count 2 --connection-rate 2 --max-stream-duration 60

    예2) 비프음 발생 새션 2개, 초당 2개 세션발생, 스트림길이 60초 
    npm start -- --uri ws://127.0.0.1:3000/api/v1/audiohook/ws --api-key R2VuZXN5c2Nsb3Vk --client-secret YTEyMzQ1Njc4OQ== --session-count 10 --connection-rate 2 --max-stream-duration 60

6) 서버 지원 언어 조회
```powershell
npm start -- --uri wss://example.com/api/v1/audiohook/ws --supported-languages
```

참고: `run_client.cmd` 를 열어 내부 인자를 수정해도 됩니다.

## 명령행 옵션
코드는 `src/index.ts`의 Commander 정의를 따릅니다.

- `[serveruri]` 또는 `--uri <uri>`: 서버 WS/WSS URI (둘 중 하나만 사용)
- `--wavfile <path>`: 전송할 WAV 파일 경로(미지정 시 톤 사용)
- `--api-key <apikey>`: 서버 인증용 API Key (Base64/url-safe 형식 허용)
- `--client-secret <base64>`: 메시지 서명용 클라이언트 시크릿(Base64)
- `--custom-config <json>`: open 메시지의 customConfig 로 전달할 JSON 문자열
- `--language <code>`: 언어 코드(예: `ko-KR`, `en-US`)
- `--supported-languages`: 서버 지원 언어 목록 조회 후 종료
- `--session-count <n>`: 동시 세션 수 (기본 1, 1~1024)
- `--max-stream-duration <sec|PTxS>`: 오디오 송출 시간 제한(초 또는 ISO-8601, 예: `30` 또는 `PT30S`)
- `--connection-probe`: 연결 확인만 수행(오디오 미송신). `--wavfile`와 동시 사용 불가
- `--orgid <uuid>`: 조직(테넌트) ID (미지정 시 랜덤 UUID 생성)
- `--connection-rate <rps>`: 초당 세션 생성 속도(기본 50, 범위 0.1~10000)
- `--session-log-level <level>`: 각 세션 로그 레벨 `fatal|error|warn|info|debug|trace` (기본 `info`)

유효성 제약(요약):
- `--connection-probe` 와 `--wavfile` 는 상호 배타
- `--api-key`/`--client-secret` 형식 검증(정규식/BASE64)
- `--session-count` 1~1024, `--connection-rate` 0.1~10000

## 사용 팁
- 빠르게 종료: 콘솔에서 Ctrl+C (한 번 눌러 정상 종료, 두 번은 즉시 종료)
- WAV 샘플레이트: 일반적으로 8k 또는 16k 를 권장 (서버/엔진 설정과 일치 필요)
- 문제가 생기면 터미널 로그를 첨부하여 이슈를 공유하세요.

## 문제 해결(FAQ)
- 에러: `More than one server URI specified!`
  - 위치 인자와 `--uri` 를 동시에 주지 마세요. 하나만 사용하세요.
- 인증 실패
  - `--api-key`, `--client-secret` 값/형식을 재확인하세요.
- 오디오가 빠르게/느리게 들림
  - 입력 WAV 샘플레이트와 서버 기대 레이트가 다를 수 있습니다. 8k/16k 파일 사용을 권장합니다.

## 라이선스
- MIT (package.json 참조)
