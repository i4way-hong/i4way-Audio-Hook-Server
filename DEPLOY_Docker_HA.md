# Audiohook 2대 서버 + 4컨테이너 확장 + HA + HTTPS/WSS 구성 문서

이 문서는 기존 1대 서버 구성에서 **2대 서버로 확장**하면서, **총 8개 컨테이너 운영**, **HA(Nginx 외부 LB)**, **HTTPS/WSS**를 적용한 전체 구성 가이드입니다.

---

## 1️⃣ 전체 아키텍처

```
               ┌─────────────┐
               │   Clients   │
               └─────┬───────┘
                     │ 443 wss
               ┌─────▼─────┐
               │ External   │  <-- Nginx / HAProxy LB
               │ LoadBalancer│
               └─────┬─────┘
                     │
         ┌───────────┴───────────┐
         │                       │
     Server1                  Server2
  ┌─────┐ ┌─────┐            ┌─────┐ ┌─────┐
  │app1 │ │app2 │            │app5 │ │app6 │
  │app3 │ │app4 │            │app7 │ │app8 │
  └─────┘ └─────┘            └─────┘ └─────┘
```

* LB에서 **WebSocket sticky session(ip_hash)** 적용
* 각 서버에 4개 컨테이너 배포
* HTTPS 인증서는 각 서버 Certbot 설치
* Health check `/health` endpoint로 LB에서 장애 서버 제외

---

## 2️⃣ 서버별 Docker Compose 예시 (Server1)

```yaml
version: '3.8'
services:
  app:
    image: audiohook:latest
    container_name: audiohook_app1
    env_file:
      - /opt/audiohook/configs/.env
    environment:
      NODE_ENV: production
      SERVERHOST: 0.0.0.0
      SERVERPORT: '3000'
      INSTANCE_NAME: app1
    expose:
      - '3000'
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 10s
      timeout: 3s
      retries: 3

  app2:
    image: audiohook:latest
    container_name: audiohook_app2
    env_file:
      - /opt/audiohook/configs/.env
    environment:
      NODE_ENV: production
      SERVERHOST: 0.0.0.0
      SERVERPORT: '3000'
      INSTANCE_NAME: app2
    expose:
      - '3000'
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 10s
      timeout: 3s
      retries: 3

  app3:
    image: audiohook:latest
    container_name: audiohook_app3
    env_file:
      - /opt/audiohook/configs/.env
    environment:
      NODE_ENV: production
      SERVERHOST: 0.0.0.0
      SERVERPORT: '3000'
      INSTANCE_NAME: app3
    expose:
      - '3000'
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 10s
      timeout: 3s
      retries: 3

  app4:
    image: audiohook:latest
    container_name: audiohook_app4
    env_file:
      - /opt/audiohook/configs/.env
    environment:
      NODE_ENV: production
      SERVERHOST: 0.0.0.0
      SERVERPORT: '3000'
      INSTANCE_NAME: app4
    expose:
      - '3000'
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 10s
      timeout: 3s
      retries: 3
```

* Server2는 컨테이너 이름만 app5~app8로 변경하여 동일 배포
* 모든 서버에서 `docker compose up -d`로 실행

---

## 3️⃣ 외부 LB(Nginx) 예시

```nginx
worker_processes auto;
events { worker_connections 4096; }

http {
  upstream app_pool {
    ip_hash;  # sticky session
    server 172.168.1.24:3000 max_fails=3 fail_timeout=10s;
    server 172.168.1.24:3001 max_fails=3 fail_timeout=10s;
    server 172.168.1.25:3000 max_fails=3 fail_timeout=10s;
    server 172.168.1.25:3001 max_fails=3 fail_timeout=10s;
  }

  map $http_upgrade $connection_upgrade { default upgrade; '' close; }

  server {
    listen 80;
    server_name audiohook.i4way.co.kr;
    return 301 https://$host$request_uri;
  }

  server {
    listen 443 ssl;
    server_name audiohook.i4way.co.kr;

    ssl_certificate     /etc/letsencrypt/live/audiohook.i4way.co.kr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/audiohook.i4way.co.kr/privkey.pem;

    ssl_protocols TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    proxy_read_timeout 1d;
    proxy_send_timeout 1d;
    proxy_buffering off;

    location / {
      proxy_pass http://app_pool;
    }
  }
}
```

* 서버1: 172.168.1.24, 서버2: 172.168.1.25
* 포트: 3000~3001 (각 서버 컨테이너 노출)
* WebSocket sticky session(ip_hash) 적용

---

## 4️⃣ HTTPS 및 WSS 적용

* 각 서버 Certbot 설치 후 인증서 발급

```bash
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot certonly --standalone -d audiohook.i4way.co.kr
sudo systemctl enable --now certbot-renew.timer
```

* LB Nginx에서 443 포트로 terminate, 내부 컨테이너는 HTTP 유지
* 클라이언트는 `wss://audiohook.i4way.co.kr/api/v1/audiohook/ws`로 접속

---

## 5️⃣ 배포 단계 요약

1. Server1, Server2 모두 동일 Compose 배포 (컨테이너 각각 4개)
2. 외부 LB(Nginx/HAProxy) 설치, upstream에 두 서버 추가
3. HTTPS 인증서 발급 및 적용
4. WebSocket sticky session(ip_hash) 활성화
5. Healthcheck `/health` 적용으로 장애 컨테이너 자동 제외

---

## 6️⃣ 장점

* **2대 서버 HA 환경** 확보
* 총 8개 컨테이너로 부하 분산
* HTTPS/WSS 안전 통신
* Health 기반 LB로 장애 컨테이너 자동 제외
* 컨테이너 추가/제거 용이

---

원하면 다음 단계로 **stt_load_test.js를 WSS/HTTPS 환경용으로 수정**해서 바로 테스트 돌릴 수 있게 만들어 줄 수 있음.
