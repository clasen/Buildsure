import { readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const DEFAULT_SOURCES = ['src', 'lib', 'static', 'public', 'index.html', 'package.json'];
const DEFAULT_SOURCE_CONFIG_PREFIXES = ['vite.config', 'svelte.config', 'tailwind.config', 'postcss.config'];
const DEFAULT_OUTPUTS = ['dist', 'build', '.svelte-kit'];
const DEFAULT_PACKAGE_FILES = [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    'bun.lock',
    'npm-shrinkwrap.json',
];
const DEFAULT_IGNORE = ['node_modules', '.git'];
const DEFAULT_MAX_DEPTH = 30;

export class Freshness {
    constructor(options = {}) {
        this.sources = options.sources ?? DEFAULT_SOURCES;
        this.sourceConfigPrefixes = options.sourceConfigPrefixes ?? DEFAULT_SOURCE_CONFIG_PREFIXES;
        this.outputs = options.outputs ?? DEFAULT_OUTPUTS;
        this.packageFiles = options.packageFiles ?? DEFAULT_PACKAGE_FILES;
        this.ignore = options.ignore ?? DEFAULT_IGNORE;
        this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    }

    /** Newest mtime among files reachable under `rootPath` (recurses, skips `ignore` and dotfiles). */
    getNewestMtime(rootPath, { ignore = this.ignore, maxDepth = this.maxDepth } = {}) {
        let newest = 0;
        const scan = (path, depth) => {
            if (depth > maxDepth) return;
            if (!existsSync(path)) return;
            const stat = statSync(path);
            if (stat.isDirectory()) {
                try {
                    for (const name of readdirSync(path)) {
                        if (ignore.includes(name) || name.startsWith('.')) continue;
                        scan(join(path, name), depth + 1);
                    }
                } catch (_) { /* unreadable dir */ }
                return;
            }
            if (stat.isFile() && stat.mtimeMs > newest) newest = stat.mtimeMs;
        };
        scan(rootPath, 0);
        return newest;
    }

    /** Newest mtime among a flat list of file names inside `basePath`. */
    getNewestFileMtime(basePath, files) {
        let newest = 0;
        for (const file of files) {
            const p = join(basePath, file);
            if (existsSync(p)) {
                const m = statSync(p).mtimeMs;
                if (m > newest) newest = m;
            }
        }
        return newest;
    }

    needsInstall(projectPath) {
        const packageJsonPath = join(projectPath, 'package.json');
        const nodeModulesPath = join(projectPath, 'node_modules');

        if (!existsSync(packageJsonPath)) return false;
        if (!existsSync(nodeModulesPath)) return true;

        const packageNewest = this.getNewestFileMtime(projectPath, this.packageFiles);
        if (packageNewest === 0) return false;

        // Most package managers refresh node_modules/.package-lock.json on every install,
        // making it a more reliable "last install" stamp than the directory's own mtime.
        const installLock = join(nodeModulesPath, '.package-lock.json');
        const installStamp = existsSync(installLock)
            ? statSync(installLock).mtimeMs
            : statSync(nodeModulesPath).mtimeMs;

        return packageNewest > installStamp;
    }

    needsBuild(projectPath) {
        let sourceNewest = 0;
        for (const name of this.sources) {
            const p = join(projectPath, name);
            if (!existsSync(p)) continue;
            const m = statSync(p).isDirectory() ? this.getNewestMtime(p) : statSync(p).mtimeMs;
            if (m > sourceNewest) sourceNewest = m;
        }

        try {
            for (const name of readdirSync(projectPath)) {
                // Vite writes vite.config.timestamp-*.mjs files during dev; ignore those.
                const isConfig = this.sourceConfigPrefixes.some(
                    g => name.startsWith(g) && !name.includes('.timestamp-')
                );
                if (!isConfig) continue;
                const m = statSync(join(projectPath, name)).mtimeMs;
                if (m > sourceNewest) sourceNewest = m;
            }
        } catch (_) { /* projectPath unreadable */ }

        let outputNewest = 0;
        let hasOutput = false;
        for (const out of this.outputs) {
            const p = join(projectPath, out);
            if (!existsSync(p)) continue;
            hasOutput = true;
            const m = this.getNewestMtime(p, { ignore: [] });
            if (m > outputNewest) outputNewest = m;
        }

        return !hasOutput || sourceNewest > outputNewest;
    }
}

export default Freshness;
