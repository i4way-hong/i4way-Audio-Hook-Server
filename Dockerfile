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
RUN npm install  pm2 -g

# pm2-prometheus-exporter 설치
RUN pm2 install pm2-prometheus-exporter

# 빌드 결과물 복사
COPY --from=builder /buildarea/node_modules ./node_modules
COPY --from=builder /buildarea/dist ./dist

# ecosystem.config.js 복사 (프로젝트 루트에 있어야 함)
COPY ecosystem.config.js ./ecosystem.config.js

USER node

ENTRYPOINT ["pm2-runtime", "start", "ecosystem.config.js"]