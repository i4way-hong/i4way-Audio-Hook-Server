# 1. Docker를 이용한 audiohook  운영방법

## 1.1 Docker 설치
```bash
# 1) 과거 버전 제거(있다면)
sudo dnf remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine

# 2) 플러그인 설치
sudo dnf -y install dnf-plugins-core

# 3) Docker 공식 저장소 등록
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo

# 4) Docker Engine + Buildx + Compose 설치
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 5) 서비스 활성화 및 기동
sudo systemctl enable --now docker

# 6) docker 그룹
sudo usermod -aG docker $USER
newgrp docker

# 7) 확인
docker version
docker compose version
docker info
```

### 1.2 디렉터리 생성 및 환경변수 생성

```bash
sudo mkdir -p /opt/audiohook/{logs,recordings,configs,src,compose}
sudo chown -R $USER:$USER /opt/audiohook

# SELinux: 컨테이너 쓰기 가능 라벨
sudo chcon -Rt svirt_sandbox_file_t /opt/audiohook
```

환경 변수 예시(`/opt/audiohook/configs/.env`):

```bash
# # AudioHook 배포 설정
# ----- 로컬 실행(app 디렉터리 직접 실행) 옵션 -----
SERVERPORT=3000
# HOST IP 또는 도메인 (Fargate/CDK 배포 시 주석 처리)
SERVERHOST=0.0.0.0
RECORDING_DIR=/app/recordings
# 파일 저장 기능 토글 (true/false, 1/0, yes/no)
RECORDING_TO_FILE_ENABLED=true
# 경로 변경 시 즉시 파일 회전 여부 (true/false)
RECORDING_IMMEDIATE_ROTATE=true

# 선택: 로컬에서도 S3 업로드를 원할 때 지정 (필요한 AWS 자격 증명 설정 요망)
RECORDING_S3_BUCKET=

# Conversation lookup (optional)
CONVERSATION_LOOKUP_URL=http://172.168.30.50:8086/conversation?
CONVERSATION_LOOKUP_QUERY_PARAM=conversation_id
CONVERSATION_LOOKUP_TIMEOUT_MS=3000
CONVERSATION_LOOKUP_CACHE_SECONDS=30

# 2) 또는 정적 매핑(JSON 문자열). 개발/로컬 실행에 유용
#    예시 값은 프로토콜 문서의 샘플 API 키/시크릿입니다.
# Genesyscloud/a123456789
STATIC_API_KEY_MAP={"R2VuZXN5c2Nsb3Vk":"YTEyMzQ1Njc4OQ=="}

# 선택: 로컬에서 Secrets Manager 사용 시 지정 (이름 또는 ARN)
SECRET_NAME_OR_ARN=

# STT 기본 설정
STT_ENABLED=true
STT_PROTOCOL=websocket #mrcp | websocket | tcp | grpc
STT_ENDPOINT=ws://172.168.10.211:8080/stt
            # mrcp : rtsp://172.168.10.211:8060/unimrcp
            # websocket : ws://172.168.10.211:8080/stt
            # tcp : tcp://172.168.10.211:7070
            # gRPC: 172.168.10.211:55051

STT_ENCODING=PCMU # L16 | PCMU
STT_RATE=8000 # 8000 | 16000 | 44100 | 48000
STT_MONO=false # true면 0번 채널만 전송
STT_RESAMPLE_ENABLED=false # true면 레이트 미스매치 시 자동 변환

# WebSocket 옵션
STT_WS_INIT_JSON={"type":"init","sampleRate":8000} # 연결 직후 송신할 JSON
STT_WS_PING_SEC=30 # 0 또는 미설정 시 ping 비활성화
STT_WS_BYE_JSON={"type":"bye"} # 종료 시 송신할 JSON
# WebSocket 확장 옵션
STT_WS_MODE=binary # binary | json-base64
#STT_WS_SUBPROTOCOL= # 필요한 경우 지정
STT_WS_JSON_AUDIO_KEY=audio # json-base64 모드에서 오디오 키

# TCP 옵션
STT_TCP_FRAMING=raw # raw | len32 | newline
STT_TCP_INIT_HEX=0a0b0c # 연결 직후 송신할 HEX(예: 0a0b0c)
STT_TCP_BYE_HEX=ff00 # 종료 시 송신할 HEX(예: ff00)
# TCP TLS 옵션
STT_TCP_TLS=false # true 시 아래 인증서/키 옵션 사용
STT_TCP_TLS_REJECT_UNAUTHORIZED=true
STT_TCP_TLS_SERVERNAME=
STT_TCP_TLS_CA_FILE=
STT_TCP_TLS_CERT_FILE=
STT_TCP_TLS_KEY_FILE=

# 재접속(백오프) 옵션
STT_RECONNECT_ENABLED=false
STT_RECONNECT_INITIAL_MS=500
STT_RECONNECT_MAX_MS=10000
STT_RECONNECT_FACTOR=2.0

# 벤더 플러그인 옵션(핸드셰이크/페이로드/결과 파싱 커스터마이즈)
# 예: STT_VENDOR_PLUGIN=./audiohook/vendor/acme-plugin.js
STT_VENDOR_PLUGIN=
# 벤더별 추가 파라미터(JSON 문자열). 플러그인에서 필요 시 파싱해 사용
STT_VENDOR_PARAMS=

# MRCP 브릿지 설정
# 사용자 구현(예: 네이티브 애드온, 외부 게이트웨이의 IPC 클라이언트)을 지정하면 해당 모듈을 require하여 사용
# 예) STT_MRCP_BRIDGE=./audiohook/vendor/mrcp-bridge-node
#STT_MRCP_BRIDGE=../mrcp/bridge-umc.js
# STT_MRCP_BRIDGE를 사이드카 브릿지로 전환
STT_MRCP_BRIDGE="./audiohook/src/mrcp/bridge-sidecar"
# 사이드카 WebSocket 엔드포인트
MRCP_SIDECAR_URL="ws://127.0.0.1:9091/mrcp"
# 사이드카 수신 포트
MRCP_SIDECAR_PORT=9091
# MRCP 프로필 선택(ah-mrcpv1 | ah-mrcpv2)
STT_MRCP_PROFILE=ah-mrcpv1
# MRCP 대상 언어(필요 시)
STT_MRCP_LANGUAGE=
# UniMRCP CLI 설정은 사이드카 모드에선 미사용(참고용 유지)
UNIMRCP_ROOT="C:/Program Files/UniMRCP"
UMC_PROFILE=asr-default
UMC_LOG_LEVEL=7
UNIMRCP_CLIENT_EXE="C:/Program Files/UniMRCP/bin/unimrcpclient.exe"

# --- MRCP 사이드카 (RTP/시그널링) 추가 설정 ---
# RTP 로컬 바인딩 포트 범위
MRCP_RTP_PORT_MIN=40000
MRCP_RTP_PORT_MAX=40100

# 시그널링 구현 선택: stub | native | module
#  - stub: 내장 스텁(데모 전용)
#  - native/module: UniMRCP SDK 연동 모듈을 require하여 사용
MRCP_SIDECAR_SIGNALING=module
# 시그널링 모듈 경로(위 값이 native/module일 때 필수)
MRCP_SIDECAR_SIGNALING_MODULE=./audiohook/src/sidecar/signaling/unimrcp-signaling

# ----- 애플리케이션 로깅 설정 -----
# 로그 레벨: trace|debug|info|warn|error|fatal|silent
LOG_LEVEL=debug
# 로그 파일 디렉터리
LOG_DIR=/app/logs
# 로그 파일 접두사 (파일명은 prefix-YYYY-MM-DD[-N].log)
LOG_PREFIX=app
# 파일당 최대 크기(MB)
LOG_MAX_MB=50
# 보존 일수
LOG_RETENTION_DAYS=7
# 수신 텍스트 로그 ASCII만 표시(개발용)
STT_WS_LOG_ASCII=0

# ---------------- gRPC (STT) 설정 (내장 서버 제거됨) ----------------
# 내장 gRPC 서버( GRPC_ENABLED / GRPC_PORT / GRPC_TLS_* / GRPC_AUTH_TOKEN )는 2025-09-30 제거되었습니다.
# 이제 클라이언트 Forwarder 만 사용하며 외부 STT gRPC 서비스나 stt_grpc_test 시뮬레이터에 연결합니다.
# 아래 GRPC_* 변수들은 deprecated 상태이므로 주석 처리 상태로 유지 (참고용). 필요시 삭제 가능.
# GRPC_ENABLED=1            # (deprecated) embedded server 사용 안함
# GRPC_PORT=50051           # (deprecated)
# GRPC_AUTH_TOKEN=          # (deprecated) 서버측 토큰
# GRPC_TLS_CERT=certs/server.crt   # (deprecated)
# GRPC_TLS_KEY=certs/server.key    # (deprecated)
# GRPC_TLS_CA=certs/ca.pem         # (deprecated)

# Forwarder 클라이언트 인증 토큰 (Metadata Authorization: Bearer <token>)
STT_GRPC_AUTH_TOKEN=

# --- Forwarder 재연결 (gRPC 전용 오버라이드) ---
STT_GRPC_RECONNECT_ENABLED=true
STT_GRPC_RECONNECT_INITIAL_MS=1000
STT_GRPC_RECONNECT_MAX_MS=15000
STT_GRPC_RECONNECT_FACTOR=2.0
STT_GRPC_RECONNECT_JITTER=0.3

# --- Forwarder TLS/mTLS (클라이언트) ---
# STT_GRPC_TLS_ENABLED=true
# STT_GRPC_TLS_CA_FILE=certs/ca.pem
# STT_GRPC_TLS_CERT_FILE=certs/client.crt
# STT_GRPC_TLS_KEY_FILE=certs/client.key
# SNI/authority override (LB 사용시 SAN 불일치 해결)
# STT_GRPC_TLS_OVERRIDE_AUTHORITY=stt.example.com
# Keepalive ping 간격(ms)
# STT_GRPC_KEEPALIVE_MS=20000

# TraceContext (분산 추적 W3C)
# 예: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
TRACEPARENT=

# Bench 스크립트 사용 시 세션/시간 등은 명령행 인자로 조절
# 예: npx ts-node scripts/grpc_bench.ts --sessions=8 --seconds=15

EOF
```

### 1.3 소스 가져오기와 이미지 빌드

```bash
# 1) 레포 클론 또는 업데이트
git clone --depth 1 https://github.com/i4way-hong/i4way-Audio-Hook-Server.git /opt/audiohook/src
git remote remove origin  #원격저장소 삭제

# 2) 빌드 컨텍스트로 이동
cd /opt/audiohook/src

# 4) 이미지 빌드
docker build -t audiohook:1.0.0 -t audiohook:latest .
```

### 1.4 단일 컨테이너 실행
```bash
docker run -d \
  --name audiohook \
  --restart unless-stopped \
  --env-file /opt/audiohook/configs/.env \
  -p 3000:3000 \
  -v /opt/audiohook/logs:/app/logs \
  -v /opt/audiohook/recordings:/app/recordings \
  audiohook:latest

# SELinux 이슈 시 :Z 옵션
# -v /opt/audiohook/logs:/app/logs:Z -v /opt/audiohook/recordings:/app/recordings:Z

# 방화벽
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload

# 상태 확인
docker ps -a
docker logs -f audiohook
curl -s http://localhost:3000/health

# 컨테이너 중지  
docker stop audiohook
# 컨테이너 완전제거(중지 + 삭제)
docker rm audiohook

# 컨테이너 강제중지 + 삭제
docker rm -f audiohook
```


### 1.5 Docker Compose로 실행(여러 개의 Docker 컨테이너를 하나의 서비스처럼 묶어서 쉽게 관리하는 도구)
- 시작 path
````bash
cd /opt/audiohook/compose
````
- 해당 위치에 아래 yaml 3개 생성
### 1.5.1 compose.yaml
````bash
services:
  app:
    image: audiohook:latest
    restart: unless-stopped
    env_file:
      - /opt/audiohook/configs/.env
    environment:
      NODE_ENV: production
      SERVERHOST: "0.0.0.0"
      SERVERPORT: "3000"
#    ports:
#      - "3000:3000"
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings
````

### 1.5.2 compose.app2.yaml
````bash
services:
  app2:
    image: audiohook:latest
    restart: unless-stopped
    env_file:
      - /opt/audiohook/configs/.env
    environment:
      NODE_ENV: production
      SERVERHOST: "0.0.0.0"
      SERVERPORT: "3000"
#    ports:
#      - "3001:3000"
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings
````

### 1.5.3 compose.lb.yaml
````bash
services:
  app:
    ports: []          # 호스트 포트 바인딩 제거
    expose: ["3000"]
  app2:
    ports: []
    expose: ["3000"]

  lb:
    image: nginx:1.27-alpine
    container_name: audiohook-lb
    depends_on: [app,app2]
    ports:
      - "3000:3000"    # 외부 진입점
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    restart: unless-stopped
````

### 1.5.4 nginx.conf
````bash
worker_processes  1;
events { worker_connections 1024; }

http {
  upstream app_pool {
    server app:3000;
    server app2:3000;
    # ip_hash;  # 세션 고정이 필요하면 주석 해제
  }

  map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 3000;

    # Host 헤더를 원본 그대로(포트 포함) 전달
    proxy_set_header Host $http_host;                 # ← 변경: $host → $http_host
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Port $server_port;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_http_version 1.1;

    proxy_read_timeout 1d;
    proxy_send_timeout 1d;

    location / {
      proxy_pass http://app_pool;
    }
  }
}
````

### 1.5.5 명령어

- 컨테이너 생성 및 기동
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml up -d
````

- 컨테이너 종료 및 정리(컨테이너/네트워크 제거)
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml down
````

- 컨테이너 시작
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml start
````

- 특정 컨테이너만 시작
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml start app
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml start app2
````

- 실행만 중지(컨테이너 남김, 곧바로 재시작 가능)
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml stop
````

- 특정 서비스만 중지/삭제(예: app2만)
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml stop app2
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml rm -f app2
````

- 스케일을 줄여 1개만 유지
````bash
docker compose up -d --scale app=1
````

- 볼륨까지 함께 삭제하려면
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml down --volumes
````

상태 확인:
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml ps
````

// ...existing code...

- 로그 보기(전체 서비스)
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml logs -f
````

-  특정 서비스(app/app2)만
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml logs -f app
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml logs -f app2
````

- 최근 N줄만(스트리밍 없이)
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml logs --tail=200 app
````

- 타임스탬프/기간 지정
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml logs -f --timestamps --since="10m" app
````

- 스케일링된 개별 컨테이너만(이름 확인 후)
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml ps
docker logs -f compose-app-2
````

- 에러만 필터
````bash
docker compose -f compose.yaml -f compose.app2.yaml -f compose.lb.yaml logs -f app | grep -i error