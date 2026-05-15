import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { Freshness } from '../lib/Freshness.js';
import { makeTmp, cleanup, writeFile, makePackageJson } from './_fixtures.mjs';

const PAST = Date.now() - 60_000;
const FUTURE = Date.now() + 60_000;

test('needsInstall: false when no package.json', () => {
    const tmp = makeTmp();
    try {
        assert.equal(new Freshness().needsInstall(tmp), false);
    } finally { cleanup(tmp); }
});

test('needsInstall: true when package.json exists but no node_modules', () => {
    const tmp = makeTmp();
    try {
        makePackageJson(tmp, { build: 'echo' });
        assert.equal(new Freshness().needsInstall(tmp), true);
    } finally { cleanup(tmp); }
});

test('needsInstall: false when node_modules .package-lock.json is newer than package.json', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'package.json', '{"name":"x"}', PAST);
        mkdirSync(join(tmp, 'node_modules'));
        writeFile(tmp, 'node_modules/.package-lock.json', '{}', FUTURE);
        assert.equal(new Freshness().needsInstall(tmp), false);
    } finally { cleanup(tmp); }
});

test('needsInstall: true when package.json is newer than .package-lock.json', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'package.json', '{"name":"x"}', FUTURE);
        mkdirSync(join(tmp, 'node_modules'));
        writeFile(tmp, 'node_modules/.package-lock.json', '{}', PAST);
        assert.equal(new Freshness().needsInstall(tmp), true);
    } finally { cleanup(tmp); }
});

test('needsBuild: true when no output directory exists', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'src/index.js', 'console.log("hi")');
        assert.equal(new Freshness().needsBuild(tmp), true);
    } finally { cleanup(tmp); }
});

test('needsBuild: false when output is newer than sources', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'src/index.js', 'a', PAST);
        writeFile(tmp, 'dist/index.js', 'a', FUTURE);
        assert.equal(new Freshness().needsBuild(tmp), false);
    } finally { cleanup(tmp); }
});

test('needsBuild: true when source is newer than output', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'src/index.js', 'a', FUTURE);
        writeFile(tmp, 'dist/index.js', 'a', PAST);
        assert.equal(new Freshness().needsBuild(tmp), true);
    } finally { cleanup(tmp); }
});

test('needsBuild: detects config file changes (vite.config.js)', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'src/index.js', 'a', PAST);
        writeFile(tmp, 'dist/index.js', 'a', PAST);
        writeFile(tmp, 'vite.config.js', 'export default {}', FUTURE);
        assert.equal(new Freshness().needsBuild(tmp), true);
    } finally { cleanup(tmp); }
});

test('needsBuild: ignores vite timestamp temp files', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'src/index.js', 'a', PAST);
        writeFile(tmp, 'dist/index.js', 'a', PAST);
        writeFile(tmp, 'vite.config.js.timestamp-1234.mjs', 'x', FUTURE);
        assert.equal(new Freshness().needsBuild(tmp), false);
    } finally { cleanup(tmp); }
});

test('getNewestMtime: ignores node_modules and dotfiles by default', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'src/a.js', 'x', PAST);
        writeFile(tmp, 'node_modules/junk.js', 'x', FUTURE);
        writeFile(tmp, '.cache/junk.js', 'x', FUTURE);
        const newest = new Freshness().getNewestMtime(tmp);
        // PAST mtime ± fs precision; just confirm it's not the FUTURE one
        assert.ok(newest < FUTURE);
    } finally { cleanup(tmp); }
});

test('custom sources/outputs are honored', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'app/main.js', 'a', FUTURE);
        writeFile(tmp, 'out/main.js', 'a', PAST);
        const f = new Freshness({ sources: ['app'], outputs: ['out'] });
        assert.equal(f.needsBuild(tmp), true);
    } finally { cleanup(tmp); }
});
