# AudioHook 배포 가이드

AudioHook을 운영 환경에 배포하기 위한 대표 시나리오(리눅스 이중화, Docker, AWS Fargate+S3)를 정리했습니다. 모든 방식은 WebSocket 업그레이드 유지와 녹취 파일/로그 보존 정책을 사전에 검토해야 합니다.

---

## 1. 공통 준비 사항

- **런타임**: Node.js 22.x, npm 10.x 이상, Git
- **환경 변수**: `.env.example`를 복사해 서비스별 값 설정 (`CONVERSATION_LOOKUP_*`, STT 자격 증명 등)
- **보안**: TLS 인증서, 방화벽 규칙, API 키 저장소(Secrets Manager, Vault 등)
- **저장소**: 로컬 디스크/NFS/S3 등 녹취 파일 보존 위치 확정
- **모니터링**: Prometheus/CloudWatch, 로그 수집기(ELK, OpenSearch 등) 준비

---

## 2. 리눅스 2노드 + 로드밸런싱

### 2.1 구성 예시

| 역할 | 호스트 | 설명 |
|------|--------|------|
| app01 | 172.16.10.11 | AudioHook 인스턴스 |
| app02 | 172.16.10.12 | AudioHook 인스턴스 |
| lb01  | 172.16.10.10 | Nginx/HAProxy, TLS 종료 및 WebSocket 프록시 |
| 스토리지 | NFS/S3 | 녹취 파일 공유 필요 시 사용 |

### 2.2 애플리케이션 설치 (각 앱 노드)

```bash
sudo useradd --system --home /opt/audiohook --shell /bin/bash audiohook
sudo mkdir -p /opt/audiohook && sudo chown audiohook:audiohook /opt/audiohook
sudo -u audiohook git clone https://<repo>/audiohook.git /opt/audiohook/src
cd /opt/audiohook/src/app
sudo -u audiohook cp .env.example .env   # 환경 변수 편집
sudo -u audiohook npm ci --omit=dev
sudo -u audiohook npm run build
```

### 2.3 systemd 서비스

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

### 2.4 Nginx 로드밸런서 예시

```nginx
upstream audiohook_upstream {
    ip_hash;                         # 세션 스티키 필요 시
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

### 2.5 헬스체크 및 관측

- `/health` 응답 코드 확인(로드밸런서 헬스 타겟)
- Prometheus `/metrics` 노출 시 스크래핑 구성
- 중앙 로그 수집(Fluent Bit → Elasticsearch 등)
- failover 테스트: app01 중지 후 세션 유지 확인

---

## 3. Docker 기반 배포

### 3.1 이미지 빌드 및 태깅

```bash
docker build -t audiohook:latest .
docker tag audiohook:latest registry.example.com/audiohook:latest
docker push registry.example.com/audiohook:latest
```

### 3.2 Docker Compose (2 인스턴스 + Nginx)

```yaml
services:
  app:
    image: registry.example.com/audiohook:latest
    restart: unless-stopped
    env_file: ./.env
    environment:
      NODE_ENV: production
      PORT: 3000
    deploy:
      replicas: 2
    expose:
      - "3000"
  proxy:
    image: nginx:1.25
    ports:
      - "3000:80"
    volumes:
      - ./configs/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - app
```

```bash
docker compose up -d
```

### 3.3 롤링 업데이트

```bash
docker compose pull app
docker compose up -d --no-deps app
```

---

## 4. AWS Fargate + S3

### 4.1 아키텍처 개요

- **ECS 서비스** (Fargate) + **ALB** (WebSocket 지원, Idle timeout 충분히 설정)
- **S3**: `RECORDING_STORAGE=s3` 설정, 녹취 저장소로 사용
- **Secrets Manager/SSM**: API Key, STT 자격 증명 저장
- **CloudWatch Logs**, **Amazon Managed Prometheus/Grafana**(선택)

### 4.2 Task Definition 핵심

```json
{
  "family": "audiohook",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "networkMode": "awsvpc",
  "containerDefinitions": [
    {
      "name": "audiohook",
      "image": "<account>.dkr.ecr.ap-northeast-2.amazonaws.com/audiohook:latest",
      "portMappings": [{ "containerPort": 3000 }],
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "PORT", "value": "3000" },
        { "name": "RECORDING_STORAGE", "value": "s3" },
        { "name": "S3_BUCKET", "value": "audiohook-recordings" },
        { "name": "S3_PREFIX", "value": "sessions/" }
      ],
      "secrets": [
        { "name": "API_KEY", "valueFrom": "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:audiohook/api-key" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/audiohook",
          "awslogs-region": "ap-northeast-2",
          "awslogs-stream-prefix": "service"
        }
      }
    }
  ]
}
```

### 4.3 S3 권한 (Task Role IAM Policy)

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:PutObject",
    "s3:GetObject",
    "s3:DeleteObject"
  ],
  "Resource": "arn:aws:s3:::audiohook-recordings/*"
}
```

### 4.4 ALB 설정

- Listener: 443 (TLS) → Target group: HTTP 1.1, port 3000
- Idle timeout: 최소 120초
- 헬스체크: `/health` (200 OK)

### 4.5 CI/CD 파이프라인

1. GitHub Actions 또는 CodeBuild로 Docker 이미지 빌드 → ECR 업로드
2. `aws ecs update-service --cluster audiohook --service audiohook --force-new-deployment`
3. CloudWatch Alarm, SNS로 오류 알림
4. IaC(Terraform, CDK)로 인프라 관리 권장

---

## 5. 운영 체크리스트


---

## 6. Rocky Linux 9.5 + Docker 배포(전체 절차)

Rocky Linux 9.5 환경에서 Docker 설치부터 앱 컨테이너 실행, Compose 확장, 역프록시(Nginx), 운영/보안 설정, 검증/문제 해결까지 한 번에 정리했습니다. SELinux Enforcing와 firewalld 활성화를 기본 가정합니다.

### 6.1 Docker 설치

- 기존 Docker 제거 → 공식 리포지토리 등록 → Docker Engine/CLI/Buildx/Compose 설치 → 서비스 활성화 → 사용자 그룹 추가

```bash
# 1) 과거 버전 제거(설치되어 있다면)
sudo dnf remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine

# 2) 플러그인 설치
sudo dnf -y install dnf-plugins-core

# 3) Docker 공식 저장소 등록(CentOS/RHEL 계열)
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo

# 4) Docker Engine + Buildx + Compose 플러그인 설치
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 5) 서비스 활성화 및 기동
sudo systemctl enable --now docker

# 6) 현재 사용자 docker 그룹 추가(재로그인 필요)
sudo usermod -aG docker $USER
# 즉시 반영: 현재 세션에서만
newgrp docker

# 7) 확인
docker version
docker compose version
docker info
```

### 6.2 디렉터리와 환경 변수 준비

영속 볼륨(로그/녹취)과 환경파일을 준비합니다. SELinux Enforcing 환경에서는 컨텍스트 지정이 중요합니다.

```bash
sudo mkdir -p /opt/audiohook/{logs,recordings,configs}
sudo chown -R $USER:$USER /opt/audiohook

# SELinux 컨텍스트(컨테이너가 읽기/쓰기 가능하도록)
sudo chcon -Rt svirt_sandbox_file_t /opt/audiohook
```

환경 변수 파일 예시(`/opt/audiohook/configs/.env`):

```bash
cat > /opt/audiohook/configs/.env << 'EOF'
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# 서비스 연동 값(필요 시 설정)
CONVERSATION_LOOKUP_URL=
CONVERSATION_LOOKUP_TOKEN=

# 녹취 저장소: local | s3
RECORDING_STORAGE=local

# S3 사용 시(선택)
S3_BUCKET=
S3_PREFIX=sessions/

# 자격 증명/비밀 값(필요 시)
# API_KEY=
# STT_*= 
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
# AWS_REGION=
EOF
```

### 6.3 소스 가져오기와 이미지 빌드

레포를 서버로 가져와 이미지를 빌드합니다. 레포 루트의 `Dockerfile`을 사용합니다.

```bash
cd /opt
git clone <your-repo-url> audiohook
cd audiohook/app

# 준비한 .env 배치(경로 확인)
cp /opt/audiohook/configs/.env ./.env

# 이미지 빌드
docker build -t audiohook:latest .

# (선택) 레지스트리에 태그/푸시
# docker tag audiohook:latest registry.example.com/audiohook:latest
# docker push registry.example.com/audiohook:latest
```

# 아래와 같이 .env 파일을 공용파일과 컨테이너별로 분리해 사용할 수도 있음.
services:
  app1:
    image: audiohook:latest
    restart: unless-stopped
    env_file:
      - /opt/audiohook/configs/base.env
      - /opt/audiohook/configs/container1/.env   # app1 전용
    environment:
      PORT: "3000"             # 앱 내부 포트(변경 없다면 base.env로)
    ports:
      - "3001:3000"            # 호스트 3001 -> 컨테이너 3000
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings

  app2:
    image: audiohook:latest
    restart: unless-stopped
    env_file:
      - /opt/audiohook/configs/base.env
      - /opt/audiohook/configs/container2/.env   # app2 전용
    environment:
      PORT: "3000"
    ports:
      - "3002:3000"            # 호스트 3002 -> 컨테이너 3000
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings


### 6.4 단일 컨테이너 실행(docker run)

로그/녹취 디렉터리를 호스트에 영속화하고 포트 3000을 노출합니다.

```bash
docker run -d \
  --name audiohook \
  --restart unless-stopped \
  --env-file /opt/audiohook/configs/.env \
  -p 3000:3000 \
  -v /opt/audiohook/logs:/app/logs \
  -v /opt/audiohook/recordings:/app/recordings \
  audiohook:latest

# SELinux 권한 오류 시 :Z 옵션 활용
# -v /opt/audiohook/logs:/app/logs:Z -v /opt/audiohook/recordings:/app/recordings:Z

# 방화벽 허용
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload

# 상태 확인
docker logs -f audiohook
curl -s http://localhost:3000/health
```

### 6.5 Docker Compose(v2) 구성

파일 기반으로 실행을 관리합니다. 아래는 앱만 포함한 기본 예시입니다.

```yaml
services:
  app:
    image: audiohook:latest
    # 또는: registry.example.com/audiohook:latest
    restart: unless-stopped
    env_file:
      - /opt/audiohook/configs/.env
    environment:
      NODE_ENV: production
      PORT: "3000"
    ports:
      - "3000:3000"
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings
    # 이미지 내부에 curl/wget이 있을 때만 healthcheck 사용 권장
    # healthcheck:
    #   test: ["CMD-SHELL", "curl -fsS http://localhost:3000/health || exit 1"]
    #   interval: 30s
    #   timeout: 3s
    #   retries: 3
```

실행/업데이트:

```bash
docker compose up -d
docker compose ps
docker compose logs -f app

# 레지스트리 사용 시 롤링 업데이트
docker compose pull app
docker compose up -d app

# 단일 호스트에서 스케일(주의: 포트는 1개만 바인드 가능)
docker compose up -d --scale app=2
```

### 6.6 Nginx 역프록시(웹소켓)

웹소켓 업그레이드 헤더와 충분한 타임아웃을 설정합니다. 외부는 80/443 → 내부 app:3000으로 전달합니다.

`configs/nginx.conf` 예시:

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

    # TLS 사용 시 443 리스너와 인증서 설정 추가
    # listen 443 ssl;
    # ssl_certificate     /etc/nginx/ssl/fullchain.pem;
    # ssl_certificate_key /etc/nginx/ssl/privkey.pem;

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
}
```

Compose를 Nginx 포함으로 확장:

```yaml
services:
  app:
    image: audiohook:latest
    restart: unless-stopped
    env_file:
      - /opt/audiohook/configs/.env
    environment:
      NODE_ENV: production
      PORT: "3000"
    expose:
      - "3000"
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
    depends_on:
      - app
```

방화벽 허용:

```bash
sudo firewall-cmd --permanent --add-service=http
# sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

참고: 동일 호스트에서 app을 2개 이상 띄우면 포트 바인딩 충돌이 발생하므로, 외부 노출은 프록시 단일 포트(80/443)로 하고 내부 네트워크에서 app 컨테이너로 라우팅하는 구성이 일반적입니다. 다중 인스턴스 로드밸런싱은 외부 L7(예: ALB/HAProxy/Nginx upstream 다중 서버) 권장.

### 6.7 보안/운영 체크리스트

- 환경 변수/비밀 값: `.env`의 필수 항목(예: `LOG_LEVEL`, `CONVERSATION_LOOKUP_*`, STT 자격 증명) 확인. 비밀은 외부 보관소(Vault/Secrets Manager) 권장
- SELinux: 볼륨 대상에 `chcon -Rt svirt_sandbox_file_t /opt/audiohook` 또는 볼륨 옵션 `:Z` 사용
- 방화벽: 프록시 사용 시 80/443, 직접 노출 시 3000/tcp 개방
- 로그/모니터링: `docker compose logs -f app` 또는 파일 볼륨(`/app/logs`) 수집. Prometheus/ELK/OpenSearch 연계
- 재시작 정책: `--restart unless-stopped` 또는 Compose의 `restart: unless-stopped`
- 롤링 업데이트: `docker compose pull app; docker compose up -d app` 또는 로컬 빌드 후 동일 명령
- 웹소켓 타임아웃: 프록시의 `proxy_read_timeout`, `proxy_send_timeout` 충분히 크게(예: 180s+)
- TLS: 운영 환경에서는 HTTPS 권장(ACME/Certbot 또는 사설 PKI)

### 6.8 검증(스모크 테스트)

```bash
docker compose ps
docker compose logs -f app
curl -i http://localhost:3000/health
# 프록시 뒤라면
curl -i http://<서버IP 또는 도메인>/health
```

성공 기준: `200 OK` 응답, 웹소켓 경로는 `101 Switching Protocols` 동작(클라이언트 테스트로 확인).

### 6.9 문제 해결(빈출)

- 권한/파일 접근 오류(EPERM/Permission denied): SELinux 미설정 가능성 → `chcon -Rt svirt_sandbox_file_t /opt/audiohook` 또는 `:Z` 볼륨 옵션
- 포트 바인딩 실패: 다른 프로세스 점유 → `sudo ss -lntp | grep :3000` 확인 후 중지
- 컨테이너 즉시 종료: `docker logs <컨테이너>`로 Node 오류 확인, `.env` 필수 값 누락 여부 점검
- 다중 인스턴스 접속 문제: 프록시/로드밸런서 필요. Nginx upstream 다중 서버 또는 외부 L7 권장
- S3 업로드 실패: 자격 증명/버킷 권한/네트워크 확인(AWS_ACCESS_KEY_ID/SECRET, IAM Policy, VPC egress 등)

### 6.10 빠른 실행 요약

```bash
# 1) Docker 설치: 6.1 참고

# 2) .env 작성
vi /opt/audiohook/configs/.env

# 3) 빌드/실행(단일)
cd /opt/audiohook/app
docker build -t audiohook:latest .
docker run -d --name audiohook --restart unless-stopped \
  --env-file /opt/audiohook/configs/.env -p 3000:3000 \
  -v /opt/audiohook/logs:/app/logs \
  -v /opt/audiohook/recordings:/app/recordings audiohook:latest

# 4) Compose로 실행
docker compose up -d
docker compose logs -f app
```

## 7. 멀티 컨테이너와 로드밸런싱

여러 컨테이너로 확장(스케일링)하고, 트래픽을 균등 분배하는 대표 접근을 정리합니다. WebSocket 지원과 운영 자동화를 고려하면 Traefik을 사용하는 구성이 가장 단순하고 견고합니다.

### 7.1 옵션 비교 요약

- Compose + Nginx(수동 upstream): 간단하지만 컨테이너 수 변경 시 upstream 재설정/재배포 필요 → 운영성 낮음
- Compose + Traefik(Docker provider): 컨테이너 자동 감지, WebSocket 자동 지원, 스케일 변경 자동 반영 → 권장
- Docker Swarm: 서비스 VIP로 내장 LB 제공, `deploy.*`가 정식 동작 → 다중 노드 확장에 유리
- 외부 L7 LB(ALB/HAProxy 등): 가장 확장성/가시성 좋음(인프라 구성 추가 필요)

### 7.2 Compose + Traefik 예시(권장)

Traefik이 Docker 이벤트로 컨테이너를 자동 발견하여 라우팅/로드밸런싱합니다. WebSocket 업그레이드는 기본 지원합니다.

`compose-traefik.yaml` 예시:

```yaml
services:
  app:
    image: audiohook:latest
    restart: unless-stopped
    env_file:
      - /opt/audiohook/configs/.env
    expose:
      - "3000"           # 내부 라우팅용, 외부 포트 바인딩은 Traefik이 담당
    labels:
      - traefik.enable=true
      # 도메인이 있다면 Host 규칙 사용 권장
      # - traefik.http.routers.audiohook.rule=Host(`audiohook.example.com`)
      # 도메인 없이 포트로 받는 테스트라면 PathPrefix(`/`) 사용
      - traefik.http.routers.audiohook.rule=PathPrefix(`/`)
      - traefik.http.routers.audiohook.entrypoints=web
      - traefik.http.services.audiohook.loadbalancer.server.port=3000
      # 필요 시 세션 고정(웹소켓 세션 지속이 필요할 때)
      # - traefik.http.services.audiohook.loadbalancer.sticky.cookie=true
    networks:
      - web

  traefik:
    image: traefik:v3.1
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      # TLS 사용 시 활성화
      # - --entrypoints.websecure.address=:443
      # - --certificatesresolvers.le.acme.tlschallenge=true
      # - --certificatesresolvers.le.acme.email=admin@example.com
      # - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
    ports:
      - "80:80"
      # - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      # - /opt/audiohook/letsencrypt:/letsencrypt
    networks:
      - web

networks:
  web:
    driver: bridge
```

실행과 스케일링:

```bash
docker compose -f compose-traefik.yaml up -d
docker compose -f compose-traefik.yaml up -d --scale app=4
docker compose -f compose-traefik.yaml ps
```

메모:
- 도메인이 있다면 `Host(audiohook.example.com)` 규칙으로 라우팅하는 것이 권장입니다.
- WebSocket은 Traefik이 자동 처리합니다. 장기 연결이 많다면 `proxy.readTimeout` 등 고급 옵션(동적/정적 구성)을 고려하세요.
- 세션 고정이 필요한 경우 sticky cookie를 활성화합니다.

리소스 제한(일반 Compose):

```yaml
services:
  app:
    image: audiohook:latest
    # 컨테이너 단위 리소스 제한(Compose 일반 모드에서 동작)
    cpus: 1.0           # vCPU 1개 할당
    mem_limit: 1g       # 메모리 제한
    cpuset: "0-1"       # 특정 코어(0,1)에 핀닝(선택)
```

참고: `deploy.resources.*`는 Swarm에서 정식 동작합니다. 일반 Compose에서는 위와 같은 top-level `cpus`, `mem_limit`, `cpuset` 사용을 권장합니다(환경에 따라 지원 차이가 있을 수 있어 `docker compose config`로 유효성 확인 권장).

### 7.3 Docker Swarm 예시(VIP 기반 LB)

Swarm은 서비스 VIP를 통해 replicas에 자동 분산합니다. 다중 노드 확장과 표준화된 `deploy.*`를 활용할 수 있습니다.

배포 절차:

```bash
docker swarm init
docker stack deploy -c compose-swarm.yaml audiohook
docker service ls
docker service ps audiohook_app
```

`compose-swarm.yaml` 예시(스니펫):

```yaml
services:
  app:
    image: audiohook:latest
    env_file:
      - /opt/audiohook/configs/.env
    deploy:
      replicas: 4
      restart_policy:
        condition: any
      resources:
        limits:
          cpus: "1.0"
          memory: 1G
        reservations:
          cpus: "0.50"
          memory: 512M
    networks:
      - web

  proxy:
    image: nginx:1.25
    ports:
      - "80:80"
    depends_on:
      - app
    networks:
      - web
    # nginx.conf에서 proxy_pass http://app:3000; 로 VIP에 연결

networks:
  web:
    driver: overlay
```

확장/축소:

```bash
docker service scale audiohook_app=6
```

메모:
- Swarm의 강점은 다중 노드에서의 확장과 `deploy.*` 준수입니다. 단일 노드에서도 동작하지만, 진가는 클러스터에서 발휘됩니다.
- 프록시는 Swarm 서비스명(app) VIP로 연결하면 자동 분산됩니다.

### 7.4 CPU 코어 활용 가이드

- Node.js 프로세스는 이벤트 루프 특성상 단일 프로세스가 주로 하나의 코어를 활용합니다. 컨테이너 수를 늘려(=프로세스 수 증가) 여러 코어를 병렬 활용하는 것이 가장 단순하고 효과적입니다.
- 균등 분배를 원하면 컨테이너당 `cpus: 1.0` 정도로 할당하고, 시스템 총 코어 수에 맞춰 replicas를 조정하세요.
- 특정 코어로 고정이 필요하면 `cpuset: "0-3"`처럼 핀닝할 수 있습니다(핫패스 튜닝 시 유용).
- Swarm에서는 `deploy.resources.limits`로 일관되게 관리하고, 일반 Compose에서는 `cpus/mem_limit/cpuset`를 서비스에 직접 지정하세요.

---

## 8. 서비스별 .env 템플릿(예제 파일 포함)

레포에 예제 템플릿을 추가했습니다. 공통값은 `base.env.example`, 컨테이너별 차이는 `container1.env.example`, `container2.env.example`에 넣고, 배포 수준 변수 치환(호스트 포트 등)은 `deploy.env.example`로 관리합니다.

예제 파일 경로:
- `configs/examples/base.env.example`
- `configs/examples/container1.env.example`
- `configs/examples/container2.env.example`
- `configs/examples/deploy.env.example`

### 8.1 예제 내용

`base.env.example` (공통값)

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

CONVERSATION_LOOKUP_URL=
CONVERSATION_LOOKUP_TOKEN=

RECORDING_STORAGE=local

# S3 사용 시 주석 해제
# S3_BUCKET=audiohook-recordings
# S3_PREFIX=sessions/
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
# AWS_REGION=ap-northeast-2

# 외부 API/STT (선택)
# API_KEY=
# STT_VENDOR=
# STT_API_KEY=
```

`container1.env.example` (컨테이너1 전용 덮어쓰기)

```
INSTANCE_ID=app1
LOG_LEVEL=debug

# 선택: 컨테이너1만 S3 프리픽스 분리
# RECORDING_STORAGE=s3
# S3_BUCKET=audiohook-recordings
# S3_PREFIX=sessions/app1/
```

`container2.env.example` (컨테이너2 전용 덮어쓰기)

```
INSTANCE_ID=app2
LOG_LEVEL=info

# 선택: 컨테이너2만 S3 프리픽스 분리
# RECORDING_STORAGE=s3
# S3_BUCKET=audiohook-recordings
# S3_PREFIX=sessions/app2/
```

`deploy.env.example` (Compose 변수 치환용: 호스트 포트 등)

```
HOST_PORT_APP1=3001
HOST_PORT_APP2=3002
```

### 8.2 서버 적용 순서(권장 레이아웃)

서버에서는 `/opt/audiohook/configs/` 아래에 다음과 같이 배치하세요.

```
/opt/audiohook/configs/
  base.env
  container1.env
  container2.env
  deploy.env              # (선택) Compose 치환용
```

레포 예제를 복사하여 시작:

```bash
cp configs/examples/base.env.example       /opt/audiohook/configs/base.env
cp configs/examples/container1.env.example /opt/audiohook/configs/container1.env
cp configs/examples/container2.env.example /opt/audiohook/configs/container2.env
cp configs/examples/deploy.env.example     /opt/audiohook/configs/deploy.env   # 선택
```

필요 값(비밀 포함)을 채운 뒤 권한을 제한하세요.

```bash
chmod 600 /opt/audiohook/configs/*.env
```

### 8.3 Compose에서 사용 예시

- 프록시 사용(권장): 앱은 내부 포트만 노출하고 프록시가 80/443을 받습니다.

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

  app2:
    image: audiohook:latest
    restart: unless-stopped
    env_file:
      - /opt/audiohook/configs/base.env
      - /opt/audiohook/configs/container2.env
    expose:
      - "3000"

  # traefik/nginx는 80/443만 호스트에 바인딩
```

- 프록시 없이 컨테이너별 포트를 직접 바인딩해야 한다면, Compose 변수 치환용 `deploy.env`를 함께 사용하세요.

```yaml
services:
  app1:
    image: audiohook:latest
    restart: unless-stopped
    env_file:
      - /opt/audiohook/configs/base.env
      - /opt/audiohook/configs/container1.env
    ports:
      - "${HOST_PORT_APP1:-3001}:3000"

  app2:
    image: audiohook:latest
    restart: unless-stopped
    env_file:
      - /opt/audiohook/configs/base.env
      - /opt/audiohook/configs/container2.env
    ports:
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

- 권장 경로: `/opt/audiohook/ㅊ/compose-traefik.yaml`
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