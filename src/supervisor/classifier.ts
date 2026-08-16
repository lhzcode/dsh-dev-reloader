import { posix } from 'node:path'

import type { CommandTemplate } from '../shared/protocol.js'
import type { ProjectDescriptor } from './discovery.js'

export type Impact =
  | 'ignore'
  | 'config-hmr'
  | 'server-hmr'
  | 'client-hmr'
  | 'full-restart'

export type ChangePathOrigin = 'project' | 'workspace'

export interface ChangeEvent {
  readonly project: ProjectDescriptor
  /** POSIX-normalized path relative to the selected origin root. */
  readonly path: string
  /** Defaults to project for compatibility with project-root watchers. */
  readonly origin?: ChangePathOrigin
}

interface ActionBase {
  readonly impact: Exclude<Impact, 'ignore'>
  readonly projectId: string
}

export type ChangeAction =
  | (ActionBase & {
      readonly kind: 'dependency-install'
      readonly command: CommandTemplate
    })
  | (ActionBase & {
      readonly kind: 'build'
      readonly command: CommandTemplate
    })
  | (ActionBase & {
      readonly kind: 'client-watch'
      readonly command: CommandTemplate
    })
  | (ActionBase & {
      readonly kind: 'config-hmr'
      readonly path: string
    })
  | (ActionBase & {
      readonly kind: 'server-hmr'
      readonly path: string
    })
  | (ActionBase & {
      readonly kind: 'full-restart'
      readonly path: string
      readonly reason: 'dependency' | 'manifest' | 'runtime'
    })

export interface ChangePlan {
  readonly impact: Impact
  readonly actions: readonly ChangeAction[]
}

const IMPACT_RANK: Readonly<Record<Impact, number>> = Object.freeze({
  ignore: 0,
  'config-hmr': 1,
  'server-hmr': 2,
  'client-hmr': 3,
  'full-restart': 4,
})

const ACTION_RANK: Readonly<Record<ChangeAction['kind'], number>> = Object.freeze({
  'dependency-install': 0,
  build: 1,
  'client-watch': 2,
  'config-hmr': 3,
  'server-hmr': 4,
  'full-restart': 5,
})

const BUILD_CONFIG = /^(?:package\.json|pnpm-workspace\.yaml|(?:tsconfig(?:\.[^/]+)?\.json)|(?:tsdown|vite|rollup|webpack)\.config\.[cm]?[jt]s)$/i
const CORDIS_PATCH = /^cordis\.patch\.ya?ml$/i

function hasUnsafeRelativeShape(path: string): boolean {
  return path.length === 0
    || path === '.'
    || path === '..'
    || path.startsWith('/')
    || /^[A-Za-z]:\//.test(path)
    || path.includes('\\')
    || path.includes('\0')
    || posix.normalize(path) !== path
    || path.split('/').includes('..')
}

function hasUnsafeEncodedForm(path: string): boolean {
  let current = path
  for (let depth = 0; depth <= path.length && current.includes('%'); depth += 1) {
    if (/%(?:2f|5c)/i.test(current)) return true
    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      return true
    }
    if (decoded === current) return false
    if (hasUnsafeRelativeShape(decoded)) return true
    current = decoded
  }
  return /%(?:2f|5c)/i.test(current)
}

function assertRelativePath(path: string): void {
  if (hasUnsafeRelativeShape(path) || hasUnsafeEncodedForm(path)) {
    throw new TypeError(`change path must be a POSIX normalized relative path: ${path}`)
  }
}

type DescriptorPathStyle = 'posix' | 'windows'

function descriptorPathStyle(path: string): DescriptorPathStyle {
  return /^[A-Za-z]:[\\/]/.test(path) || /^(?:\\\\|\/\/)/.test(path)
    ? 'windows'
    : 'posix'
}

function normalizeDescriptorPath(path: string, style: DescriptorPathStyle): string {
  const slashed = path.replaceAll('\\', '/')
  const trimmed = slashed.length > 1
    && slashed.endsWith('/')
    && !/^[A-Za-z]:\/$/.test(slashed)
    ? slashed.slice(0, -1)
    : slashed
  return style === 'windows' ? trimmed.toLowerCase() : trimmed
}

function descriptorRelative(root: string, absolute: string): string | undefined {
  const style = descriptorPathStyle(root)
  if (descriptorPathStyle(absolute) !== style) return undefined
  const normalizedRoot = normalizeDescriptorPath(root, style)
  const normalizedAbsolute = normalizeDescriptorPath(absolute, style)
  if (normalizedAbsolute === normalizedRoot) return ''
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
  return normalizedAbsolute.startsWith(prefix)
    ? normalizedAbsolute.slice(prefix.length)
    : undefined
}

function sameDescriptorPath(left: string, right: string): boolean {
  const style = descriptorPathStyle(left)
  return descriptorPathStyle(right) === style
    && normalizeDescriptorPath(left, style) === normalizeDescriptorPath(right, style)
}

function descriptorPaths(
  project: ProjectDescriptor,
  paths: readonly string[],
): readonly string[] {
  return paths
    .map(path => descriptorRelative(project.root, path))
    .filter((path): path is string => path !== undefined)
}

function comparablePathForRoot(root: string, path: string): string {
  return descriptorPathStyle(root) === 'windows' ? path.toLowerCase() : path
}

function comparableProjectPath(project: ProjectDescriptor, path: string): string {
  return comparablePathForRoot(project.root, path)
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

function isGenerallyIgnored(path: string): boolean {
  return path === '.git'
    || path.startsWith('.git/')
    || path === 'docs'
    || path.startsWith('docs/')
    || path.includes('/docs/')
    || /(?:^|\/)(?:__tests__|tests?)(?:\/|$)/i.test(path)
    || /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(path)
    || /(?:^|\/)README(?:\.[^/]*)?$/i.test(path)
    || /\.(?:md|mdx)$/i.test(path)
}

function isIgnored(project: ProjectDescriptor, path: string): boolean {
  if (isGenerallyIgnored(path)) return true
  const comparable = comparableProjectPath(project, path)
  return descriptorPaths(project, project.outputRoots).some(root => isWithin(comparable, root))
}

function isProfileOrHomePatch(path: string): boolean {
  if (!CORDIS_PATCH.test(posix.basename(path))) return false
  return path.startsWith('profiles/')
    || path.startsWith('home/')
    || path.startsWith('.dsh/')
    || path.includes('/profiles/')
}

function isRootLockfile(path: string): boolean {
  return path === 'pnpm-lock.yaml'
}

function isManifest(project: ProjectDescriptor, path: string): boolean {
  const comparable = comparableProjectPath(project, path)
  if (descriptorPaths(project, project.manifests).includes(comparable)) return true
  const basename = posix.basename(path)
  return BUILD_CONFIG.test(basename) || CORDIS_PATCH.test(basename)
}

function isServerEntry(project: ProjectDescriptor, path: string): boolean {
  return descriptorPaths(project, project.serverEntries).includes(
    comparableProjectPath(project, path),
  )
}

function isClientSource(project: ProjectDescriptor, path: string): boolean {
  const comparable = comparableProjectPath(project, path)
  for (const entry of descriptorPaths(project, project.clientEntries)) {
    if (comparable === entry) return true
    const directory = posix.dirname(entry)
    if (posix.basename(entry).startsWith('index.') && isWithin(comparable, directory)) return true
  }
  return false
}

function cloneCommand(command: CommandTemplate): CommandTemplate {
  return {
    executable: command.executable,
    args: [...command.args],
    ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
  }
}

function buildAction(
  project: ProjectDescriptor,
  impact: Exclude<Impact, 'ignore'>,
): ChangeAction | undefined {
  if (project.build === undefined) return undefined
  return {
    kind: 'build',
    impact,
    projectId: project.id,
    command: cloneCommand(project.build),
  }
}

function fullRestart(
  project: ProjectDescriptor,
  path: string,
  reason: Extract<ChangeAction, { kind: 'full-restart' }>['reason'],
  leading: readonly ChangeAction[] = [],
): ChangeAction[] {
  const build = buildAction(project, 'full-restart')
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
  ]
}

function dependencyRestart(project: ProjectDescriptor, path: string): ChangeAction[] {
  const install: ChangeAction = {
    kind: 'dependency-install',
    impact: 'full-restart',
    projectId: project.id,
    command: {
      executable: 'pnpm',
      args: ['install', '--frozen-lockfile'],
      cwd: project.workspaceRoot,
    },
  }
  return fullRestart(project, path, 'dependency', [install])
}

function classifyProjectPath(
  project: ProjectDescriptor,
  path: string,
  ownsWorkspaceRoot: boolean,
): ChangeAction[] {
  if (isIgnored(project, path)) return []

  if (isProfileOrHomePatch(path)) {
    return [{
      kind: 'config-hmr',
      impact: 'config-hmr',
      projectId: project.id,
      path,
    }]
  }

  if (ownsWorkspaceRoot && isRootLockfile(comparableProjectPath(project, path))) {
    return dependencyRestart(project, path)
  }

  if (isManifest(project, path)) {
    return fullRestart(project, path, 'manifest')
  }

  if (project.kind === 'dsh-checkout') {
    return fullRestart(project, path, 'runtime')
  }

  if (isClientSource(project, path)) {
    if (project.devWeb === undefined) {
      return fullRestart(project, path, 'runtime')
    }
    return [{
      kind: 'client-watch',
      impact: 'client-hmr',
      projectId: project.id,
      command: cloneCommand(project.devWeb),
    }]
  }

  if (isServerEntry(project, path)) {
    const build = buildAction(project, 'server-hmr')
    return [
      ...(build === undefined ? [] : [build]),
      {
        kind: 'server-hmr',
        impact: 'server-hmr',
        projectId: project.id,
        path,
      },
    ]
  }

  // Any source or packaging change without a proven HMR route fails closed.
  return fullRestart(project, path, 'runtime')
}

function classifyWorkspacePath(project: ProjectDescriptor, path: string): ChangeAction[] {
  const comparablePath = comparablePathForRoot(project.workspaceRoot, path)
  if (isRootLockfile(comparablePath)) return dependencyRestart(project, path)

  const projectRoot = descriptorRelative(project.workspaceRoot, project.root)
  if (projectRoot === '') return classifyProjectPath(project, path, true)
  if (projectRoot !== undefined && comparablePath.startsWith(`${projectRoot}/`)) {
    return classifyProjectPath(project, path.slice(projectRoot.length + 1), false)
  }

  if (isGenerallyIgnored(path)) return []
  if (isProfileOrHomePatch(path)) {
    return [{
      kind: 'config-hmr',
      impact: 'config-hmr',
      projectId: project.id,
      path,
    }]
  }
  if (isManifest(project, path)) return fullRestart(project, path, 'manifest')
  return fullRestart(project, path, 'runtime')
}

export function classifyChange(event: ChangeEvent): ChangeAction[]
export function classifyChange(
  project: ProjectDescriptor,
  relativePath: string,
  origin?: ChangePathOrigin,
): ChangeAction[]
/** Classify one normalized path relative to its explicit project or workspace root. */
export function classifyChange(
  projectOrEvent: ProjectDescriptor | ChangeEvent,
  relativePath?: string,
  origin: ChangePathOrigin = 'project',
): ChangeAction[] {
  const event = 'project' in projectOrEvent
    ? projectOrEvent
    : { project: projectOrEvent, path: relativePath, origin }
  if (typeof event.path !== 'string') {
    throw new TypeError('change path must be a POSIX normalized relative path')
  }
  assertRelativePath(event.path)
  const selectedOrigin = event.origin ?? 'project'
  if (selectedOrigin !== 'project' && selectedOrigin !== 'workspace') {
    throw new TypeError(`unsupported change path origin: ${String(selectedOrigin)}`)
  }
  return selectedOrigin === 'workspace'
    ? classifyWorkspacePath(event.project, event.path)
    : classifyProjectPath(
        event.project,
        event.path,
        sameDescriptorPath(event.project.root, event.project.workspaceRoot),
      )
}

function commandKey(command: CommandTemplate): string {
  return `${command.executable}\u0000${command.args.join('\u0000')}\u0000${command.cwd ?? ''}`
}

function actionKey(action: ChangeAction): string {
  switch (action.kind) {
    case 'dependency-install':
    case 'build':
    case 'client-watch':
      return `${action.kind}\u0000${commandKey(action.command)}`
    case 'config-hmr':
    case 'server-hmr':
    case 'full-restart':
      return `${action.kind}\u0000${action.projectId}`
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function actionDetail(action: ChangeAction): string {
  if ('command' in action) return `${action.projectId}\u0000${commandKey(action.command)}`
  return action.kind === 'full-restart'
    ? `${action.path}\u0000${action.reason}`
    : action.path
}

function compareActionChoice(left: ChangeAction, right: ChangeAction): number {
  const byProject = compareText(left.projectId, right.projectId)
  if (byProject !== 0) return byProject
  return compareText(actionDetail(left), actionDetail(right))
}

function maxImpact(left: Impact, right: Impact): Impact {
  return IMPACT_RANK[right] > IMPACT_RANK[left] ? right : left
}

/** Deduplicate operational work, preserve independent action kinds, and select maximum impact. */
export function mergeActions(actions: readonly ChangeAction[]): ChangePlan {
  let impact: Impact = 'ignore'
  const unique = new Map<string, ChangeAction>()

  for (const action of actions) {
    impact = maxImpact(impact, action.impact)
    const key = actionKey(action)
    const current = unique.get(key)
    if (
      current === undefined
      || IMPACT_RANK[action.impact] > IMPACT_RANK[current.impact]
      || (
        action.impact === current.impact
        && compareActionChoice(action, current) < 0
      )
    ) {
      unique.set(key, action)
    }
  }

  const merged = [...unique.values()].sort((left, right) => {
    const byKind = ACTION_RANK[left.kind] - ACTION_RANK[right.kind]
    if (byKind !== 0) return byKind
    const byProject = compareText(left.projectId, right.projectId)
    if (byProject !== 0) return byProject
    return compareText(actionDetail(left), actionDetail(right))
  })

  return { impact, actions: merged }
}
