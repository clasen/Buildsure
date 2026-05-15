import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackageManager } from '../lib/PackageManager.js';
import { makeTmp, cleanup, writeFile } from './_fixtures.mjs';

function fakePM(opts = {}) {
    const calls = [];
    const probe = opts.probe ?? (() => true);
    const pm = new PackageManager({
        ...opts,
        probe,
        exec: (cmd, args, cwd) => { calls.push({ cmd, args, cwd }); },
    });
    return { pm, calls };
}

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
        assert.throws(() => pm.resolve(tmp), /pnpm.*not installed/);
    } finally { cleanup(tmp); }
});

test('constructor: rejects unknown packageManager', () => {
    assert.throws(() => new PackageManager({ packageManager: 'cargo' }), /Unsupported/);
});

test('install with npm: passes installArgs (--include=dev)', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'package-lock.json', '{}');
        const { pm, calls } = fakePM();
        pm.install(tmp);
        assert.deepEqual(calls[0], { cmd: 'npm', args: ['install', '--include=dev'], cwd: tmp });
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
