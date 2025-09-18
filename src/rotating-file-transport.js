/* eslint-disable */
'use strict';
const { Writable } = require('stream');
const fs = require('fs');
const path = require('path');

function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

function ensureDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch {
        // ignore
    }
}

class RotatingFileStream extends Writable {
    constructor(opts) {
        super({ decodeStrings: true });
        this.dir = opts.dir;
        this.prefix = opts.prefix || 'app';
        this.maxBytes = Math.max(1, (opts.maxMegabytes || 50)) * 1024 * 1024;
        this.retentionDays = Math.max(1, (opts.retentionDays || 7));
        ensureDir(this.dir);
        this.currentDate = formatDate(new Date());
        this.currentIndex = 0;
        this.currentStream = null;
        this.bytesWritten = 0;
        this._openInitial();
        this._scheduleMidnightRotation();
        this._cleanupOldLogs();
    }

    _filename(dateTag, index) {
        const suffix = index > 0 ? `-${index}` : '';
        return path.join(this.dir, `${this.prefix}-${dateTag}${suffix}.log`);
    }

    _scanTodayLastIndex(dateTag) {
        let lastIndex = -1;
        try {
            const files = fs.readdirSync(this.dir);
            for (const f of files) {
                const base = `${this.prefix}-${dateTag}`;
                if (!f.startsWith(base)) {
                    continue;
                }
                if (f === `${base}.log`) {
                    lastIndex = Math.max(lastIndex, 0);
                    continue;
                }
                const m = f.match(new RegExp(`^${base}-(\\d+)\\.log$`));
                if (m && m[1]) {
                    lastIndex = Math.max(lastIndex, parseInt(m[1], 10));
                }
            }
        } catch {
            // ignore
        }
        return lastIndex;
    }

    _openInitial() {
        const dateTag = this.currentDate;
        let idx = this._scanTodayLastIndex(dateTag);
        if (idx < 0) {
            idx = 0;
        }
        let p = this._filename(dateTag, idx);
        let size = 0;
        try {
            size = fs.statSync(p).size;
        } catch {
            size = 0;
        }
        if (size >= this.maxBytes) {
            idx += 1;
            p = this._filename(dateTag, idx);
            size = 0;
        }
        this._openStream(p, idx, size);
    }

    _openStream(p, idx, size) {
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
        this.currentStream = fs.createWriteStream(p, { flags: 'a' });
    }

    _write(chunk, _enc, cb) {
        try {
            // Date change (midnight) rotation
            const now = new Date();
            const dateTag = formatDate(now);
            if (dateTag !== this.currentDate) {
                this.currentDate = dateTag;
                this._openStream(this._filename(dateTag, 0), 0, 0);
                this._cleanupOldLogs();
            }

            const add = Buffer.byteLength(chunk);
            // Proactive size-based rotation: if this write would exceed max, rotate first
            if (this.bytesWritten + add > this.maxBytes) {
                const nextIdx = this.currentIndex + 1;
                const p = this._filename(this.currentDate, nextIdx);
                this._openStream(p, nextIdx, 0);
            }

            this.bytesWritten += add;
            this.currentStream.write(chunk, cb);
        } catch (e) {
            cb(e);
        }
    }

    _final(cb) {
        try {
            if (this.currentStream) {
                this.currentStream.end();
            }
        } catch {
            // ignore
        }
        cb();
    }

    _scheduleMidnightRotation() {
        const now = new Date();
        const next = new Date(now);
        next.setHours(24, 0, 0, 0);
        const ms = next.getTime() - now.getTime();
        const timer = setTimeout(() => {
            this.currentDate = formatDate(new Date());
            this._cleanupOldLogs();
            this._scheduleMidnightRotation();
        }, ms);
        if (typeof timer.unref === 'function') {
            timer.unref();
        }
    }

    _cleanupOldLogs() {
        const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
        try {
            const files = fs.readdirSync(this.dir);
            for (const f of files) {
                const m = f.match(/^(.*)-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.log$/);
                if (!m) {
                    continue;
                }
                const t = Date.parse(m[2]);
                if (!isNaN(t) && t < cutoff) {
                    try {
                        fs.unlinkSync(path.join(this.dir, f));
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

module.exports = async function (opts = {}) {
    return new RotatingFileStream(opts);
};
