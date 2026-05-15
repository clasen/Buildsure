import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const LOCKFILE_TO_PM = {
    'pnpm-lock.yaml': 'pnpm',
    'yarn.lock': 'yarn',
    'bun.lockb': 'bun',
    'bun.lock': 'bun',
    'package-lock.json': 'npm',
    'npm-shrinkwrap.json': 'npm',
};

const SUPPORTED = ['pnpm', 'npm', 'yarn', 'bun'];

// Single source of truth for command shapes (DRY).
// pnpm/yarn/bun include dev deps by default on `install`; npm needs `--include=dev`
// to override `NODE_ENV=production`. Hence `installArgs` only applies to npm.
const PM_COMMANDS = {
    npm: {
        install: (args = []) => ['npm', 'install', ...args],
        run: (script) => ['npm', 'run', script],
    },
    pnpm: {
        install: () => ['pnpm', 'install'],
        run: (script) => ['pnpm', 'run', script],
    },
    yarn: {
        install: () => ['yarn', 'install'],
        run: (script) => ['yarn', script],
    },
    bun: {
        install: () => ['bun', 'install'],
        run: (script) => ['bun', 'run', script],
    },
};

export class PackageManager {
    constructor(options = {}) {
        const preference = options.packageManager ?? 'auto';
        if (preference !== 'auto' && !SUPPORTED.includes(preference)) {
            throw new Error(`Unsupported packageManager '${preference}'. Use one of: auto, ${SUPPORTED.join(', ')}`);
        }
        this.preference = preference;
        this.preferred = options.preferred ?? ['pnpm', 'npm'];
        this.installArgs = options.installArgs ?? ['--include=dev'];
        this._available = new Map();
        // Allow tests to inject a fake exec so we don't actually shell out.
        this._exec = options.exec ?? this._defaultExec.bind(this);
        this._probe = options.probe ?? this._defaultProbe.bind(this);
    }

    static detectFromLockfile(projectPath) {
        for (const [file, pm] of Object.entries(LOCKFILE_TO_PM)) {
            if (existsSync(join(projectPath, file))) return pm;
        }
        return null;
    }

    isAvailable(pm) {
        if (this._available.has(pm)) return this._available.get(pm);
        const ok = this._probe(pm);
        this._available.set(pm, ok);
        return ok;
    }

    /** Resolution priority: forced > lockfile > preference list. */
    resolve(projectPath) {
        if (this.preference !== 'auto') {
            if (!this.isAvailable(this.preference)) {
                throw new Error(`Package manager '${this.preference}' is not installed`);
            }
            return this.preference;
        }

        const fromLock = PackageManager.detectFromLockfile(projectPath);
        if (fromLock && this.isAvailable(fromLock)) return fromLock;

        for (const pm of this.preferred) {
            if (this.isAvailable(pm)) return pm;
        }

        throw new Error(`No available package manager (tried: ${this.preferred.join(', ')})`);
    }

    install(projectPath) {
        const pm = this.resolve(projectPath);
        const args = pm === 'npm' ? this.installArgs : [];
        const [cmd, ...cmdArgs] = PM_COMMANDS[pm].install(args);
        this._exec(cmd, cmdArgs, projectPath);
        return pm;
    }

    runScript(projectPath, script) {
        const pm = this.resolve(projectPath);
        const [cmd, ...cmdArgs] = PM_COMMANDS[pm].run(script);
        this._exec(cmd, cmdArgs, projectPath);
        return pm;
    }

    _defaultProbe(pm) {
        try {
            execSync(`${pm} --version`, { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

    _defaultExec(cmd, args, cwd) {
        execSync([cmd, ...args].join(' '), {
            cwd,
            stdio: 'inherit',
            env: { ...process.env, FORCE_COLOR: '1' },
        });
    }
}

export default PackageManager;
