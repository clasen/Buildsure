# Buildsure

Install + build a Node project (or a folder of projects) **only when sources actually changed**. Auto-detects `pnpm` / `npm` / `yarn` / `bun` per project, with configurable fallback.

Zero dependencies. ESM only.

## Why

`npm run build` is slow and unconditional. `make` works on file timestamps but doesn't know about lockfiles or dev deps. `buildsure` does both: it compares `mtime` of sources vs outputs, and `package.json` vs `node_modules/.package-lock.json`, then runs only what's needed using the right package manager for the project.

## Install

```bash
npm install buildsure
```

## Programmatic API

```js
import BuildSure from 'buildsure';

const bs = new BuildSure({
    packageManager: 'auto',           // 'auto' | 'pnpm' | 'npm' | 'yarn' | 'bun'
    preferred: ['pnpm', 'npm'],       // fallback order in 'auto' mode
    buildScript: 'build',
    verbose: false,
});

// Single project
const r = await bs.ensure('./my-app');
// → { project, path, status: 'built'|'up-to-date'|'skipped'|'failed', ... }

// Every subdirectory with a build script
const result = await bs.ensureAll('./www');
// → { successful: [...], upToDate: [...], skipped: [...], failed: [...] }

// Inspect without executing
const status = bs.check('./my-app');
// → { exists, hasBuildScript, needsInstall, needsBuild, packageManager }
```


Or use directly without installing:

```bash
npx buildsure ./www
```

## CLI

```bash
buildsure [path]                          # Build a project, or every subproject in [path]
buildsure --check [path]                  # Show status without executing (JSON)
buildsure --pm <auto|pnpm|npm|yarn|bun>   # Force package manager (default: auto)
buildsure --pm pnpm --pm-path /opt/pnpm/pnpm ./my-app  # Use an absolute executable path
buildsure --script <name>                 # Script to run (default: build)
buildsure --quiet                         # Suppress per-project log lines
buildsure --help
```

If `[path]` contains a `package.json`, it builds that project. Otherwise it iterates immediate subdirectories that have `package.json` + a `build` script.

## How package manager is resolved

Priority (highest first):

1. **Forced** — `packageManager: 'pnpm'` overrides everything (throws if unavailable).
2. **Lockfile** — `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, `bun.lockb` → `bun`, `package-lock.json` → `npm`.
3. **Preferred list** — first available in `preferred` (default `['pnpm', 'npm']`).

Executables are resolved to absolute paths and reused for the version check,
install, and build. Buildsure searches `PATH`, then the directory of the running
Node executable. Child processes also receive that Node directory in `PATH`, so
Node-based package managers can run when PM2 has a restricted environment.

For an executable in another location, configure its absolute path explicitly:

```js
new BuildSure({
    packageManager: 'pnpm',
    packageManagerPath: '/opt/pnpm/pnpm',
});
```

`packageManagerPath` requires an explicit `packageManager`; it is not used with
`auto`. An invalid explicit path is an error and does not select another executable.
Missing executables are distinguished from permission errors, failed version
checks, and commands terminated by a signal. Execution errors include the
executable, working directory, and code or signal, and preserve the original
error in `cause`. An installed but broken manager stops resolution instead of
silently selecting a different manager. Builds still run through the package
manager's project scripts.

## How "needs build" is decided

`buildsure` compares:

- **Sources**: `src/`, `lib/`, `static/`, `public/`, `index.html`, `package.json`, plus any file in the project root starting with `vite.config`, `svelte.config`, `tailwind.config`, or `postcss.config` (excluding Vite's `.timestamp-*` temp files).
- **Outputs**: `dist/`, `build/`, `.svelte-kit/`.

If any source `mtime` is newer than every output `mtime`, the project needs to build. If no output dir exists at all, it builds.

All of the above lists are configurable:

```js
new BuildSure({
    sources: ['src', 'app', 'index.html'],
    outputs: ['out', 'dist'],
    sourceConfigPrefixes: ['rollup.config'],
    ignore: ['node_modules', '.git', 'coverage'],
});
```

## How "needs install" is decided

`true` if `package.json` is newer than `node_modules/.package-lock.json` (or, if that file is missing, newer than `node_modules/` itself). Lockfiles (`pnpm-lock.yaml`, `yarn.lock`, etc.) are also considered as inputs.

When a build is needed, `buildsure` always runs `install` first, even if deps look fresh. This guards against `NODE_ENV=production` having previously stripped dev dependencies on `npm install`.

### npm install-script approvals

With npm versions that support `allowScripts`, Buildsure checks
`npm install-scripts ls` after installing. npm 11 warns about unreviewed
scripts, while npm 12 blocks them by default; Buildsure treats either result as
a failed install and never continues to the build until the project records an
explicit decision.

Review the pending scripts and record an explicit decision in the project's
`package.json`, then rerun Buildsure:

```bash
npm install-scripts ls
npm install-scripts approve <package>
npm rebuild
# or
npm install-scripts deny <package>
```

`npm rebuild` runs a newly approved script that npm may have skipped during the
preceding install. Approvals are pinned to the installed package version by
default. Buildsure does not approve or deny packages automatically.

## Hooks

```js
new BuildSure({
    onLog: (msg) => myLogger.info(msg),
    onProgress: ({ project, phase, status, packageManager, error }) => {
        // phase: 'install' | 'build'
        // status: 'start' | 'done' | 'failed'
    },
});
```

## Result shape

```js
// ensure(path) returns:
{ project, path, status: 'built',       packageManager: 'pnpm' }
{ project, path, status: 'up-to-date' }
{ project, path, status: 'skipped',     reason: 'no build script' }
{ project, path, status: 'failed',      phase: 'install'|'build', error }

// ensureAll(dir) returns:
{
    successful: ['app-a', 'app-b'],     // names of built projects
    upToDate:   ['app-c'],
    skipped:    [{ project, reason }],
    failed:     [{ project, path, phase, error }],
}
```

## License

MIT
