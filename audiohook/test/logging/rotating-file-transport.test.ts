import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const loadRft = () => require('../../../src/rotating-file-transport.js');

function formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

function mkTmpDir(prefix = 'rft-'): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('smoke: jest sees tests', () => {
    expect(true).toBe(true);
});

describe('RotatingFileStream', () => {
    test('retention: deletes files older than retentionDays', async () => {
        const dir = mkTmpDir('rft-retention-');
        const prefix = 'testlog';

        // Create two old log files older than cutoff (retentionDays = 1)
        const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        const oldTag = formatDate(old);
        fs.writeFileSync(path.join(dir, `${prefix}-${oldTag}.log`), 'old-0');
        fs.writeFileSync(path.join(dir, `${prefix}-${oldTag}-1.log`), 'old-1');

        const rftFactory = loadRft();
        const stream = await rftFactory({ dir, prefix, retentionDays: 1 });

        // Give cleanup a tick
        await new Promise((r) => setTimeout(r, 50));

        expect(fs.existsSync(path.join(dir, `${prefix}-${oldTag}.log`))).toBe(false);
        expect(fs.existsSync(path.join(dir, `${prefix}-${oldTag}-1.log`))).toBe(false);

        // Close stream
        await new Promise<void>((resolve, reject) => {
            stream.end(() => resolve());
            stream.on('error', reject);
        });
    }, 10000);

    test('size-based rotation: creates a new file after exceeding max size (min 1MB)', async () => {
        const dir = mkTmpDir('rft-size-');
        const prefix = 'sizelog';
        const today = formatDate(new Date());

        const rftFactory = loadRft();
        const stream = await rftFactory({ dir, prefix, maxMegabytes: 1, retentionDays: 7 });

        // Write >1MB to trigger rotation
        const chunk = Buffer.alloc(1.2 * 1024 * 1024, 0x61);
        await new Promise<void>((resolve, reject) => {
            stream.write(chunk, (err?: Error) => (err ? reject(err) : resolve()));
        });

        // Ensure the internal rotation check happens on next write or at least flush existing
        await new Promise<void>((resolve, reject) => {
            stream.end(() => resolve());
            stream.on('error', reject);
        });

        const files = fs.readdirSync(dir).filter(f => f.startsWith(`${prefix}-${today}`) && f.endsWith('.log'));

        // Expect at least 2 files: base and -1 after rotation
        expect(files.length).toBeGreaterThanOrEqual(2);
        expect(files).toEqual(expect.arrayContaining([
            `${prefix}-${today}.log`,
            `${prefix}-${today}-1.log`,
        ]));
    }, 15000);
});
