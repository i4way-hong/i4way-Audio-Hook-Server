import { EventEmitter } from 'events';
import { readFileSync, existsSync, watch } from 'fs';
import { resolve, join } from 'path';
import dotenv from 'dotenv';

export type RecordingConfigState = {
    recordingEnabled: boolean;
    logRootDir: string;
    immediateRotate: boolean;
};

const DEFAULTS = {
    recordingEnabled: true,
    logRootDir: join(process.cwd(), 'recordings'),
    immediateRotate: false,
} as const;

function parseBoolean(val: string | undefined, defaultValue: boolean): boolean {
    if (val === undefined) {
        return defaultValue;
    }
    if (/^(1|true|yes|on)$/i.test(val)) {
        return true;
    }
    if (/^(0|false|no|off)$/i.test(val)) {
        return false;
    }
    return defaultValue;
}

function loadFromEnvFile(envPath: string): Partial<RecordingConfigState> {
    try {
        if (!existsSync(envPath)) {
            return {};
        }
        const buf = readFileSync(envPath);
        const parsed = dotenv.parse(buf);
        return {
            recordingEnabled: parseBoolean(parsed['RECORDING_TO_FILE_ENABLED'], DEFAULTS.recordingEnabled),
            // 이전 변수(LOG_ROOT_DIR)는 지원 중단. 새 변수(RECORDING_DIR)만 사용
            logRootDir: parsed['RECORDING_DIR'] ?? DEFAULTS.logRootDir,
            immediateRotate: parseBoolean(parsed['RECORDING_IMMEDIATE_ROTATE'], DEFAULTS.immediateRotate),
        };
    } catch {
        return {};
    }
}

function loadFromProcessEnv(): Partial<RecordingConfigState> {
    const res: Partial<RecordingConfigState> = {};
    const e1 = process.env['RECORDING_TO_FILE_ENABLED'];
    if (e1 !== undefined) {
        res.recordingEnabled = parseBoolean(e1, DEFAULTS.recordingEnabled);
    }
    const e2 = process.env['RECORDING_DIR'];
    if (e2 !== undefined) {
        res.logRootDir = e2;
    }
    const e3 = process.env['RECORDING_IMMEDIATE_ROTATE'];
    if (e3 !== undefined) {
        res.immediateRotate = parseBoolean(e3, DEFAULTS.immediateRotate);
    }
    return res;
}

class RecordingConfig extends EventEmitter {
    private envPath: string;
    private state: RecordingConfigState;
    private stopWatch: (() => void) | null = null;

    constructor(envPath?: string) {
        super();
        this.envPath = envPath ?? resolve(process.cwd(), '.env');
        // initial load: process.env first (allows programmatic overrides), then file
        const initial: RecordingConfigState = {
            recordingEnabled: DEFAULTS.recordingEnabled,
            logRootDir: DEFAULTS.logRootDir,
            immediateRotate: DEFAULTS.immediateRotate,
            ...loadFromEnvFile(this.envPath),
            ...loadFromProcessEnv(),
        } as RecordingConfigState;
        this.state = initial;
        this.startWatching();
    }

    private startWatching(): void {
        try {
            const watcher = watch(this.envPath, { persistent: true }, () => {
                this.reload();
            });
            this.stopWatch = () => watcher.close();
        } catch {
            // ignore watch errors on some platforms
            this.stopWatch = null;
        }
    }

    private reload(): void {
        const prev = { ...this.state };
        const fromFile = loadFromEnvFile(this.envPath);
        const fromProc = loadFromProcessEnv();
        // Reload에서는 파일(.env) 값에 우선권을 부여해 핫 리로드를 보장하고,
        // 명시적으로 설정된 process.env 값이 있는 경우에만 그 값으로 덮어쓰도록 함.
        const next: RecordingConfigState = {
            recordingEnabled: (fromFile.recordingEnabled ?? fromProc.recordingEnabled ?? prev.recordingEnabled) as boolean,
            logRootDir: (fromFile.logRootDir ?? fromProc.logRootDir ?? prev.logRootDir) as string,
            immediateRotate: (fromFile.immediateRotate ?? fromProc.immediateRotate ?? prev.immediateRotate) as boolean,
        } as RecordingConfigState;

        if (
            next.recordingEnabled !== prev.recordingEnabled ||
            next.logRootDir !== prev.logRootDir ||
            next.immediateRotate !== prev.immediateRotate
        ) {
            this.state = next;
            this.emit('update', next, prev);
        }
    }

    onUpdate(listener: (next: RecordingConfigState, prev: RecordingConfigState) => void): () => void {
        this.on('update', listener);
        return () => this.off('update', listener);
    }

    get recordingEnabled(): boolean {
        return this.state.recordingEnabled;
    }

    get logRootDir(): string {
        return this.state.logRootDir;
    }

    get immediateRotate(): boolean {
        return this.state.immediateRotate;
    }
}

const recordingConfig = new RecordingConfig();
export default recordingConfig;
