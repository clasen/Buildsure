#!/usr/bin/env node
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import BuildSure, { ProjectScanner } from '../index.js';

const HELP = `buildsure - install + build only when needed

Usage:
  buildsure [path]                       Ensure a project (or every subproject if [path] has no package.json)
  buildsure --check [path]               Show status without executing
  buildsure --pm <auto|pnpm|npm|yarn|bun>   Force package manager (default: auto)
  buildsure --script <name>              Script to run (default: build)
  buildsure --quiet                      Suppress per-project log lines
  buildsure --help                       This help

Resolution priority for --pm auto: forced > lockfile > preferred list (pnpm, npm).`;

function parseArgs(argv) {
    const args = { _: [], check: false, pm: 'auto', script: 'build', quiet: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '-h':
            case '--help': args.help = true; break;
            case '-c':
            case '--check': args.check = true; break;
            case '--pm': args.pm = argv[++i]; break;
            case '-s':
            case '--script': args.script = argv[++i]; break;
            case '-q':
            case '--quiet': args.quiet = true; break;
            default: args._.push(a);
        }
    }
    return args;
}

function printSummary(result) {
    console.log('═'.repeat(50));
    console.log('Summary:');
    console.log(`  built:      ${result.successful.length}`);
    console.log(`  up-to-date: ${result.upToDate.length}`);
    console.log(`  skipped:    ${result.skipped.length}`);
    console.log(`  failed:     ${result.failed.length}`);
    if (result.failed.length) {
        console.log('\nFailed:');
        for (const f of result.failed) {
            console.log(`  - ${f.project} (${f.phase}): ${f.error?.message ?? 'unknown'}`);
        }
    }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }

const target = resolve(args._[0] ?? '.');
if (!existsSync(target)) {
    console.error(`buildsure: path not found: ${target}`);
    process.exit(2);
}

const bs = new BuildSure({
    packageManager: args.pm,
    buildScript: args.script,
    verbose: !args.quiet,
});

const isProject = existsSync(join(target, 'package.json'));

if (args.check) {
    const report = isProject
        ? bs.check(target)
        : ProjectScanner.listProjects(target, { buildScript: args.script }).map(p => ({
            name: p.name,
            ...(p.valid ? bs.check(p.path) : { valid: false, skipReason: p.skipReason }),
        }));
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
}

if (isProject) {
    const r = await bs.ensure(target);
    process.exit(r.status === 'failed' ? 1 : 0);
} else {
    const result = await bs.ensureAll(target);
    printSummary(result);
    process.exit(result.failed.length ? 1 : 0);
}
