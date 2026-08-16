import { posix } from 'node:path';
const IMPACT_RANK = Object.freeze({
    ignore: 0,
    'config-hmr': 1,
    'server-hmr': 2,
    'client-hmr': 3,
    'full-restart': 4,
});
const ACTION_RANK = Object.freeze({
    'dependency-install': 0,
    build: 1,
    'client-watch': 2,
    'config-hmr': 3,
    'server-hmr': 4,
    'full-restart': 5,
});
const BUILD_CONFIG = /^(?:package\.json|pnpm-workspace\.yaml|(?:tsconfig(?:\.[^/]+)?\.json)|(?:tsdown|vite|rollup|webpack)\.config\.[cm]?[jt]s)$/i;
const CORDIS_PATCH = /^cordis\.patch\.ya?ml$/i;
function hasUnsafeRelativeShape(path) {
    return path.length === 0
        || path === '.'
        || path === '..'
        || path.startsWith('/')
        || /^[A-Za-z]:\//.test(path)
        || path.includes('\\')
        || path.includes('\0')
        || posix.normalize(path) !== path
        || path.split('/').includes('..');
}
function hasUnsafeEncodedForm(path) {
    let current = path;
    for (let depth = 0; depth <= path.length && current.includes('%'); depth += 1) {
        if (/%(?:2f|5c)/i.test(current))
            return true;
        let decoded;
        try {
            decoded = decodeURIComponent(current);
        }
        catch {
            return true;
        }
        if (decoded === current)
            return false;
        if (hasUnsafeRelativeShape(decoded))
            return true;
        current = decoded;
    }
    return /%(?:2f|5c)/i.test(current);
}
function assertRelativePath(path) {
    if (hasUnsafeRelativeShape(path) || hasUnsafeEncodedForm(path)) {
        throw new TypeError(`change path must be a POSIX normalized relative path: ${path}`);
    }
}
function descriptorPathStyle(path) {
    return /^[A-Za-z]:[\\/]/.test(path) || /^(?:\\\\|\/\/)/.test(path)
        ? 'windows'
        : 'posix';
}
function normalizeDescriptorPath(path, style) {
    const slashed = path.replaceAll('\\', '/');
    const trimmed = slashed.length > 1
        && slashed.endsWith('/')
        && !/^[A-Za-z]:\/$/.test(slashed)
        ? slashed.slice(0, -1)
        : slashed;
    return style === 'windows' ? trimmed.toLowerCase() : trimmed;
}
function descriptorRelative(root, absolute) {
    const style = descriptorPathStyle(root);
    if (descriptorPathStyle(absolute) !== style)
        return undefined;
    const normalizedRoot = normalizeDescriptorPath(root, style);
    const normalizedAbsolute = normalizeDescriptorPath(absolute, style);
    if (normalizedAbsolute === normalizedRoot)
        return '';
    const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
    return normalizedAbsolute.startsWith(prefix)
        ? normalizedAbsolute.slice(prefix.length)
        : undefined;
}
function sameDescriptorPath(left, right) {
    const style = descriptorPathStyle(left);
    return descriptorPathStyle(right) === style
        && normalizeDescriptorPath(left, style) === normalizeDescriptorPath(right, style);
}
function descriptorPaths(project, paths) {
    return paths
        .map(path => descriptorRelative(project.root, path))
        .filter((path) => path !== undefined);
}
function comparablePathForRoot(root, path) {
    return descriptorPathStyle(root) === 'windows' ? path.toLowerCase() : path;
}
function comparableProjectPath(project, path) {
    return comparablePathForRoot(project.root, path);
}
function isWithin(path, root) {
    return path === root || path.startsWith(`${root}/`);
}
function isGenerallyIgnored(path) {
    return path === '.git'
        || path.startsWith('.git/')
        || path === 'docs'
        || path.startsWith('docs/')
        || path.includes('/docs/')
        || /(?:^|\/)(?:__tests__|tests?)(?:\/|$)/i.test(path)
        || /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(path)
        || /(?:^|\/)README(?:\.[^/]*)?$/i.test(path)
        || /\.(?:md|mdx)$/i.test(path);
}
function isIgnored(project, path) {
    if (isGenerallyIgnored(path))
        return true;
    const comparable = comparableProjectPath(project, path);
    return descriptorPaths(project, project.outputRoots).some(root => isWithin(comparable, root));
}
function isProfileOrHomePatch(path) {
    if (!CORDIS_PATCH.test(posix.basename(path)))
        return false;
    return path.startsWith('profiles/')
        || path.startsWith('home/')
        || path.startsWith('.dsh/')
        || path.includes('/profiles/');
}
function isRootLockfile(path) {
    return path === 'pnpm-lock.yaml';
}
function isManifest(project, path) {
    const comparable = comparableProjectPath(project, path);
    if (descriptorPaths(project, project.manifests).includes(comparable))
        return true;
    const basename = posix.basename(path);
    return BUILD_CONFIG.test(basename) || CORDIS_PATCH.test(basename);
}
function isServerEntry(project, path) {
    return descriptorPaths(project, project.serverEntries).includes(comparableProjectPath(project, path));
}
function isClientSource(project, path) {
    const comparable = comparableProjectPath(project, path);
    for (const entry of descriptorPaths(project, project.clientEntries)) {
        if (comparable === entry)
            return true;
        const directory = posix.dirname(entry);
        if (posix.basename(entry).startsWith('index.') && isWithin(comparable, directory))
            return true;
    }
    return false;
}
function cloneCommand(command) {
    return {
        executable: command.executable,
        args: [...command.args],
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    };
}
function buildAction(project, impact) {
    if (project.build === undefined)
        return undefined;
    return {
        kind: 'build',
        impact,
        projectId: project.id,
        command: cloneCommand(project.build),
    };
}
function fullRestart(project, path, reason, leading = []) {
    const build = buildAction(project, 'full-restart');
    return [
        ...leading,
        ...(build === undefined ? [] : [build]),
        {
            kind: 'full-restart',
            impact: 'full-restart',
            projectId: project.id,
            path,
            reason,
        },
    ];
}
function dependencyRestart(project, path) {
    const install = {
        kind: 'dependency-install',
        impact: 'full-restart',
        projectId: project.id,
        command: {
            executable: 'pnpm',
            args: ['install', '--frozen-lockfile'],
            cwd: project.workspaceRoot,
        },
    };
    return fullRestart(project, path, 'dependency', [install]);
}
function classifyProjectPath(project, path, ownsWorkspaceRoot) {
    if (isIgnored(project, path))
        return [];
    if (isProfileOrHomePatch(path)) {
        return [{
                kind: 'config-hmr',
                impact: 'config-hmr',
                projectId: project.id,
                path,
            }];
    }
    if (ownsWorkspaceRoot && isRootLockfile(comparableProjectPath(project, path))) {
        return dependencyRestart(project, path);
    }
    if (isManifest(project, path)) {
        return fullRestart(project, path, 'manifest');
    }
    if (project.kind === 'dsh-checkout') {
        return fullRestart(project, path, 'runtime');
    }
    if (isClientSource(project, path)) {
        if (project.devWeb === undefined) {
            return fullRestart(project, path, 'runtime');
        }
        return [{
                kind: 'client-watch',
                impact: 'client-hmr',
                projectId: project.id,
                command: cloneCommand(project.devWeb),
            }];
    }
    if (isServerEntry(project, path)) {
        const build = buildAction(project, 'server-hmr');
        return [
            ...(build === undefined ? [] : [build]),
            {
                kind: 'server-hmr',
                impact: 'server-hmr',
                projectId: project.id,
                path,
            },
        ];
    }
    // Any source or packaging change without a proven HMR route fails closed.
    return fullRestart(project, path, 'runtime');
}
function classifyWorkspacePath(project, path) {
    const comparablePath = comparablePathForRoot(project.workspaceRoot, path);
    if (isRootLockfile(comparablePath))
        return dependencyRestart(project, path);
    const projectRoot = descriptorRelative(project.workspaceRoot, project.root);
    if (projectRoot === '')
        return classifyProjectPath(project, path, true);
    if (projectRoot !== undefined && comparablePath.startsWith(`${projectRoot}/`)) {
        return classifyProjectPath(project, path.slice(projectRoot.length + 1), false);
    }
    if (isGenerallyIgnored(path))
        return [];
    if (isProfileOrHomePatch(path)) {
        return [{
                kind: 'config-hmr',
                impact: 'config-hmr',
                projectId: project.id,
                path,
            }];
    }
    if (isManifest(project, path))
        return fullRestart(project, path, 'manifest');
    return fullRestart(project, path, 'runtime');
}
/** Classify one normalized path relative to its explicit project or workspace root. */
export function classifyChange(projectOrEvent, relativePath, origin = 'project') {
    const event = 'project' in projectOrEvent
        ? projectOrEvent
        : { project: projectOrEvent, path: relativePath, origin };
    if (typeof event.path !== 'string') {
        throw new TypeError('change path must be a POSIX normalized relative path');
    }
    assertRelativePath(event.path);
    const selectedOrigin = event.origin ?? 'project';
    if (selectedOrigin !== 'project' && selectedOrigin !== 'workspace') {
        throw new TypeError(`unsupported change path origin: ${String(selectedOrigin)}`);
    }
    return selectedOrigin === 'workspace'
        ? classifyWorkspacePath(event.project, event.path)
        : classifyProjectPath(event.project, event.path, sameDescriptorPath(event.project.root, event.project.workspaceRoot));
}
function commandKey(command) {
    return `${command.executable}\u0000${command.args.join('\u0000')}\u0000${command.cwd ?? ''}`;
}
function actionKey(action) {
    switch (action.kind) {
        case 'dependency-install':
        case 'build':
        case 'client-watch':
            return `${action.kind}\u0000${commandKey(action.command)}`;
        case 'config-hmr':
        case 'server-hmr':
        case 'full-restart':
            return `${action.kind}\u0000${action.projectId}`;
    }
}
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function actionDetail(action) {
    if ('command' in action)
        return `${action.projectId}\u0000${commandKey(action.command)}`;
    return action.kind === 'full-restart'
        ? `${action.path}\u0000${action.reason}`
        : action.path;
}
function compareActionChoice(left, right) {
    const byProject = compareText(left.projectId, right.projectId);
    if (byProject !== 0)
        return byProject;
    return compareText(actionDetail(left), actionDetail(right));
}
function maxImpact(left, right) {
    return IMPACT_RANK[right] > IMPACT_RANK[left] ? right : left;
}
/** Deduplicate operational work, preserve independent action kinds, and select maximum impact. */
export function mergeActions(actions) {
    let impact = 'ignore';
    const unique = new Map();
    for (const action of actions) {
        impact = maxImpact(impact, action.impact);
        const key = actionKey(action);
        const current = unique.get(key);
        if (current === undefined
            || IMPACT_RANK[action.impact] > IMPACT_RANK[current.impact]
            || (action.impact === current.impact
                && compareActionChoice(action, current) < 0)) {
            unique.set(key, action);
        }
    }
    const merged = [...unique.values()].sort((left, right) => {
        const byKind = ACTION_RANK[left.kind] - ACTION_RANK[right.kind];
        if (byKind !== 0)
            return byKind;
        const byProject = compareText(left.projectId, right.projectId);
        if (byProject !== 0)
            return byProject;
        return compareText(actionDetail(left), actionDetail(right));
    });
    return { impact, actions: merged };
}
//# sourceMappingURL=classifier.js.map