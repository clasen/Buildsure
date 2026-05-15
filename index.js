import { existsSync } from 'fs';
import { basename } from 'path';
import { Freshness } from './lib/Freshness.js';
import { PackageManager } from './lib/PackageManager.js';
import { ProjectScanner } from './lib/ProjectScanner.js';

const noop = () => {};

export class BuildSure {
    constructor(options = {}) {
        this.options = options;
        this.buildScript = options.buildScript ?? 'build';
        this.freshness = options.freshness ?? new Freshness(options);
        this.pm = options.pm ?? new PackageManager(options);

        const verbose = options.verbose ?? false;
        this.onLog = options.onLog ?? (verbose ? (msg) => console.log(msg) : noop);
        this.onProgress = options.onProgress ?? noop;
    }

    /** Pure inspection — never executes install/build. */
    check(projectPath) {
        const exists = existsSync(projectPath);
        const hasBuildScript = exists && ProjectScanner.hasScript(projectPath, this.buildScript);
        return {
            path: projectPath,
            exists,
            hasBuildScript,
            needsInstall: exists && this.freshness.needsInstall(projectPath),
            needsBuild: hasBuildScript && this.freshness.needsBuild(projectPath),
            packageManager: exists ? this._safeResolve(projectPath) : null,
        };
    }

    async ensure(projectPath) {
        const name = basename(projectPath);

        if (!existsSync(projectPath)) {
            return this._fail(name, projectPath, 'precheck', new Error(`path does not exist: ${projectPath}`));
        }

        const status = this.check(projectPath);

        // Run install when deps are stale OR a build is needed (the latter ensures
        // dev deps are present, since `NODE_ENV=production` makes npm skip them).
        if (status.needsInstall || status.needsBuild) {
            const installed = await this._runInstall(name, projectPath, status.needsInstall);
            if (installed.status === 'failed') return installed;
        } else {
            this.onLog(`[skip-install] ${name} (dependencies up to date)`);
        }

        if (!status.hasBuildScript) {
            this.onLog(`[skip] ${name} (no '${this.buildScript}' script)`);
            return { project: name, path: projectPath, status: 'skipped', reason: `no ${this.buildScript} script` };
        }

        if (!status.needsBuild) {
            this.onLog(`[up-to-date] ${name}`);
            return { project: name, path: projectPath, status: 'up-to-date' };
        }

        return this._runBuild(name, projectPath);
    }

    async ensureAll(rootPath) {
        const projects = ProjectScanner.listProjects(rootPath, { buildScript: this.buildScript });
        const result = { successful: [], failed: [], skipped: [], upToDate: [] };

        for (const project of projects) {
            if (!project.valid) {
                this.onLog(`[skip] ${project.name} (${project.skipReason})`);
                result.skipped.push({ project: project.name, reason: project.skipReason });
                continue;
            }
            const r = await this.ensure(project.path);
            this._collect(result, r);
        }
        return result;
    }

    _runInstall(name, projectPath, depsStale) {
        const reason = depsStale ? 'deps stale' : 'ensuring dev deps for build';
        this.onLog(`[install] ${name} (${reason})`);
        this.onProgress({ project: name, phase: 'install', status: 'start' });
        try {
            const pm = this.pm.install(projectPath);
            this.onProgress({ project: name, phase: 'install', status: 'done', packageManager: pm });
            return { status: 'ok' };
        } catch (error) {
            this.onLog(`[error] ${name} install failed: ${error.message}`);
            this.onProgress({ project: name, phase: 'install', status: 'failed', error });
            return this._fail(name, projectPath, 'install', error);
        }
    }

    _runBuild(name, projectPath) {
        this.onLog(`[build] ${name}`);
        this.onProgress({ project: name, phase: 'build', status: 'start' });
        try {
            const pm = this.pm.runScript(projectPath, this.buildScript);
            this.onLog(`[done] ${name}`);
            this.onProgress({ project: name, phase: 'build', status: 'done', packageManager: pm });
            return { project: name, path: projectPath, status: 'built', packageManager: pm };
        } catch (error) {
            this.onLog(`[error] ${name} build failed: ${error.message}`);
            this.onProgress({ project: name, phase: 'build', status: 'failed', error });
            return this._fail(name, projectPath, 'build', error);
        }
    }

    _safeResolve(projectPath) {
        try { return this.pm.resolve(projectPath); } catch { return null; }
    }

    _fail(name, path, phase, error) {
        return { project: name, path, status: 'failed', phase, error };
    }

    _collect(result, r) {
        if (r.status === 'built') result.successful.push(r.project);
        else if (r.status === 'up-to-date') result.upToDate.push(r.project);
        else if (r.status === 'failed') result.failed.push(r);
        else if (r.status === 'skipped') result.skipped.push(r);
    }
}

export default BuildSure;
export { Freshness, PackageManager, ProjectScanner };
