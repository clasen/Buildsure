import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export function makeTmp(prefix = 'buildsure-') {
    return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir) {
    rmSync(dir, { recursive: true, force: true });
}

export function writeFile(dir, relPath, contents = '', mtime) {
    const full = join(dir, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
    if (mtime != null) {
        const t = new Date(mtime);
        utimesSync(full, t, t);
    }
    return full;
}

export function touch(path, mtime) {
    const t = new Date(mtime);
    utimesSync(path, t, t);
}

export function makePackageJson(dir, scripts = {}) {
    writeFile(dir, 'package.json', JSON.stringify({ name: 'fix', version: '0.0.0', scripts }, null, 2));
}
