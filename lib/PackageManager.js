import { accessSync, constants, existsSync, statSync } from 'fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'path';
import { execFileSync } from 'child_process';

const LOCKFILE_TO_PM = {
    'pnpm-lock.yaml': 'pnpm',
    'yarn.lock': 'yarn',
    'bun.lockb': 'bun',
    'bun.lock': 'bun',
    'package-lock.json': 'npm',
    'npm-shrinkwrap.json': 'npm',
};

const SUPPORTED = ['pnpm', 'npm', 'yarn', 'bun'];

function escapeCmd(value) {
    if (/[\r\n\0]/.test(value)) {
        throw Object.assign(new Error('Windows batch commands cannot contain NUL or line breaks'), { code: 'EINVAL' });
    }
    return value.replace(/[()[\]%!^"`<>&|;, *?]/g, '^$&');
}

function quoteCmdArgument(value, doubleEscape) {
    let quoted = '"';
    let backslashes = 0;
    for (const char of value) {
        if (char === '\\') {
            backslashes++;
            continue;
        }
        quoted += '\\'.repeat(char === '"' ? backslashes * 2 + 1 : backslashes) + char;
        backslashes = 0;
    }
    quoted += '\\'.repeat(backslashes * 2) + '"';
    const escaped = escapeCmd(quoted);
    // npm's local .cmd shims parse the arguments a second time.
    return doubleEscape ? escapeCmd(escaped) : escaped;
}

function isUnknownInstallScriptsCommand(error) {
    const output = [error.message, error.stdout, error.stderr]
        .filter(Boolean)
        .map(String)
        .join('\n');
    return /Unknown command:?\s*"install-scripts"|EUNKNOWNCOMMAND/i.test(output);
}

function parsePendingInstallScripts(output) {
    const report = JSON.parse(output);
    if (!Array.isArray(report.allowScripts)) {
        throw new Error('Expected an allowScripts array');
    }

    return report.allowScripts.flatMap(({ changes }) => {
        if (!Array.isArray(changes)) {
            throw new Error('Expected each allowScripts entry to contain changes');
        }
        return changes
            .filter(({ change }) => change === 'pending')
            .map(({ key }) => key);
    });
}

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
        this.executablePath = options.packageManagerPath;
        if (this.executablePath !== undefined && (
            typeof this.executablePath !== 'string' || !isAbsolute(this.executablePath) || preference === 'auto'
        )) {
            throw new Error('packageManagerPath must be an absolute path with an explicit packageManager');
        }
        this._available = new Map();
        this._executables = new Map();
        this._probeErrors = new Map();
        // Allow tests to inject process runners so they do not shell out.
        this._exec = options.exec ?? this._defaultExec.bind(this);
        this._capture = options.capture ?? this._defaultCapture.bind(this);
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
                const cause = this._probeErrors.get(this.preference);
                throw new Error(`Package manager '${this.preference}' was not found; set packageManagerPath to its absolute executable path${cause ? `. ${cause.message}` : ''}`, {
                    cause,
                });
            }
            return this.preference;
        }

        const fromLock = PackageManager.detectFromLockfile(projectPath);
        if (fromLock && this.isAvailable(fromLock)) return fromLock;

        for (const pm of this.preferred) {
            if (this.isAvailable(pm)) return pm;
        }

        throw new Error(`No available package manager (tried: ${this.preferred.join(', ')})`, {
            cause: new AggregateError([...this._probeErrors.values()], 'Package manager lookup failed'),
        });
    }

    install(projectPath) {
        const pm = this.resolve(projectPath);
        const args = pm === 'npm' ? this.installArgs : [];
        const [cmd, ...cmdArgs] = PM_COMMANDS[pm].install(args);
        this._exec(cmd, cmdArgs, projectPath);
        if (pm === 'npm') this._assertInstallScriptsReviewed(projectPath);
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
            this._invoke(pm, ['--version'], process.cwd(), ['ignore', 'pipe', 'pipe']);
            return true;
        } catch (error) {
            this._probeErrors.set(pm, error);
            if (error.code === 'ENOENT' && !this._executables.has(pm)) return false;
            throw error;
        }
    }

    _defaultExec(cmd, args, cwd) {
        return this._invoke(cmd, args, cwd, 'inherit');
    }

    _executable(pm) {
        if (this._executables.has(pm)) return this._executables.get(pm);
        const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
        const directories = [...(process.env[pathKey] ?? '').split(delimiter).filter(Boolean), dirname(process.execPath)];
        const extensions = process.platform === 'win32'
            ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
        const candidates = this.executablePath ? [this.executablePath]
            : directories.flatMap(dir => extensions.map(ext => resolve(dir, pm + ext)));
        for (const candidate of candidates) {
            try {
                if (!statSync(candidate).isFile()) continue;
                accessSync(candidate, constants.X_OK);
                this._executables.set(pm, candidate);
                return candidate;
            } catch (error) {
                if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
            }
        }
        throw Object.assign(new Error(`Executable ${this.executablePath ?? pm} was not found`), { code: 'ENOENT' });
    }

    _invoke(pm, args, cwd, stdio) {
        let command = this.executablePath ?? pm;
        try {
            command = this._executable(pm);
            const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
            const env = {
                ...process.env,
                [pathKey]: [dirname(process.execPath), process.env[pathKey]].filter(Boolean).join(delimiter),
                FORCE_COLOR: '1',
            };
            const options = { cwd, stdio, env, encoding: 'utf8' };
            if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
                const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(command);
                const commandLine = [escapeCmd(command), ...args.map(arg => quoteCmdArgument(arg, doubleEscape))].join(' ');
                return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/v:off', '/c', `"${commandLine}"`], {
                    ...options,
                    windowsVerbatimArguments: true,
                });
            }
            return execFileSync(command, args, options);
        } catch (cause) {
            const reason = cause.code ?? cause.signal ?? `exit code ${cause.status}`;
            throw Object.assign(new Error(`Package manager ${cause.path ?? command} failed in ${cwd}: ${reason}`, { cause }), {
                code: cause.code,
                status: cause.status,
                signal: cause.signal,
                stdout: cause.stdout,
                stderr: cause.stderr,
            });
        }
    }

    _assertInstallScriptsReviewed(projectPath) {
        let output;
        try {
            output = this._capture('npm', ['install-scripts', 'ls', '--json'], projectPath);
        } catch (error) {
            if (isUnknownInstallScriptsCommand(error)) return;
            throw error;
        }

        let pending;
        try {
            pending = parsePendingInstallScripts(output);
        } catch (cause) {
            throw new Error('Could not parse `npm install-scripts ls --json` output', { cause });
        }
        if (pending.length === 0) return;

        throw new Error(
            `Unreviewed npm install scripts: ${pending.join(', ')}. `
            + 'Run `npm install-scripts ls`, then `npm install-scripts approve <package>` '
            + 'or `npm install-scripts deny <package>`. After approving, run `npm rebuild`.',
        );
    }

    _defaultCapture(cmd, args, cwd) {
        return this._invoke(cmd, args, cwd, ['ignore', 'pipe', 'pipe']);
    }
}

export default PackageManager;
