import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

export class ProjectScanner {
    /** True iff `projectPath/package.json` exists and declares the named script. */
    static hasScript(projectPath, scriptName) {
        const pkgPath = join(projectPath, 'package.json');
        if (!existsSync(pkgPath)) return false;
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            return Boolean(pkg.scripts && pkg.scripts[scriptName]);
        } catch {
            return false;
        }
    }

    /**
     * Lists immediate subdirectories of `rootPath`, classifying each as
     * { valid, name, path, skipReason? } based on the presence of a runnable script.
     */
    static listProjects(rootPath, { buildScript = 'build' } = {}) {
        if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) return [];

        const result = [];
        for (const name of readdirSync(rootPath)) {
            const path = join(rootPath, name);
            try {
                if (!statSync(path).isDirectory()) continue;
            } catch { continue; }

            result.push({ name, path, ...this._classify(path, buildScript) });
        }
        return result;
    }

    static _classify(projectPath, buildScript) {
        const pkgPath = join(projectPath, 'package.json');
        if (!existsSync(pkgPath)) return { valid: false, skipReason: 'no package.json' };

        let pkg;
        try {
            pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        } catch {
            return { valid: false, skipReason: 'invalid package.json' };
        }

        if (!pkg.scripts || !pkg.scripts[buildScript]) {
            return { valid: false, skipReason: `no ${buildScript} script` };
        }
        return { valid: true };
    }
}

export default ProjectScanner;
