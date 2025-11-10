# AudioHook 배포 가이드

AudioHook을 운영 환경에 배포하기 위한 대표 시나리오(리눅스 이중화, Docker, AWS Fargate+S3)를 정리했습니다. 모든 방식은 WebSocket 업그레이드 유지와 녹취 파일/로그 보존 정책을 사전에 검토해야 합니다.

---

# AudioHook 배포 가이드

본 문서는 두 가지 운영 시나리오에 맞춰 AudioHook 배포 절차를 정리합니다.
- 리눅스 2노드 + 로드밸런싱(물리/VM 운영)
- Docker 기반 배포( Rocky Linux 9.5: Docker 설치 → 앱 컨테이너 실행 → Compose 확장 → 역프록시(Nginx) → 운영/보안 → 검증/문제 해결 → 멀티 컨테이너/로드밸런싱 )

사전 전제: WebSocket 업그레이드(101 Switching Protocols) 유지, 녹취/로그 보존 정책, TLS 및 방화벽 정책을 사전에 확정합니다.

---

## 1. 공통 준비 사항

- 런타임/도구: Node.js 22.x, npm 10.x 이상, Git
- 비밀/환경변수: `.env`(또는 Vault/Secrets Manager)로 자격 증명 관리
- 저장소: 로그/녹취 저장 위치(로컬/NFS/S3 등) 결정
- 모니터링: 로그 수집기(ELK/OpenSearch), Metrics(Prometheus 등) 구성

---

## 2. 리눅스 2노드 + 로드밸런싱(시스템 서비스 운영)

### 2.1 구성 예시

| 역할 | 호스트 | 설명 |
|------|--------|------|
| app01 | 172.16.10.11 | AudioHook 인스턴스 |
| app02 | 172.16.10.12 | AudioHook 인스턴스 |
| lb01  | 172.16.10.10 | Nginx/HAProxy, TLS 종료 및 WebSocket 프록시 |
| 스토리지 | NFS/S3 | 녹취 공유 필요 시 |

### 2.2 애플리케이션 설치(각 앱 노드)

```bash
sudo useradd --system --home /opt/audiohook --shell /bin/bash audiohook
sudo mkdir -p /opt/audiohook && sudo chown audiohook:audiohook /opt/audiohook
sudo -u audiohook git clone https://<repo>/audiohook.git /opt/audiohook/src
cd /opt/audiohook/src/app
sudo -u audiohook cp .env.example .env   # 환경 변수 편집
sudo -u audiohook npm ci --omit=dev
sudo -u audiohook npm run build
```

### 2.3 systemd 서비스(각 앱 노드)

```bash
sudo tee /etc/systemd/system/audiohook.service <<'EOF'
[Unit]
Description=AudioHook Service
After=network.target

[Service]
User=audiohook
WorkingDirectory=/opt/audiohook/src/app
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now audiohook
```

### 2.4 Nginx 로드밸런서(lb01)

```nginx
upstream audiohook_upstream {
    ip_hash;                         # 세션 고정 필요 시
    server 172.16.10.11:3000;
    server 172.16.10.12:3000;
}

map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 443 ssl;
    server_name audiohook.example.com;

    ssl_certificate     /etc/nginx/ssl/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/privkey.pem;

    location / {
        proxy_pass http://audiohook_upstream;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
    }

    location /health {
        proxy_pass http://audiohook_upstream/health;
    }
}
```

### 2.5 헬스체크/모니터링

- `/health` 200 OK 확인(로드밸런서 타겟)
- 로그 중앙 수집 및 대시보드(예: ELK/OpenSearch)
- 장애 시나리오: app01 중지 후 세션 지속성 확인

---

## 3. Docker 기반 배포( Rocky Linux 9.5 )

Rocky Linux 9.5에서 Docker 설치부터 단일 실행/Compose/역프록시/운영 및 멀티 컨테이너까지 한 번에 정리합니다. SELinux Enforcing, firewalld 활성화를 기본 가정합니다.

### 3.1 Docker 설치

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

### 3.2 디렉터리와 SELinux

```bash
sudo mkdir -p /opt/audiohook/{logs,recordings,configs,src,compose}
sudo chown -R $USER:$USER /opt/audiohook

# SELinux: 컨테이너 쓰기 가능 라벨
sudo chcon -Rt svirt_sandbox_file_t /opt/audiohook
```

환경 변수 예시(`/opt/audiohook/configs/.env`):

```bash
cat > /opt/audiohook/configs/.env << 'EOF'
NODE_ENV=production
SERVERHOST=0.0.0.0
SERVERPORT=3000
LOG_LEVEL=info

# STT 설정 (프로토콜 선택)
# STT_PROTOCOL=websocket  # websocket | tcp | grpc | mrcp
# STT_ENDPOINT=ws://stt.example.com:8080/stt
# STT_ENCODING=L16
# STT_RATE=8000
# STT_MONO=true

# (선택) gRPC 사용 시 Forwarder 추가 변수
# STT_PROTOCOL=grpc
# STT_ENDPOINT=host:55051              # gRPC 대상 호스트:포트
# STT_GRPC_AUTH_TOKEN=                 # 필요 시 인증 토큰
# STT_GRPC_RECONNECT_ENABLED=true
# STT_GRPC_RECONNECT_INITIAL_MS=1000
# STT_GRPC_RECONNECT_MAX_MS=15000
# STT_GRPC_RECONNECT_FACTOR=2.0
# STT_GRPC_RECONNECT_JITTER=0.3
# STT_GRPC_TLS_ENABLED=true            # TLS/mTLS 필요 시
# STT_GRPC_TLS_CA_FILE=/certs/ca.pem
# STT_GRPC_TLS_CERT_FILE=/certs/client.crt
# STT_GRPC_TLS_KEY_FILE=/certs/client.key
# STT_GRPC_TLS_OVERRIDE_AUTHORITY=stt.internal
# STT_GRPC_KEEPALIVE_MS=20000

# 연동(필요 시)
CONVERSATION_LOOKUP_URL=
CONVERSATION_LOOKUP_TOKEN=

# 녹취 저장소: local | s3
RECORDING_STORAGE=local
S3_BUCKET=
S3_PREFIX=sessions/

# 자격 증명(필요 시)
# API_KEY=
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
# AWS_REGION=
EOF
```
    ports:
참고: 레포 내 `configs/examples/*.env.example` 템플릿을 시작점으로 사용할 수 있습니다.

### 3.3 소스 가져오기와 이미지 빌드

```bash
# 1) 레포 클론 또는 업데이트
git clone https://github.com/i4way-hong/i4way-Audio-Hook-Server.git /opt/audiohook/src || true
cd /opt/audiohook/src
git pull --rebase || true

# 2) 빌드 컨텍스트로 이동
#   - 리포 루트에 Dockerfile이 있는 경우: /opt/audiohook/src
#   - app/ 하위에 Dockerfile이 있는 경우: /opt/audiohook/src/app
if [ -f /opt/audiohook/src/Dockerfile ]; then cd /opt/audiohook/src; else cd /opt/audiohook/src/app; fi

# 3) (선택) 런타임 .env를 빌드 컨텍스트에 함께 보관하고 싶다면 복사
cp -f /opt/audiohook/configs/.env ./.env 2>/dev/null || true

# 4) 이미지 빌드(태그 정책은 운영 표준에 맞게)
docker build -t audiohook:latest .
# docker build -t audiohook:1.0.0 -t audiohook:latest .

# 5) (선택) 레지스트리 푸시
# docker tag audiohook:latest registry.example.com/audiohook:latest
# docker push registry.example.com/audiohook:latest
```

### 3.4 단일 컨테이너 실행(docker run)

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
docker logs -f audiohook
curl -s http://localhost:3000/health
```

### 3.5 Docker Compose(앱 단독)

```yaml
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
    ports:
      - "3000:3000"
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings
```

실행/업데이트:

```bash
docker compose up -d
docker compose ps
docker compose logs -f app

# 롤링 업데이트(레지스트리 사용 시)
docker compose pull app
docker compose up -d app

# 단일 호스트 스케일(주의: 동일 포트 바인딩 불가)
# docker compose up -d --scale app=2
```

### 3.6 Nginx 역프록시(웹소켓)

configs/nginx.conf:

```nginx
worker_processes auto;
events { worker_connections 1024; }

http {
  map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
  }

  upstream audiohook_upstream {
    server app:3000;
    keepalive 32;
  }

  server {
    listen 80;
    # listen 443 ssl;  # TLS 사용 시

    location / {
      proxy_pass http://audiohook_upstream;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_set_header Host $host;
      proxy_read_timeout 180s;
      proxy_send_timeout 180s;
    }

    location /health { proxy_pass http://audiohook_upstream/health; }
  }
}
```

Compose(프록시 포함):

```yaml
services:
  app:
    image: audiohook:latest
    restart: unless-stopped
    env_file: [ /opt/audiohook/configs/.env ]
    environment:
      NODE_ENV: production
      PORT: "3000"
    expose: [ "3000" ]
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings

  proxy:
    image: nginx:1.25
    restart: unless-stopped
    ports:
      - "80:80"
      # - "443:443"  # TLS 사용 시
    volumes:
      - ./configs/nginx.conf:/etc/nginx/nginx.conf:ro
      # - /opt/audiohook/ssl:/etc/nginx/ssl:ro
    depends_on: [ app ]
```

방화벽:

```bash
sudo firewall-cmd --permanent --add-service=http
# sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

메모: 동일 호스트에서 app 복제본을 여러 개 띄울 경우 외부 포트 충돌이 나므로, 외부는 프록시 80/443만 노출하고 내부 네트워크로 라우팅하세요.

### 3.7 운영/보안 체크리스트

- 비밀/환경: `.env` 필수값 검토, 비밀은 외부 보관소 활용 권장
- SELinux: `chcon -Rt svirt_sandbox_file_t /opt/audiohook` 또는 볼륨 `:Z`
- 방화벽: 프록시 80/443 또는 직접 노출 시 3000/tcp
- 로그/모니터링: `docker compose logs -f app` + 파일 수집; Prometheus/OpenSearch 연계
- 재시작 정책: `--restart unless-stopped` 또는 Compose `restart`
- 웹소켓 타임아웃: `proxy_read_timeout`, `proxy_send_timeout` 충분히 크게(예: 180s)
- TLS: 운영은 HTTPS 권장(ACME/파일 인증서)

### 3.8 검증(스모크 테스트)

```bash
docker compose ps
docker compose logs -f app
curl -i http://localhost:3000/health
# 프록시 뒤에서 테스트
echo "http://<SERVER_IP_OR_DOMAIN>/health"; curl -i http://<SERVER_IP_OR_DOMAIN>/health
```

성공 기준: `/health` 200 OK, 웹소켓은 클라이언트로 101 업그레이드 확인.

### 3.9 문제 해결(자주 만남)

- 권한/EPERM: SELinux 라벨 누락 가능 → `chcon -Rt svirt_sandbox_file_t /opt/audiohook` 또는 볼륨 `:Z`
- 포트 바인딩 실패: 다른 프로세스 점유 → `sudo ss -lntp | grep :3000`
- 컨테이너 즉시 종료: `docker logs <name>`로 오류 확인, `.env` 필수값 점검
- 다중 인스턴스 트래픽: 프록시/로드밸런서 구성 필요(Nginx upstream/외부 L7)
- S3 실패: 자격 증명/IAM/네트워크(e.g., egress) 확인

### 3.10 멀티 컨테이너와 로드밸런싱

여러 컨테이너를 자동 감지/분산하려면 Traefik이 단순하고 견고합니다. Nginx 수동 upstream이나 Docker Swarm도 선택지입니다.

#### 3.10.1 Compose + Traefik(권장)

`compose-traefik.yaml`(요지):

```yaml
services:
  app:
    image: audiohook:latest
    restart: unless-stopped
    env_file: [ /opt/audiohook/configs/.env ]
    expose: [ "3000" ]
    labels:
      - traefik.enable=true
      # 도메인 보유 시 Host 규칙 권장
      # - traefik.http.routers.audiohook.rule=Host(`audiohook.example.com`)
      - traefik.http.routers.audiohook.rule=PathPrefix(`/`)
      - traefik.http.routers.audiohook.entrypoints=web
      - traefik.http.services.audiohook.loadbalancer.server.port=3000
      # - traefik.http.services.audiohook.loadbalancer.sticky.cookie=true
    networks: [ web ]

  traefik:
    image: traefik:v3.1
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      # TLS(선택)
      # - --entrypoints.websecure.address=:443
      # - --certificatesresolvers.le.acme.tlschallenge=true
      # - --certificatesresolvers.le.acme.email=admin@example.com
      # - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
    ports: [ "80:80" ]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      # - /opt/audiohook/letsencrypt:/letsencrypt
    networks: [ web ]

networks:
  web: { driver: bridge }
```

실행/스케일:

```bash
docker compose -f /opt/audiohook/compose/compose-traefik.yaml up -d
docker compose -f /opt/audiohook/compose/compose-traefik.yaml up -d --scale app=4
docker compose -f /opt/audiohook/compose/compose-traefik.yaml ps
```

메모:
- 도메인이 있다면 Host(`audiohook.example.com`) 규칙 사용 권장
- WebSocket 업그레이드는 Traefik이 자동 처리
- sticky 세션이 필요하면 cookie 기반 sticky 활성화

리소스 제한(일반 Compose):

```yaml
services:
  app:
    image: audiohook:latest
    cpus: 1.0
    mem_limit: 1g
    cpuset: "0-1"
```

#### 3.10.2 Docker Swarm(VIP 기반 LB)

```bash
docker swarm init
docker stack deploy -c /opt/audiohook/compose/compose-swarm.yaml audiohook
docker service ls
docker service ps audiohook_app
```

compose-swarm.yaml(핵심):

```yaml
services:
  app:
    image: audiohook:latest
    env_file: [ /opt/audiohook/configs/.env ]
    deploy:
      replicas: 4
      restart_policy: { condition: any }
      resources:
        limits: { cpus: "1.0", memory: 1G }
        reservations: { cpus: "0.50", memory: 512M }
    networks: [ web ]

  proxy:
    image: nginx:1.25
    ports: [ "80:80" ]
    depends_on: [ app ]
    networks: [ web ]

networks:
  web: { driver: overlay }
```

확장/축소: `docker service scale audiohook_app=6`

메모: Swarm의 진가는 다중 노드에서 발휘되며 `deploy.*`를 정식 지원합니다.

#### 3.10.3 CPU 코어 활용 가이드

- Node.js 프로세스는 주로 단일 코어를 사용 → 컨테이너 수를 늘려 코어 병렬 활용
- 균등 분배: 컨테이너당 `cpus: 1.0` 지정 후 replicas 조정
- 특정 코어 핀닝: `cpuset: "0-3"`
- Swarm: `deploy.resources` 권장, 일반 Compose: `cpus/mem_limit/cpuset` 사용

### 3.11 빠른 실행 요약

```bash
# 1) Docker 설치(3.1)
# 2) .env 작성(3.2)
# 3) 빌드(3.3)
cd /opt/audiohook/src/app && docker build -t audiohook:latest .
# 4) 단일 실행(3.4)
docker run -d --name audiohook --restart unless-stopped \
  --env-file /opt/audiohook/configs/.env -p 3000:3000 \
  -v /opt/audiohook/logs:/app/logs -v /opt/audiohook/recordings:/app/recordings audiohook:latest
# (gRPC 사용 시 예시 .env 추가 항목 참고: STT_PROTOCOL=grpc 와 STT_GRPC_* 변수들)
# 5) Compose(3.5) 또는 Traefik(3.10.1)
```

---

문의/이슈: 운영 중 문제나 개선 요청은 레포 이슈로 남겨주세요.
      - "${HOST_PORT_APP2:-3002}:3000"
```

실행 시(변수 치환용 파일 지정):

```bash
docker compose --env-file /opt/audiohook/configs/deploy.env up -d
```

주의사항:
- env_file은 “컨테이너 내부 앱 환경”에 적용됩니다. Compose 자체의 변수 치환은 `--env-file` 또는 compose.yaml 옆 `.env`를 사용합니다.
- 한 서비스에서 replicas를 늘리면 복제본은 동일 env를 공유합니다. 복제본마다 다른 설정이 필요하면 서비스를 나누세요(`app1`, `app2` 등).

#### 8.3.1 파일 저장 위치와 실행 명령(프록시 사용 시 권장)

- 권장 경로: `/opt/audiohook/compose/compose-traefik.yaml`
- 이유: 소스와 운영 구성을 분리하고, 절대경로 env_file을 사용해 어디서 실행해도 안정적으로 동작

최소 요구사항(사전 체크):
- 이미지 준비: `audiohook:latest`(로컬 빌드 또는 레지스트리 pull 가능)
- 환경파일: `/opt/audiohook/configs/base.env` (+ 필요 시 `container1.env`, `container2.env`)
- 방화벽: 80(필요 시 443) 허용, SELinux는 로그/녹취 볼륨에 라벨 혹은 `:Z/:z` 사용(6.2 참고)

실행 명령(최초 기동):

```bash
docker compose -f /opt/audiohook/compose/compose-traefik.yaml up -d
```

스케일(단일 서비스 스케일 패턴일 때):

```bash
docker compose -f /opt/audiohook/compose/compose-traefik.yaml up -d --scale app=4
```

상태/로그 확인:

```bash
docker compose -f /opt/audiohook/compose/compose-traefik.yaml ps
docker compose -f /opt/audiohook/compose/compose-traefik.yaml logs -f app
docker compose -f /opt/audiohook/compose/compose-traefik.yaml logs -f traefik
```

헬스 체크:

```bash
curl -i http://<서버IP 또는 도메인>/health
```

#### 8.3.2 Traefik 프록시용 compose 예시

옵션 A) 컨테이너별 .env(app1/app2) + Traefik

```yaml
services:
  app1:
    image: audiohook:latest
    restart: unless-stopped
    env_file:
      - /opt/audiohook/configs/base.env
      - /opt/audiohook/configs/container1.env
    expose:
      - "3000"
    labels:
      - traefik.enable=true
      - traefik.http.routers.app1.rule=PathPrefix(`/`)
      - traefik.http.routers.app1.entrypoints=web
      - traefik.http.services.app1.loadbalancer.server.port=3000
      # - traefik.http.services.app1.loadbalancer.sticky.cookie=true
    networks: [web]

  app2:
    image: audiohook:latest
    restart: unless-stopped
    env_file:
      - /opt/audiohook/configs/base.env
      - /opt/audiohook/configs/container2.env
    expose:
      - "3000"
    labels:
      - traefik.enable=true
      - traefik.http.routers.app2.rule=PathPrefix(`/`)
      - traefik.http.routers.app2.entrypoints=web
      - traefik.http.services.app2.loadbalancer.server.port=3000
      # - traefik.http.services.app2.loadbalancer.sticky.cookie=true
    networks: [web]

  traefik:
    image: traefik:v3.1
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      # TLS 사용 시 websecure 추가 및 인증서 설정
    ports:
      - "80:80"
      # - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [web]

networks:
  web:
    driver: bridge
```

옵션 B) 단일 서비스(app) 스케일 + Traefik(더 단순)

```yaml
services:
  app:
    image: audiohook:latest
    restart: unless-stopped
    env_file:
      - /opt/audiohook/configs/base.env
    expose:
      - "3000"
    labels:
      - traefik.enable=true
      - traefik.http.routers.audiohook.rule=PathPrefix(`/`)
      - traefik.http.routers.audiohook.entrypoints=web
      - traefik.http.services.audiohook.loadbalancer.server.port=3000
      # - traefik.http.services.audiohook.loadbalancer.sticky.cookie=true
    networks: [web]

  traefik:
    image: traefik:v3.1
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
    ports:
      - "80:80"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [web]

networks:
  web:
    driver: bridge
```

메모:
- 도메인이 있으면 Host 규칙 사용 권장: `traefik.http.routers.audiohook.rule=Host(\`audiohook.example.com\`)`
- TLS 필요 시 443 포트와 `entrypoints.websecure`를 추가하고 인증서(ACME/파일)를 설정하세요.