import { Writable } from 'stream';
import { mkdirSync, readdirSync, statSync, unlinkSync, createWriteStream, WriteStream } from 'fs';
import path from 'path';

export type RotatingLogOptions = {
    dir: string;
    prefix?: string;
    maxMegabytes?: number; // per file
    retentionDays?: number; // keep last N days
};

function formatDate(d: Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function ensureDir(dir: string): void {
    try {
        mkdirSync(dir, { recursive: true });
    } catch {
        // ignore
    }
}

export class RotatingLogStream extends Writable {
    private dir: string;
    private prefix: string;
    private maxBytes: number;
    private retentionDays: number;

    private currentDate: string;
    private currentIndex = 0;
    private currentPath: string | null = null;
    private currentStream: WriteStream | null = null;
    private bytesWritten = 0;

    constructor(opts: RotatingLogOptions) {
        super({ decodeStrings: true });
        this.dir = opts.dir;
        this.prefix = opts.prefix || 'app';
        this.maxBytes = Math.max(1, (opts.maxMegabytes ?? 50)) * 1024 * 1024; // default 50MB
        this.retentionDays = Math.max(1, (opts.retentionDays ?? 7)); // default 7 days

        ensureDir(this.dir);
        this.currentDate = formatDate(new Date());
        this.openInitial();
        this.scheduleMidnightRotation();
        this.cleanupOldLogs();
    }

    private fileName(dateTag: string, index: number): string {
        const suffix = index > 0 ? `-${index}` : '';
        return path.join(this.dir, `${this.prefix}-${dateTag}${suffix}.log`);
    }

    private parseIndexFromName(name: string, dateTag: string): number | null {
        const base = `${this.prefix}-${dateTag}`;
        if (!name.startsWith(base)) {
            return null;
        }
        const rest = name.slice(base.length); // '.log' or '-N.log'
        if (rest === '.log') {
            return 0;
        }
        const m = rest.match(/^-(\d+)\.log$/);
        if (m && m[1]) {
            return parseInt(m[1], 10);
        }
        return null;
    }

    private scanTodayLastIndex(dateTag: string): number {
        let last = -1;
        try {
            const files = readdirSync(this.dir);
            for (const f of files) {
                const idx = this.parseIndexFromName(f, dateTag);
                if (idx !== null && idx > last) {
                    last = idx;
                }
            }
        } catch {
            // ignore
        }
        return last;
    }

    private openInitial(): void {
        const dateTag = this.currentDate;
        let idx = this.scanTodayLastIndex(dateTag);
        if (idx < 0) {
            idx = 0;
        }
        let p = this.fileName(dateTag, idx);
        let size = 0;
        try {
            const st = statSync(p);
            size = st.size;
        } catch {
            size = 0;
        }
        if (size >= this.maxBytes) {
            idx += 1;
            p = this.fileName(dateTag, idx);
            size = 0;
        }
        this.openStream(p, idx, size);
    }

    private openStream(p: string, idx: number, size: number): void {
        if (this.currentStream) {
            try {
                this.currentStream.end();
            } catch {
                // ignore
            }
        }
        this.currentPath = p;
        this.currentIndex = idx;
        this.bytesWritten = size || 0;
        this.currentStream = createWriteStream(p, { flags: 'a' });
    }

    private rotateIfNeeded(): void {
        const now = new Date();
        const dateTag = formatDate(now);
        if (dateTag !== this.currentDate) {
            this.currentDate = dateTag;
            this.openStream(this.fileName(dateTag, 0), 0, 0);
            this.cleanupOldLogs();
            return;
        }
        if (this.bytesWritten >= this.maxBytes) {
            const nextIdx = this.currentIndex + 1;
            const p = this.fileName(this.currentDate, nextIdx);
            this.openStream(p, nextIdx, 0);
        }
    }

    override _write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
        try {
            this.rotateIfNeeded();
            if (!this.currentStream) {
                throw new Error('Log stream is not initialized');
            }
            this.bytesWritten += chunk.length;
            this.currentStream.write(chunk, cb);
        } catch (e) {
            cb(e as Error);
        }
    }

    override _final(cb: (error?: Error | null) => void): void {
        try {
            if (this.currentStream) {
                this.currentStream.end();
            }
            cb();
        } catch (e) {
            cb(e as Error);
        }
    }

    private scheduleMidnightRotation(): void {
        const now = new Date();
        const next = new Date(now);
        next.setHours(24, 0, 0, 0);
        const ms = next.getTime() - now.getTime();
        setTimeout(() => {
            // set to new date; actual reopen occurs on next write
            this.currentDate = formatDate(new Date());
            this.cleanupOldLogs();
            this.scheduleMidnightRotation();
        }, ms);
    }

    private cleanupOldLogs(): void {
        const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
        try {
            const files = readdirSync(this.dir);
            for (const f of files) {
                const m = f.match(new RegExp(`^${this.prefix}-([0-9]{4}-[0-9]{2}-[0-9]{2})(?:-\\d+)?\\.log$`));
                if (!m) {
                    continue;
                }
                const dateStr = m[1];
                const t = Date.parse(dateStr);
                if (!Number.isNaN(t) && t < cutoff) {
                    try {
                        unlinkSync(path.join(this.dir, f));
                    } catch {
                        // ignore
                    }
                }
            }
        } catch {
            // ignore
        }
    }
}

export default RotatingLogStream;
