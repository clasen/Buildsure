import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PackageManager } from '../lib/PackageManager.js';
import { makeTmp, cleanup, writeFile } from './_fixtures.mjs';

function executableFixture(t, body = `
    if (process.argv[2] === '--version') process.exit(0);
    require('node:fs').writeFileSync('called.json', JSON.stringify(process.argv.slice(2)));
`) {
    const tmp = makeTmp();
    const originalPath = process.env.PATH;
    t.after(() => {
        cleanup(tmp);
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
    });
    const executable = process.platform === 'win32'
        ? writeFile(tmp, 'bin with spaces/pnpm.cmd', '@echo off\r\nnode "%~dp0pnpm.cjs" %*\r\n')
        : writeFile(tmp, 'bin with spaces/pnpm', `#!/usr/bin/env node\n${body}`);
    if (process.platform === 'win32') writeFile(tmp, 'bin with spaces/pnpm.cjs', body);
    chmodSync(executable, 0o755);
    t.mock.method(process, 'cwd', () => tmp);
    return { tmp, executable };
}

test('explicit executable works with an empty PATH and preserves script arguments', (t) => {
    const { tmp, executable } = executableFixture(t);
    process.env.PATH = '';
    const pm = new PackageManager({ packageManager: 'pnpm', packageManagerPath: executable });
    pm.runScript(tmp, 'build with spaces; echo unexpected');
    assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'called.json'))), ['run', 'build with spaces; echo unexpected']);
});

test('PATH resolution pins the same absolute executable across subsequent commands', (t) => {
    const { tmp, executable } = executableFixture(t);
    process.env.PATH = join(tmp, 'bin with spaces');
    const pm = new PackageManager({ packageManager: 'pnpm' });
    assert.equal(pm.resolve(tmp), 'pnpm');
    process.env.PATH = '';
    pm.install(tmp);
    assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'called.json'))), ['install']);
    pm.runScript(tmp, 'build');
    assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'called.json'))), ['run', 'build']);
    rmSync(executable);
    assert.throws(() => pm.runScript(tmp, 'build'), (error) => {
        if (process.platform === 'win32') assert.notEqual(error.status, 0);
        else assert.equal(error.code, 'ENOENT');
        assert.ok(error.message.includes(executable));
        assert.ok(error.message.includes(tmp));
        return true;
    });
});

test('finds a manager next to the running Node executable without PATH', (t) => {
    const { tmp } = executableFixture(t);
    const originalNode = process.execPath;
    const node = join(tmp, 'bin with spaces', process.platform === 'win32' ? 'node.exe' : 'node');
    if (process.platform === 'win32') copyFileSync(originalNode, node);
    else symlinkSync(originalNode, node);
    process.execPath = node;
    t.after(() => { process.execPath = originalNode; });
    process.env.PATH = '';
    const pm = new PackageManager({ packageManager: 'pnpm' });
    pm.runScript(tmp, 'build');
    assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'called.json'))), ['run', 'build']);
});

test('missing explicit executable retains ENOENT without selecting an installed manager', (t) => {
    const { tmp } = executableFixture(t);
    const missing = join(tmp, 'missing');
    process.env.PATH = join(tmp, 'bin with spaces');
    const pm = new PackageManager({ packageManager: 'pnpm', packageManagerPath: missing });
    assert.throws(() => pm.resolve(tmp), (error) => {
        assert.match(error.message, /not found.*ENOENT/);
        assert.ok(error.message.includes(missing));
        assert.equal(error.cause.code, 'ENOENT');
        return true;
    });
});

test('permission errors are not reported as missing executables', { skip: process.platform === 'win32' }, (t) => {
    const { tmp, executable } = executableFixture(t);
    chmodSync(executable, 0o644);
    const pm = new PackageManager({ packageManager: 'pnpm', packageManagerPath: executable });
    assert.throws(() => pm.resolve(tmp), (error) => {
        assert.equal(error.code, 'EACCES');
        assert.equal(error.cause.code, 'EACCES');
        assert.ok(error.message.includes(executable));
        assert.doesNotMatch(error.message, /not found|not installed/);
        return true;
    });
});

test('failed version checks stop auto resolution and retain the original exit status', (t) => {
    const { tmp } = executableFixture(t, 'process.exit(7);');
    process.env.PATH = join(tmp, 'bin with spaces');
    const pm = new PackageManager();
    assert.throws(() => pm.resolve(tmp), (error) => {
        assert.equal(error.status, 7);
        assert.equal(error.cause.status, 7);
        assert.match(error.message, /exit code 7/);
        return true;
    });
});

test('build errors retain the exit status and directory', (t) => {
    const { tmp, executable } = executableFixture(t, "process.exit(process.argv[2] === '--version' ? 0 : 9);");
    const pm = new PackageManager({ packageManager: 'pnpm', packageManagerPath: executable });
    assert.throws(() => pm.runScript(tmp, 'build'), (error) => {
        assert.equal(error.status, 9);
        assert.equal(error.cause.status, 9);
        assert.ok(error.message.includes(tmp));
        return true;
    });
});

test('version checks terminated by a signal retain that signal', { skip: process.platform === 'win32' }, (t) => {
    const { tmp, executable } = executableFixture(t, "process.kill(process.pid, 'SIGTERM');");
    const pm = new PackageManager({ packageManager: 'pnpm', packageManagerPath: executable });
    assert.throws(() => pm.resolve(tmp), (error) => {
        assert.equal(error.signal, 'SIGTERM');
        assert.equal(error.cause.signal, 'SIGTERM');
        assert.match(error.message, /SIGTERM/);
        return true;
    });
});

test('packageManagerPath rejects relative paths and ambiguous auto selection', () => {
    assert.throws(() => new PackageManager({ packageManager: 'pnpm', packageManagerPath: './pnpm' }), /absolute path/);
    assert.throws(() => new PackageManager({ packageManagerPath: process.execPath }), /explicit packageManager/);
});

test('CLI forwards the explicit executable path with a restricted PATH', (t) => {
    const { tmp, executable } = executableFixture(t);
    writeFile(tmp, 'package.json', JSON.stringify({ scripts: { build: 'unused' } }));
    const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('../bin/buildsure.js', import.meta.url)),
        '--pm', 'pnpm', '--pm-path', executable, tmp,
    ], { env: { ...process.env, PATH: '' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'called.json'))), ['run', 'build']);
});

function fakePM(opts = {}) {
    const calls = [];
    const probe = opts.probe ?? (() => true);
    const capture = opts.capture ?? (() => JSON.stringify({ allowScripts: [] }));
    const pm = new PackageManager({
        ...opts,
        probe,
        capture,
        exec: (cmd, args, cwd) => { calls.push({ cmd, args, cwd }); },
    });
    return { pm, calls };
}

test('Windows batch invocation escapes arguments before handing them to cmd.exe', (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalExec = childProcess.execFileSync;
    const originalShellExec = childProcess.execSync;
    const calls = [];
    Object.defineProperty(process, 'platform', { value: 'win32' });
    childProcess.execFileSync = (...args) => { calls.push(args); return ''; };
    childProcess.execSync = () => { assert.fail('Batch commands must use the escaped cmd.exe invocation'); };
    syncBuiltinESMExports();
    t.after(() => {
        Object.defineProperty(process, 'platform', platform);
        childProcess.execFileSync = originalExec;
        childProcess.execSync = originalShellExec;
        syncBuiltinESMExports();
    });
    const pm = new PackageManager({ packageManager: 'pnpm', probe: () => true });
    t.mock.method(pm, '_executable', () => 'C:\\Program Files\\pnpm.cmd');
    pm.runScript('C:\\project', 'build & echo unexpected');
    const [command, args, options] = calls[0];
    assert.equal(command, process.env.ComSpec || 'cmd.exe');
    assert.deepEqual(args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
    assert.equal(args[4], '"C:\\Program^ Files\\pnpm.cmd ^"run^" ^"build^ ^&^ echo^ unexpected^""');
    assert.equal(options.windowsVerbatimArguments, true);
    assert.equal(options.cwd, 'C:\\project');

    t.mock.method(pm, '_executable', () => 'C:\\project\\node_modules\\.bin\\pnpm.cmd');
    pm.runScript('C:\\project', 'build&test');
    assert.ok(calls[1][1][4].includes('build^^^&test'));

    assert.throws(() => pm.runScript('C:\\project', 'build\necho unexpected'), { code: 'EINVAL' });
    assert.equal(calls.length, 2);
});

test('Windows batch managers preserve script names without executing their metacharacters', {
    skip: process.platform !== 'win32',
}, (t) => {
    const { tmp, executable } = executableFixture(t);
    process.env.PATH = '';
    const bat = writeFile(tmp, 'bin with spaces/pnpm.bat', readFileSync(executable));
    const localShim = writeFile(tmp, 'node_modules/.bin/pnpm.cmd',
        '@echo off\r\nsetlocal\r\nendlocal & goto #_undefined_# 2>NUL || title %COMSPEC% & node "%~dp0../../bin with spaces/pnpm.cjs" %*\r\n');
    for (const packageManagerPath of [executable, bat, localShim]) {
        const pm = new PackageManager({ packageManager: 'pnpm', packageManagerPath });
        for (const script of ['build with spaces', 'build & echo injected>unexpected.txt',
            'build|echo injected', '%PATH%', '!PATH!', 'quote"test', 'trailing\\', '(build)^test']) {
            pm.runScript(tmp, script);
            assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'called.json'))), ['run', script]);
            assert.equal(existsSync(join(tmp, 'unexpected.txt')), false);
        }
    }
});

test('detectFromLockfile: pnpm', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'pnpm-lock.yaml', '');
        assert.equal(PackageManager.detectFromLockfile(tmp), 'pnpm');
    } finally { cleanup(tmp); }
});

test('detectFromLockfile: yarn', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'yarn.lock', '');
        assert.equal(PackageManager.detectFromLockfile(tmp), 'yarn');
    } finally { cleanup(tmp); }
});

test('detectFromLockfile: bun', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'bun.lockb', '');
        assert.equal(PackageManager.detectFromLockfile(tmp), 'bun');
    } finally { cleanup(tmp); }
});

test('detectFromLockfile: npm', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'package-lock.json', '{}');
        assert.equal(PackageManager.detectFromLockfile(tmp), 'npm');
    } finally { cleanup(tmp); }
});

test('detectFromLockfile: null when no lockfile', () => {
    const tmp = makeTmp();
    try {
        assert.equal(PackageManager.detectFromLockfile(tmp), null);
    } finally { cleanup(tmp); }
});

test('resolve auto: uses lockfile-detected pm when available', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'pnpm-lock.yaml', '');
        const { pm } = fakePM();
        assert.equal(pm.resolve(tmp), 'pnpm');
    } finally { cleanup(tmp); }
});

test('resolve auto: falls back to preferred when lockfile pm not installed', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'pnpm-lock.yaml', '');
        const { pm } = fakePM({ probe: (n) => n === 'npm' });
        assert.equal(pm.resolve(tmp), 'npm');
    } finally { cleanup(tmp); }
});

test('resolve auto: walks preferred list in order', () => {
    const tmp = makeTmp();
    try {
        const { pm } = fakePM({
            preferred: ['pnpm', 'npm', 'yarn'],
            probe: (n) => n === 'yarn',
        });
        assert.equal(pm.resolve(tmp), 'yarn');
    } finally { cleanup(tmp); }
});

test('resolve auto: throws when no pm available', () => {
    const tmp = makeTmp();
    try {
        const { pm } = fakePM({ probe: () => false });
        assert.throws(() => pm.resolve(tmp), /No available package manager/);
    } finally { cleanup(tmp); }
});

test('resolve forced: uses forced pm when available', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'pnpm-lock.yaml', '');
        const { pm } = fakePM({ packageManager: 'npm' });
        assert.equal(pm.resolve(tmp), 'npm');
    } finally { cleanup(tmp); }
});

test('resolve forced: throws when forced pm missing', () => {
    const tmp = makeTmp();
    try {
        const { pm } = fakePM({ packageManager: 'pnpm', probe: () => false });
        assert.throws(() => pm.resolve(tmp), /pnpm.*not found/);
    } finally { cleanup(tmp); }
});

test('constructor: rejects unknown packageManager', () => {
    assert.throws(() => new PackageManager({ packageManager: 'cargo' }), /Unsupported/);
});

test('install with npm: includes dev dependencies and checks install-script policy', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'package-lock.json', '{}');
        const { pm, calls } = fakePM();
        pm.install(tmp);
        assert.deepEqual(calls[0], { cmd: 'npm', args: ['install', '--include=dev'], cwd: tmp });
    } finally { cleanup(tmp); }
});

test('install with npm: fails before build when install scripts need review', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'package-lock.json', '{}');
        const { pm } = fakePM({
            capture: () => JSON.stringify({
                allowScripts: [{
                    name: '@ffprobe-installer/linux-x64',
                    changes: [{
                        key: '@ffprobe-installer/linux-x64@5.2.0',
                        change: 'pending',
                    }],
                }],
            }),
        });

        assert.throws(
            () => pm.install(tmp),
            /@ffprobe-installer\/linux-x64@5\.2\.0.*npm install-scripts approve/s,
        );
    } finally { cleanup(tmp); }
});

test('install with npm: supports npm versions without install-scripts', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'package-lock.json', '{}');
        const error = new Error('Command failed');
        error.stderr = Buffer.from('Unknown command: "install-scripts"');
        const { pm } = fakePM({
            capture: () => { throw error; },
        });

        assert.equal(pm.install(tmp), 'npm');
    } finally { cleanup(tmp); }
});

test('install with pnpm: ignores installArgs (dev included by default)', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'pnpm-lock.yaml', '');
        const { pm, calls } = fakePM();
        pm.install(tmp);
        assert.deepEqual(calls[0], { cmd: 'pnpm', args: ['install'], cwd: tmp });
    } finally { cleanup(tmp); }
});

test('runScript with yarn: omits "run" keyword', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'yarn.lock', '');
        const { pm, calls } = fakePM();
        pm.runScript(tmp, 'build');
        assert.deepEqual(calls[0], { cmd: 'yarn', args: ['build'], cwd: tmp });
    } finally { cleanup(tmp); }
});

test('runScript with bun: uses "run" keyword', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'bun.lockb', '');
        const { pm, calls } = fakePM();
        pm.runScript(tmp, 'build');
        assert.deepEqual(calls[0], { cmd: 'bun', args: ['run', 'build'], cwd: tmp });
    } finally { cleanup(tmp); }
});
