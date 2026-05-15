import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { mkdirSync } from 'fs';
import BuildSure, { PackageManager } from '../index.js';
import { makeTmp, cleanup, writeFile, makePackageJson } from './_fixtures.mjs';

function makeBuildSure(opts = {}) {
    const calls = [];
    const pm = new PackageManager({
        packageManager: opts.packageManager ?? 'auto',
        preferred: ['npm'],
        probe: () => true,
        exec: (cmd, args, cwd) => { calls.push({ cmd, args, cwd }); },
    });
    const bs = new BuildSure({ pm, ...opts });
    return { bs, calls };
}

const PAST = Date.now() - 60_000;
const FUTURE = Date.now() + 60_000;

test('check: reports needsInstall=true on fresh project', () => {
    const tmp = makeTmp();
    try {
        makePackageJson(tmp, { build: 'echo' });
        const { bs } = makeBuildSure();
        const status = bs.check(tmp);
        assert.equal(status.exists, true);
        assert.equal(status.hasBuildScript, true);
        assert.equal(status.needsInstall, true);
        assert.equal(status.needsBuild, true);
    } finally { cleanup(tmp); }
});

test('check: nonexistent path → exists=false, needsBuild=false', () => {
    const { bs } = makeBuildSure();
    const status = bs.check('/nonexistent/xyz');
    assert.equal(status.exists, false);
    assert.equal(status.needsBuild, false);
    assert.equal(status.packageManager, null);
});

test('ensure: runs install + build on fresh project', async () => {
    const tmp = makeTmp();
    try {
        makePackageJson(tmp, { build: 'echo' });
        writeFile(tmp, 'src/index.js', 'a');
        const { bs, calls } = makeBuildSure();
        const r = await bs.ensure(tmp);
        assert.equal(r.status, 'built');
        assert.equal(calls.length, 2);
        assert.equal(calls[0].args[0], 'install');
        assert.equal(calls[1].args[0], 'run');
        assert.equal(calls[1].args[1], 'build');
    } finally { cleanup(tmp); }
});

test('ensure: skips install + build when up to date', async () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'package.json', JSON.stringify({ scripts: { build: 'echo' } }), PAST);
        mkdirSync(join(tmp, 'node_modules'));
        writeFile(tmp, 'node_modules/.package-lock.json', '{}', FUTURE);
        writeFile(tmp, 'src/index.js', 'a', PAST);
        writeFile(tmp, 'dist/index.js', 'a', FUTURE);

        const { bs, calls } = makeBuildSure();
        const r = await bs.ensure(tmp);
        assert.equal(r.status, 'up-to-date');
        assert.equal(calls.length, 0);
    } finally { cleanup(tmp); }
});

test('ensure: runs install for build even when deps fresh (npm dev-deps safety)', async () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'package.json', JSON.stringify({ scripts: { build: 'echo' } }), PAST);
        mkdirSync(join(tmp, 'node_modules'));
        writeFile(tmp, 'node_modules/.package-lock.json', '{}', FUTURE);
        writeFile(tmp, 'src/index.js', 'a', FUTURE);

        const { bs, calls } = makeBuildSure();
        const r = await bs.ensure(tmp);
        assert.equal(r.status, 'built');
        assert.equal(calls.length, 2);
        assert.equal(calls[0].args[0], 'install');
    } finally { cleanup(tmp); }
});

test('ensure: returns failed when install throws', async () => {
    const tmp = makeTmp();
    try {
        makePackageJson(tmp, { build: 'echo' });
        const pm = new PackageManager({
            preferred: ['npm'],
            probe: () => true,
            exec: () => { throw new Error('install boom'); },
        });
        const bs = new BuildSure({ pm });
        const r = await bs.ensure(tmp);
        assert.equal(r.status, 'failed');
        assert.equal(r.phase, 'install');
        assert.match(r.error.message, /install boom/);
    } finally { cleanup(tmp); }
});

test('ensure: returns failed when build throws', async () => {
    const tmp = makeTmp();
    try {
        makePackageJson(tmp, { build: 'echo' });
        writeFile(tmp, 'src/index.js', 'a');
        let n = 0;
        const pm = new PackageManager({
            preferred: ['npm'],
            probe: () => true,
            exec: () => { if (++n === 2) throw new Error('build boom'); },
        });
        const bs = new BuildSure({ pm });
        const r = await bs.ensure(tmp);
        assert.equal(r.status, 'failed');
        assert.equal(r.phase, 'build');
    } finally { cleanup(tmp); }
});

test('ensureAll: aggregates results across multiple projects', async () => {
    const tmp = makeTmp();
    try {
        makePackageJson(join(tmp, 'app-a'), { build: 'echo' });
        writeFile(join(tmp, 'app-a'), 'src/x.js', 'a');
        makePackageJson(join(tmp, 'app-b'), { test: 'jest' });
        writeFile(join(tmp, 'orphan'), 'README.md', 'no pkg');

        const { bs } = makeBuildSure();
        const result = await bs.ensureAll(tmp);
        assert.equal(result.successful.length, 1);
        assert.deepEqual(result.successful, ['app-a']);
        assert.equal(result.skipped.length, 2);
    } finally { cleanup(tmp); }
});

test('onLog and onProgress hooks fire', async () => {
    const tmp = makeTmp();
    try {
        makePackageJson(tmp, { build: 'echo' });
        writeFile(tmp, 'src/x.js', 'a');
        const logs = [];
        const events = [];
        const pm = new PackageManager({
            preferred: ['npm'], probe: () => true, exec: () => {},
        });
        const bs = new BuildSure({
            pm,
            onLog: (m) => logs.push(m),
            onProgress: (e) => events.push(e),
        });
        await bs.ensure(tmp);
        assert.ok(logs.length > 0);
        assert.ok(events.some(e => e.phase === 'install' && e.status === 'start'));
        assert.ok(events.some(e => e.phase === 'build' && e.status === 'done'));
    } finally { cleanup(tmp); }
});
