import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import dotenv from 'dotenv';
import { pino } from 'pino';
import type { LevelWithSilent, TransportTargetOptions } from 'pino';
import { PrettyOptions } from 'pino-pretty';
import { mkdirSync } from 'fs';
import path from 'path';
import serviceLifecylePlugin from './service-lifecycle-plugin';
import dynamodbPlugin from './dynamodb-plugin';
import secretsPlugin from './secrets-plugin';
import { addAudiohookSampleRoute } from './audiohook-sample-endpoint';
import { addAudiohookLoadTestRoute } from './audiohook-load-test-endpoint';
import { addAudiohookVoiceTranscriptionRoute } from './audiohook-vt-endpoint';

dotenv.config();

const isDev = process.env['NODE_ENV'] !== 'production';

// 콘솔 + 파일 동시 출력 구성
const logLevel = (process.env['LOG_LEVEL'] ?? (isDev ? 'debug' : 'info')) as LevelWithSilent;
const logDir = process.env['LOG_DIR'] ?? path.resolve(process.cwd(), 'logs');
// 파일명은 rotating-file-transport에서 접두사(prefix)와 날짜로 구성됩니다.
const logPrefix = process.env['LOG_PREFIX'] ?? 'app';
const logMaxMb = parseInt(process.env['LOG_MAX_MB'] ?? '50', 10); // MB
const logRetentionDays = parseInt(process.env['LOG_RETENTION_DAYS'] ?? '7', 10);

try {
    mkdirSync(logDir, { recursive: true });
} catch {
    // ignore
}

const targets: TransportTargetOptions[] = [];
if (isDev) {
    // 개발: 예쁜 콘솔 + 파일(JSON)
    targets.push({
        target: 'pino-pretty',
        options: {
            colorize: true,
            ignore: 'pid,hostname',
            translateTime: 'SYS:HH:MM:ss.l',
        } as PrettyOptions,
        level: logLevel
    });
} else {
    // 프로덕션: JSON 콘솔
    targets.push({ target: 'pino/file', options: { destination: 1 }, level: logLevel });
}
// 공통: 파일 출력(날짜/크기 회전 + 보존일수)
targets.push({
    target: path.resolve(__dirname, './rotating-file-transport.js'),
    options: {
        dir: logDir,
        prefix: logPrefix,
        maxMegabytes: logMaxMb,
        retentionDays: logRetentionDays,
    },
    level: logLevel
});

const transport = pino.transport({ targets });
const rootLogger = pino({ level: logLevel }, transport);

const server = Fastify({ logger: rootLogger });

server.register(websocket, {
    options: {
        maxPayload: 65536
    }
});

server.register(async (fastify: FastifyInstance) => {
    addAudiohookSampleRoute(fastify, '/api/v1/audiohook/ws');
    addAudiohookVoiceTranscriptionRoute(fastify, '/api/v1/voicetranscription/ws');
    addAudiohookLoadTestRoute(fastify, '/api/v1/loadtest/ws');

});

server.register(dynamodbPlugin);
server.register(secretsPlugin);
server.register(serviceLifecylePlugin);

server.listen({
    port: parseInt(process.env?.['SERVERPORT'] ?? '3000'),
    host: process.env?.['SERVERHOST'] ?? '127.0.0.1'
}).then(() => {
    server.log.info(`Routes: \n${server.printRoutes()}`);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
