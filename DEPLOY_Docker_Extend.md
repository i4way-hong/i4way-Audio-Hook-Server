# Audiohook 운영 패키지 — Rocky Linux 9 맞춤 템플릿 (개별 파일 세트)

아래는 제공한 서버 환경에 맞추어 **완전 커스터마이징된 운영 템플릿 6종**입니다.

* `nginx.conf`
* `docker-compose.yml` (scale 사용 가능)
* `docker-compose.override.yml`
* `Dockerfile` (PM2 cluster 기반)
* `ecosystem.config.js`
* `stt_load_test.js`

각 파일은 Rocky Linux 9, CPU 1core, 내부IP 172.168.1.24, 도메인 audiohook.i4way.co.kr 환경을 기준으로 설계되었습니다.

---

# 📌 1. nginx.conf

* WebSocket 최적화
* STT 세션 특성 고려한 keepalive
* 추후 HTTPS 적용 용이하게 작성
* 로드벨런싱을 위한 up stream 구분

```nginx
worker_processes auto;

events {
    worker_connections 4096;
}

http {

    upstream app_pool {
        # 라운드로빈 기본
        server app1:3000;
        server app2:3000;
        server app3:3000;
        server app4:3000;
        keepalive 100;
    }

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 75s;

    server {
        listen 3000;

        # Forwarded headers
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_http_version 1.1;

        proxy_connect_timeout 60s;
        proxy_send_timeout 1d;
        proxy_read_timeout 1d;
        proxy_buffering off;

        location / {
            proxy_pass http://app_pool;
        }
    }
}

```

---

# 📌 2. docker-compose.yml
* 앱 컨테이너 분리
* 로드벨런싱 설정, Prometheus(오픈소스 모니터링 및 알림(알람) 시스템), cAdvisor (컨테이너 OS/Resource 메트릭), Grafana(Dashboard저작툴)

```yaml
services:
  # AudioHook 앱들
  app1:
    image: audiohook:latest
    container_name: app1
    env_file:
      - /opt/audiohook/configs/.env
    environment:
      NODE_ENV: production
      SERVERHOST: 0.0.0.0
      SERVERPORT: '3000'
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings
    ports:
      - "3001:3000"
      - "9209:9209"  # PM2 Prometheus Exporter
    command: >
      sh -c "pm2-runtime start ecosystem.config.js --only app1 &&
             pm2 install pm2-prometheus-exporter --port 9209"
    restart: unless-stopped

  app2:
    image: audiohook:latest
    container_name: app2
    env_file:
      - /opt/audiohook/configs/.env
    environment:
      NODE_ENV: production
      SERVERHOST: 0.0.0.0
      SERVERPORT: '3000'
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings
    ports:
      - "3002:3000"
      - "9210:9209"
    command: >
      sh -c "pm2-runtime start ecosystem.config.js --only app2 &&
             pm2 install pm2-prometheus-exporter --port 9209"
    restart: unless-stopped

  app3:
    image: audiohook:latest
    container_name: app3
    env_file:
      - /opt/audiohook/configs/.env
    environment:
      NODE_ENV: production
      SERVERHOST: 0.0.0.0
      SERVERPORT: '3000'
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings
    ports:
      - "3003:3000"
      - "9211:9209"
    command: >
      sh -c "pm2-runtime start ecosystem.config.js --only app3 &&
             pm2 install pm2-prometheus-exporter --port 9209"
    restart: unless-stopped

  app4:
    image: audiohook:latest
    container_name: app4
    env_file:
      - /opt/audiohook/configs/.env
    environment:
      NODE_ENV: production
      SERVERHOST: 0.0.0.0
      SERVERPORT: '3000'
    volumes:
      - /opt/audiohook/logs:/app/logs
      - /opt/audiohook/recordings:/app/recordings
    ports:
      - "3004:3000"
      - "9212:9209"
    command: >
      sh -c "pm2-runtime start ecosystem.config.js --only app4 &&
             pm2 install pm2-prometheus-exporter --port 9209"
    restart: unless-stopped

  # Nginx Load Balancer
  lb:
    image: nginx:1.27-alpine
    container_name: lb
    depends_on:
      - app1
      - app2
      - app3
      - app4
    ports:
      - "3000:3000"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    restart: unless-stopped

  # Prometheus
  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - "9090:9090"
    restart: unless-stopped

  # cAdvisor (컨테이너 OS/Resource 메트릭)
  cadvisor:
    image: gcr.io/cadvisor/cadvisor:latest
    container_name: cadvisor
    ports:
      - "8080:8080"
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    restart: unless-stopped

  # Grafana
  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    ports:
      - "3005:3000"
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
    volumes:
      - grafana-storage:/var/lib/grafana
    depends_on:
      - prometheus
    restart: unless-stopped

volumes:
  grafana-storage:
```

# 📌 3. prometheus.yml
```bash
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'pm2_apps'
    static_configs:
      - targets:
          - app1:9209
          - app2:9209
          - app3:9209
          - app4:9209

  - job_name: 'cadvisor'
    static_configs:
      - targets:
          - cadvisor:8080
```

프로그램 기동
```bash
docker compose up -d
```

프로그램 중지
```bash
docker compose down
```

프로그램 로그 확인
```bash
docker compose logs -f
```

## Grafana(Dashboard 저작툴)  접속
```bash
http://172.168.1.24:3005/login
id/pw : admin/admin
```

# 📌 3. docker-compose.override.yml (옵션 파일)

로그 설정 및 로컬 개발 편의성 제공

```yaml
version: '3.8'
services:
  app:
    logging:
      driver: json-file
      options:
        max-size: '10m'
        max-file: '5'
```

---

# 📌 4. Dockerfile (PM2 Cluster 적용)

* CPU가 1 core 이므로 내부 cluster 효과는 제한적
* 하지만 향후 스케일링 시 안정성 확보

```dockerfile
ARG NODE_VERSION=22

### ======== Builder Stage ========
FROM node:${NODE_VERSION} AS builder
WORKDIR /buildarea

COPY .eslintrc .eslintignore package.json package-lock.json tsconfig.json audiohook-sample-server-1.0.2.tgz ./
RUN npm ci

COPY src ./src
COPY audiohook ./audiohook
RUN npm run build

# JS 헬퍼 복사
RUN mkdir -p dist/src && cp -v src/*.js dist/src/ 2>/dev/null || true

# bytebuffer 존재 검증
RUN node -e "require('bytebuffer');console.log('bytebuffer ok')"

RUN npm prune --production


### ======== Runtime Stage with PM2 ========
FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV RECORDING_DIR=/tmp/
ENV SERVERPORT=8080
ENV SERVERHOST=0.0.0.0

EXPOSE $SERVERPORT

# PM2 설치
RUN npm install -g pm2

# 빌드 결과물 복사
COPY --from=builder /buildarea/node_modules ./node_modules
COPY --from=builder /buildarea/dist ./dist

# ecosystem.config.js 복사 (프로젝트 루트에 있어야 함)
COPY ecosystem.config.js ./ecosystem.config.js

USER node

#ENTRYPOINT ["pm2-runtime", "start", "ecosystem.config.js"]
EXPOSE 3000 9209
CMD ["pm2-runtime", "start", "ecosystem.config.js"]
```

# 📌 5. ecosystem.config.js (PM2 클러스터)

```js
module.exports = {
  apps: [
    {
      name: 'audiohook',
      script: './dist/app.js',
      instances: 'max',   // CPU 자동 인식 (현재는 1개)
      exec_mode: 'cluster',
      watch: false,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}
```
# 📌 포트 3000 → 443(HTTPS) 변경 가이드 (추후 적용용)

1. nginx.conf의 `listen 3000` → `listen 443 ssl;`
2. `ssl_certificate`, `ssl_certificate_key` 추가
3. `docker-compose.yml`에서 LB ports 변경
4. certbot 또는 사설 CA 적용

