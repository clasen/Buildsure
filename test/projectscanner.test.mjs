import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectScanner } from '../lib/ProjectScanner.js';
import { makeTmp, cleanup, writeFile, makePackageJson } from './_fixtures.mjs';
import { join } from 'path';

test('hasScript: true when script defined', () => {
    const tmp = makeTmp();
    try {
        makePackageJson(tmp, { build: 'vite build' });
        assert.equal(ProjectScanner.hasScript(tmp, 'build'), true);
    } finally { cleanup(tmp); }
});

test('hasScript: false when script missing', () => {
    const tmp = makeTmp();
    try {
        makePackageJson(tmp, { test: 'jest' });
        assert.equal(ProjectScanner.hasScript(tmp, 'build'), false);
    } finally { cleanup(tmp); }
});

test('hasScript: false when no package.json', () => {
    const tmp = makeTmp();
    try {
        assert.equal(ProjectScanner.hasScript(tmp, 'build'), false);
    } finally { cleanup(tmp); }
});

test('hasScript: false on invalid JSON', () => {
    const tmp = makeTmp();
    try {
        writeFile(tmp, 'package.json', '{not json');
        assert.equal(ProjectScanner.hasScript(tmp, 'build'), false);
    } finally { cleanup(tmp); }
});

test('listProjects: classifies all subdirs and skips non-dir entries', () => {
    const tmp = makeTmp();
    try {
        makePackageJson(join(tmp, 'app-a'), { build: 'vite build' });
        makePackageJson(join(tmp, 'app-b'), { test: 'jest' });
        writeFile(tmp, 'app-c/README.md', 'no pkg here');
        writeFile(tmp, 'standalone-file.txt', 'not a dir');

        const list = ProjectScanner.listProjects(tmp);
        const byName = Object.fromEntries(list.map(p => [p.name, p]));

        // standalone-file.txt is a file, not a directory → not listed
        assert.equal(list.length, 3);
        assert.equal(byName['app-a'].valid, true);
        assert.equal(byName['app-b'].valid, false);
        assert.match(byName['app-b'].skipReason, /no build script/);
        assert.equal(byName['app-c'].valid, false);
        assert.match(byName['app-c'].skipReason, /no package\.json/);
    } finally { cleanup(tmp); }
});

test('listProjects: empty array on missing dir', () => {
    assert.deepEqual(ProjectScanner.listProjects('/nonexistent/path/xyz'), []);
});

test('listProjects: respects custom buildScript name', () => {
    const tmp = makeTmp();
    try {
        makePackageJson(join(tmp, 'app'), { compile: 'tsc' });
        const list = ProjectScanner.listProjects(tmp, { buildScript: 'compile' });
        assert.equal(list[0].valid, true);
    } finally { cleanup(tmp); }
});
