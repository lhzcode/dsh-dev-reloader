import { createHash } from 'node:crypto'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path'
import picomatch from 'picomatch'
import { parse as parseYaml } from 'yaml'

import { requireSafeProfileName } from '../shared/profile.js'
import type { CommandTemplate } from '../shared/protocol.js'

const DSH_ROOT_PACKAGE_NAMES = new Set([
  'deepseek-harness',
  '@deepseek-ai/deepseek-harness',
])

const MANIFEST_CANDIDATES = [
  'tsconfig.json',
  'tsdown.config.ts',
  'tsdown.config.js',
  'vite.config.ts',
  'vite.config.js',
] as const

const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_WORKSPACE_CONFIG_BYTES = 256 * 1024
const MAX_PROFILE_DEPENDENCIES = 256
const MAX_PROFILE_BUNDLES = 256
const MAX_PROFILE_CANDIDATES = 256
const MAX_DEPENDENCY_SPEC_BYTES = 4 * 1024
const MAX_WORKSPACE_PATTERNS = 256
const MAX_WORKSPACE_PATTERN_BYTES = 4 * 1024
const PACKAGE_NAME_MAX_LENGTH = 214
const PACKAGE_SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/
const textEncoder = new TextEncoder()

export interface ProjectDescriptor {
  readonly id: string
  readonly kind: 'dsh-checkout' | 'linked-plugin'
  readonly root: string
  readonly workspaceRoot: string
  readonly packageName?: string
  readonly serverEntries: readonly string[]
  readonly clientEntries: readonly string[]
  readonly manifests: readonly string[]
  readonly build?: CommandTemplate
  readonly devWeb?: CommandTemplate
  readonly outputRoots: readonly string[]
}

export interface DiscoveryWarning {
  readonly code:
    | 'DEPENDENCY_SPEC_TOO_LONG'
    | 'DSH_RUNTIME_ONLY'
    | 'INVALID_DSH_SOURCE_ROOT'
    | 'INVALID_PACKAGE_NAME'
    | 'LOCAL_BUNDLE_MISSING'
    | 'LOCAL_BUNDLE_NOT_DIRECTORY'
    | 'PACKAGE_MANIFEST_INVALID'
    | 'PACKAGE_MANIFEST_MISSING'
    | 'PACKAGE_MANIFEST_READ_FAILED'
    | 'PACKAGE_MANIFEST_TOO_LARGE'
    | 'PACKAGE_NAME_MISMATCH'
    | 'PROFILE_BUNDLES_LIMIT_EXCEEDED'
    | 'PROFILE_CANDIDATES_LIMIT_EXCEEDED'
    | 'PROFILE_DEPENDENCIES_LIMIT_EXCEEDED'
    | 'PROFILE_MANIFEST_INVALID'
    | 'PROFILE_MANIFEST_READ_FAILED'
    | 'PROFILE_MANIFEST_TOO_LARGE'
    | 'WORKSPACE_CONFIG_INVALID'
    | 'WORKSPACE_CONFIG_READ_FAILED'
    | 'WORKSPACE_CONFIG_TOO_LARGE'
  readonly path: string
  readonly message: string
}

export interface DiscoveryResult {
  readonly projects: readonly ProjectDescriptor[]
  readonly warnings: readonly DiscoveryWarning[]
  readonly runtimeDshRoot?: string
}

export interface DiscoverProjectsOptions {
  readonly dshHome: string
  readonly profile: string
  readonly sourceRoots: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly argv: readonly string[]
  readonly cwd: string
  readonly installedDshRoot?: string
}

interface PackageManifest {
  readonly name?: unknown
  readonly private?: unknown
  readonly main?: unknown
  readonly exports?: unknown
  readonly scripts?: unknown
  readonly dsh?: unknown
}

interface DshPackageConfig {
  readonly bundle?: { readonly patch?: string }
  readonly client?: unknown
  readonly profile?: { readonly bundles?: readonly unknown[] }
}

interface ManifestReadSuccess {
  readonly kind: 'success'
  readonly value: PackageManifest
}

interface ManifestReadFailure {
  readonly kind: 'missing' | 'invalid' | 'io' | 'too-large'
  readonly error?: unknown
}

type ManifestRead = ManifestReadSuccess | ManifestReadFailure

function byText<T>(getText: (value: T) => string): (left: T, right: T) => number {
  return (left, right) => getText(left).localeCompare(getText(right), 'en')
}

function warningKey(warning: DiscoveryWarning): string {
  return `${warning.code}:${warning.path}:${warning.message}`
}

function boundedDiagnosticText(value: string, maxLength = 512): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

async function pathKind(path: string): Promise<'file' | 'directory' | 'missing'> {
  try {
    const info = await stat(path)
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
    return 'missing'
  } catch {
    return 'missing'
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : undefined
}

interface BoundedTextSuccess {
  readonly kind: 'success'
  readonly source: string
}

interface BoundedTextFailure {
  readonly kind: 'missing' | 'io' | 'too-large'
  readonly error?: unknown
}

type BoundedTextRead = BoundedTextSuccess | BoundedTextFailure

async function readBoundedText(path: string, maxBytes: number): Promise<BoundedTextRead> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'missing', error }
      : { kind: 'io', error }
  }

  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      return { kind: 'io', error: new Error('path is not a regular file') }
    }
    if (info.size > maxBytes) return { kind: 'too-large' }
    const bytes = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    if (offset > maxBytes) return { kind: 'too-large' }
    return { kind: 'success', source: bytes.subarray(0, offset).toString('utf8') }
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? { kind: 'missing', error }
      : { kind: 'io', error }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readManifest(path: string): Promise<ManifestRead> {
  const text = await readBoundedText(path, MAX_MANIFEST_BYTES)
  if (text.kind !== 'success') return text

  try {
    const value: unknown = JSON.parse(text.source)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { kind: 'invalid' }
    }
    return { kind: 'success', value: value as PackageManifest }
  } catch (error) {
    return { kind: 'invalid', error }
  }
}

function asDshConfig(manifest: PackageManifest): DshPackageConfig {
  if (manifest.dsh === null || typeof manifest.dsh !== 'object' || Array.isArray(manifest.dsh)) {
    return {}
  }
  return manifest.dsh as DshPackageConfig
}

function asScripts(manifest: PackageManifest): Readonly<Record<string, unknown>> {
  if (
    manifest.scripts === null
    || typeof manifest.scripts !== 'object'
    || Array.isArray(manifest.scripts)
  ) {
    return {}
  }
  return manifest.scripts as Readonly<Record<string, unknown>>
}

async function inspectCheckout(path: string): Promise<PackageManifest | undefined> {
  if (await pathKind(path) !== 'directory') return undefined
  const manifest = await readManifest(join(path, 'package.json'))
  if (manifest.kind !== 'success') return undefined
  if (!DSH_ROOT_PACKAGE_NAMES.has(String(manifest.value.name))) return undefined
  if (await pathKind(join(path, 'pnpm-workspace.yaml')) !== 'file') return undefined
  if (await pathKind(join(path, 'apps', 'web')) !== 'directory') return undefined
  return manifest.value
}

async function canonical(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

async function startingDirectory(path: string, cwd: string): Promise<string | undefined> {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  const canonicalPath = await canonical(absolute)
  if (canonicalPath === undefined) return undefined
  return (await pathKind(canonicalPath)) === 'directory' ? canonicalPath : dirname(canonicalPath)
}

async function findCheckoutAncestor(path: string, cwd: string): Promise<string | undefined> {
  let current = await startingDirectory(path, cwd)
  while (current !== undefined) {
    if (await inspectCheckout(current)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

function commandFor(script: unknown, name: string, cwd: string): CommandTemplate | undefined {
  if (typeof script !== 'string' || script.trim().length === 0) return undefined
  return { executable: 'pnpm', args: ['run', name], cwd }
}

function toPosixRelative(parent: string, child: string): string {
  return relative(parent, child).split(sep).join('/')
}

async function workspaceIncludesProject(
  workspaceRoot: string,
  projectRoot: string,
  warnings: DiscoveryWarning[],
): Promise<boolean> {
  const configPath = join(workspaceRoot, 'pnpm-workspace.yaml')
  const text = await readBoundedText(configPath, MAX_WORKSPACE_CONFIG_BYTES)
  if (text.kind !== 'success') {
    const code = text.kind === 'too-large'
      ? 'WORKSPACE_CONFIG_TOO_LARGE' as const
      : 'WORKSPACE_CONFIG_READ_FAILED' as const
    warnings.push({
      code,
      path: configPath,
      message: text.kind === 'too-large'
        ? `pnpm-workspace.yaml exceeds ${MAX_WORKSPACE_CONFIG_BYTES} bytes`
        : 'pnpm-workspace.yaml could not be read',
    })
    return false
  }

  let value: unknown
  try {
    value = parseYaml(text.source, { maxAliasCount: 50 })
  } catch {
    warnings.push({
      code: 'WORKSPACE_CONFIG_INVALID',
      path: configPath,
      message: 'pnpm-workspace.yaml is not valid bounded YAML metadata',
    })
    return false
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const packages = (value as Readonly<Record<string, unknown>>).packages
  if (!Array.isArray(packages) || packages.length === 0) return false
  if (packages.length > MAX_WORKSPACE_PATTERNS) {
    warnings.push({
      code: 'WORKSPACE_CONFIG_INVALID',
      path: configPath,
      message: `pnpm-workspace.yaml packages exceed the ${MAX_WORKSPACE_PATTERNS} item limit`,
    })
    return false
  }
  if (!packages.every(pattern =>
    typeof pattern === 'string'
    && pattern.length > 0
    && textEncoder.encode(pattern).byteLength <= MAX_WORKSPACE_PATTERN_BYTES
  )) {
    warnings.push({
      code: 'WORKSPACE_CONFIG_INVALID',
      path: configPath,
      message: 'pnpm-workspace.yaml packages must be bounded non-empty string globs',
    })
    return false
  }

  const projectPath = toPosixRelative(workspaceRoot, projectRoot)
  if (projectPath === '' || projectPath.startsWith('../') || projectPath === '..') return false
  const positive = packages.filter(pattern => !(pattern as string).startsWith('!')) as string[]
  const negative = packages
    .filter(pattern => (pattern as string).startsWith('!'))
    .map(pattern => (pattern as string).slice(1))
  try {
    const included = positive.some(pattern => picomatch(pattern, { dot: true })(projectPath))
    return included && !negative.some(pattern => picomatch(pattern, { dot: true })(projectPath))
  } catch {
    warnings.push({
      code: 'WORKSPACE_CONFIG_INVALID',
      path: configPath,
      message: 'pnpm-workspace.yaml contains an invalid packages glob',
    })
    return false
  }
}

async function findWorkspaceRoot(
  projectRoot: string,
  warnings: DiscoveryWarning[],
): Promise<string> {
  const canonicalProjectRoot = await canonical(projectRoot) ?? projectRoot
  const filesystemRoot = parse(canonicalProjectRoot).root
  let current = canonicalProjectRoot
  while (current !== filesystemRoot) {
    const configPath = join(current, 'pnpm-workspace.yaml')
    if (await pathKind(configPath) === 'file') {
      return await workspaceIncludesProject(current, canonicalProjectRoot, warnings)
        ? await canonical(current) ?? current
        : canonicalProjectRoot
    }
    current = dirname(current)
  }
  return canonicalProjectRoot
}

function collectConditionalTargets(value: unknown, targets: Set<string>): void {
  if (typeof value === 'string') {
    targets.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectConditionalTargets(item, targets)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const nested of Object.values(value as Readonly<Record<string, unknown>>)) {
    collectConditionalTargets(nested, targets)
  }
}

function exportTarget(exportsField: unknown, subpath: '.' | './client'): unknown {
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
    return subpath === '.' ? exportsField : undefined
  }
  const record = exportsField as Readonly<Record<string, unknown>>
  const hasSubpathKeys = Object.keys(record).some(key => key.startsWith('.'))
  return hasSubpathKeys ? record[subpath] : subpath === '.' ? exportsField : undefined
}

function collectClientMetadataTargets(client: unknown, targets: Set<string>): void {
  if (typeof client === 'string' || Array.isArray(client)) {
    collectConditionalTargets(client, targets)
    return
  }
  if (client === null || typeof client !== 'object') return
  const record = client as Readonly<Record<string, unknown>>
  for (const key of ['entry', 'source', 'path', 'main', 'module', 'browser', 'import', 'default']) {
    collectConditionalTargets(record[key], targets)
  }
}

function isRuntimeEntry(path: string): boolean {
  return !path.endsWith('.d.ts') && /\.[cm]?[jt]sx?$/i.test(extname(path))
}

function normalizeMetadataPath(candidate: string): string | undefined {
  if (win32.isAbsolute(candidate) && !isAbsolute(candidate)) return undefined
  return sep === '\\'
    ? candidate.replaceAll('/', '\\')
    : candidate.replaceAll('\\', '/')
}

async function safeExistingProjectPaths(
  root: string,
  candidates: Iterable<string>,
  runtimeEntries = false,
): Promise<string[]> {
  const found = new Set<string>()
  for (const candidate of candidates) {
    const normalized = normalizeMetadataPath(candidate)
    if (normalized === undefined || runtimeEntries && !isRuntimeEntry(normalized)) continue
    const absolute = isAbsolute(normalized) ? resolve(normalized) : resolve(root, normalized)
    if (!isWithin(root, absolute)) continue
    const resolvedPath = await canonical(absolute)
    if (
      resolvedPath !== undefined
      && isWithin(root, resolvedPath)
      && await pathKind(resolvedPath) === 'file'
    ) {
      found.add(resolvedPath)
    }
  }
  return [...found].sort()
}

function packageEntryCandidates(
  manifest: PackageManifest,
  dsh: DshPackageConfig,
): { readonly server: Set<string>; readonly client: Set<string> } {
  const server = new Set<string>()
  const client = new Set<string>()
  if (typeof manifest.main === 'string') server.add(manifest.main)
  collectConditionalTargets(exportTarget(manifest.exports, '.'), server)
  collectConditionalTargets(exportTarget(manifest.exports, './client'), client)
  collectClientMetadataTargets(dsh.client, client)
  return { server, client }
}

async function createDshDescriptor(root: string, manifest: PackageManifest): Promise<ProjectDescriptor> {
  const scripts = asScripts(manifest)
  const metadataEntries = packageEntryCandidates(manifest, asDshConfig(manifest))
  const clientEntries = await safeExistingProjectPaths(root, [
    ...metadataEntries.client,
    'apps/web/src/main.tsx',
    'apps/web/src/main.ts',
    'apps/web/src/index.tsx',
    'apps/web/src/index.ts',
  ], true)
  const serverEntries = await safeExistingProjectPaths(root, [
    ...metadataEntries.server,
    'apps/cli/src/bin.ts',
    'apps/cli/src/index.ts',
    'src/index.ts',
  ], true)
  const manifests = await safeExistingProjectPaths(root, [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ])
  const base = {
    id: `dsh-checkout:${root}`,
    kind: 'dsh-checkout' as const,
    root,
    workspaceRoot: root,
    packageName: String(manifest.name),
    serverEntries,
    clientEntries,
    manifests,
    outputRoots: [
      join(root, 'apps', 'web', 'dist'),
      join(root, 'coverage'),
      join(root, 'dist'),
      join(root, 'lib'),
    ].sort(),
  }
  const build = commandFor(scripts.build, 'build', root)
  return build === undefined ? base : { ...base, build }
}

function isValidPackageName(packageName: string): boolean {
  if (packageName.length === 0 || packageName.length > PACKAGE_NAME_MAX_LENGTH) return false
  if (packageName.startsWith('@')) {
    const parts = packageName.split('/')
    return parts.length === 2
      && PACKAGE_SEGMENT.test(parts[0]?.slice(1) ?? '')
      && PACKAGE_SEGMENT.test(parts[1] ?? '')
  }
  return !packageName.includes('/') && PACKAGE_SEGMENT.test(packageName)
}

function profilePackagePath(profileRoot: string, packageName: string): string {
  const segments = packageName.startsWith('@') ? packageName.split('/') : [packageName]
  return join(profileRoot, 'node_modules', ...segments)
}

function isWithin(parent: string, child: string): boolean {
  const childRelative = relative(parent, child)
  return childRelative === ''
    || (!childRelative.startsWith(`..${sep}`) && childRelative !== '..' && !isAbsolute(childRelative))
}

function localSpecPath(spec: string, profileRoot: string): string | undefined {
  const separator = spec.indexOf(':')
  if (separator < 0) return undefined
  const protocol = spec.slice(0, separator)
  const value = spec.slice(separator + 1)
  if (protocol !== 'workspace' && protocol !== 'link' && protocol !== 'file') {
    return undefined
  }
  if (value.length === 0) return undefined
  // Only genuine Windows forms (drive letter or UNC) are win32-absolute. A
  // POSIX absolute path such as `/var/...` must not be routed through
  // `win32.normalize` (that would rewrite `/a/b` into `\a\b`) — it falls
  // through to the POSIX `resolve` below.
  if (/^[A-Za-z]:[\\/]/.test(value) || /^(?:\\\\|\/\/)/.test(value)) return win32.normalize(value)
  if (isAbsolute(value)) return resolve(value)
  if (value.startsWith('//')) return value
  if (
    protocol === 'workspace'
    && !value.startsWith('./')
    && !value.startsWith('../')
    && !value.startsWith('.\\')
    && !value.startsWith('..\\')
  ) {
    return undefined
  }
  return resolve(profileRoot, value)
}

interface ResolvedBundleRoot {
  readonly root?: string
  readonly expectedPath: string
  readonly issue?: 'not-directory'
}

async function resolveBundleRoot(
  packageName: string,
  spec: string | undefined,
  profileRoot: string,
): Promise<ResolvedBundleRoot> {
  const explicit = spec === undefined ? undefined : localSpecPath(spec, profileRoot)
  const expectedPath = explicit ?? profilePackagePath(profileRoot, packageName)
  const resolved = await canonical(expectedPath)
  if (resolved === undefined) return { expectedPath }
  if (await pathKind(resolved) !== 'directory') {
    return { expectedPath, issue: 'not-directory' }
  }

  if (explicit !== undefined) {
    return { root: resolved, expectedPath }
  }

  let link: Awaited<ReturnType<typeof lstat>>
  try {
    link = await lstat(expectedPath)
  } catch {
    return { expectedPath }
  }
  if (!link.isSymbolicLink() || isWithin(profileRoot, resolved)) return { expectedPath }
  return { root: resolved, expectedPath }
}

function linkedProjectId(packageName: string | undefined, root: string): string {
  const rootHash = createHash('sha256').update(root).digest('hex').slice(0, 12)
  return `linked-plugin:${packageName ?? 'anonymous'}:${rootHash}`
}

async function createPluginDescriptor(
  root: string,
  manifest: PackageManifest,
  warnings: DiscoveryWarning[],
): Promise<ProjectDescriptor | undefined> {
  const dsh = asDshConfig(manifest)
  if (dsh.bundle === undefined || typeof dsh.bundle !== 'object') return undefined
  const packageName = typeof manifest.name === 'string' && isValidPackageName(manifest.name)
    ? manifest.name
    : undefined
  const workspaceRoot = await findWorkspaceRoot(root, warnings)
  const scripts = asScripts(manifest)
  const metadataEntries = packageEntryCandidates(manifest, dsh)
  const patch = typeof dsh.bundle.patch === 'string' ? dsh.bundle.patch : undefined
  const manifests = await safeExistingProjectPaths(root, [
    'package.json',
    ...MANIFEST_CANDIDATES,
    ...(patch === undefined ? [] : [patch]),
  ])
  const serverEntries = await safeExistingProjectPaths(root, [
    ...metadataEntries.server,
    'src/index.ts',
    'src/index.tsx',
    'src/index.js',
    'src/index.mjs',
  ], true)
  const hasClientSurface = dsh.client !== undefined
    || exportTarget(manifest.exports, './client') !== undefined
  const clientEntries = hasClientSurface
    ? await safeExistingProjectPaths(root, [
        ...metadataEntries.client,
        'src/client/index.tsx',
        'src/client/index.ts',
        'src/client.tsx',
        'src/client.ts',
      ], true)
    : []
  const id = linkedProjectId(packageName, root)
  const base = {
    id,
    kind: 'linked-plugin' as const,
    root,
    workspaceRoot,
    ...(packageName === undefined ? {} : { packageName }),
    serverEntries,
    clientEntries,
    manifests,
    outputRoots: [join(root, 'coverage'), join(root, 'dist'), join(root, 'lib')].sort(),
  }
  const build = commandFor(scripts.build, 'build', root)
  const devWeb = commandFor(scripts['dev:web'], 'dev:web', root)
  return {
    ...base,
    ...(build === undefined ? {} : { build }),
    ...(devWeb === undefined ? {} : { devWeb }),
  }
}

async function discoverLinkedPlugins(
  profileRoot: string,
  warnings: DiscoveryWarning[],
): Promise<ProjectDescriptor[]> {
  const profileManifestPath = join(profileRoot, 'package.json')
  const profileRead = await readManifest(profileManifestPath)
  if (profileRead.kind !== 'success') {
    if (profileRead.kind === 'invalid') {
      warnings.push({
        code: 'PROFILE_MANIFEST_INVALID',
        path: profileManifestPath,
        message: 'profile package.json is not valid JSON metadata',
      })
    } else if (profileRead.kind === 'io') {
      warnings.push({
        code: 'PROFILE_MANIFEST_READ_FAILED',
        path: profileManifestPath,
        message: 'profile package.json could not be read',
      })
    } else if (profileRead.kind === 'too-large') {
      warnings.push({
        code: 'PROFILE_MANIFEST_TOO_LARGE',
        path: profileManifestPath,
        message: `profile package.json exceeds ${MAX_MANIFEST_BYTES} bytes`,
      })
    }
    return []
  }

  const record = profileRead.value as PackageManifest & {
    readonly dependencies?: unknown
  }
  const rawDependencies = record.dependencies !== null
    && typeof record.dependencies === 'object'
    && !Array.isArray(record.dependencies)
    ? record.dependencies as Readonly<Record<string, unknown>>
    : {}
  const dependencyEntries = Object.entries(rawDependencies)
  if (dependencyEntries.length > MAX_PROFILE_DEPENDENCIES) {
    warnings.push({
      code: 'PROFILE_DEPENDENCIES_LIMIT_EXCEEDED',
      path: profileManifestPath,
      message: `profile dependencies exceed the ${MAX_PROFILE_DEPENDENCIES} item discovery limit`,
    })
  }
  const dependencies: Record<string, unknown> = {}
  for (const [packageName, rawSpec] of dependencyEntries.slice(0, MAX_PROFILE_DEPENDENCIES)) {
    if (
      typeof rawSpec === 'string'
      && textEncoder.encode(rawSpec).byteLength > MAX_DEPENDENCY_SPEC_BYTES
    ) {
      warnings.push({
        code: 'DEPENDENCY_SPEC_TOO_LONG',
        path: boundedDiagnosticText(packageName),
        message: `dependency spec exceeds ${MAX_DEPENDENCY_SPEC_BYTES} bytes`,
      })
      dependencies[packageName] = undefined
    } else {
      dependencies[packageName] = rawSpec
    }
  }

  const dsh = asDshConfig(record)
  const rawBundles = Array.isArray(dsh.profile?.bundles) ? dsh.profile.bundles : []
  if (rawBundles.length > MAX_PROFILE_BUNDLES) {
    warnings.push({
      code: 'PROFILE_BUNDLES_LIMIT_EXCEEDED',
      path: profileManifestPath,
      message: `profile bundles exceed the ${MAX_PROFILE_BUNDLES} item discovery limit`,
    })
  }
  const configuredBundles = rawBundles
    .slice(0, MAX_PROFILE_BUNDLES)
    .filter((value): value is string => typeof value === 'string')
  const allCandidates = [...new Set([
    ...configuredBundles,
    ...Object.keys(dependencies),
  ])].sort()
  if (allCandidates.length > MAX_PROFILE_CANDIDATES) {
    warnings.push({
      code: 'PROFILE_CANDIDATES_LIMIT_EXCEEDED',
      path: profileManifestPath,
      message: `profile candidates exceed the ${MAX_PROFILE_CANDIDATES} item discovery limit`,
    })
  }
  const candidates = allCandidates.slice(0, MAX_PROFILE_CANDIDATES)
  const descriptors = new Map<string, ProjectDescriptor>()

  for (const packageName of candidates) {
    if (!isValidPackageName(packageName)) {
      warnings.push({
        code: 'INVALID_PACKAGE_NAME',
        path: boundedDiagnosticText(packageName),
        message: 'profile dependency or bundle name is not a safe npm package name',
      })
      continue
    }

    const dependency = dependencies[packageName]
    const spec = typeof dependency === 'string' ? dependency : undefined
    const isLocalSpec = spec !== undefined && localSpecPath(spec, profileRoot) !== undefined
    const resolved = await resolveBundleRoot(packageName, spec, profileRoot)
    if (resolved.root === undefined) {
      if (resolved.issue === 'not-directory') {
        warnings.push({
          code: 'LOCAL_BUNDLE_NOT_DIRECTORY',
          path: resolved.expectedPath,
          message: `local bundle ${packageName} is not a directory`,
        })
      } else if (isLocalSpec) {
        warnings.push({
          code: 'LOCAL_BUNDLE_MISSING',
          path: resolved.expectedPath,
          message: `local bundle ${packageName} does not exist`,
        })
      }
      continue
    }

    const manifestPath = join(resolved.root, 'package.json')
    const manifest = await readManifest(manifestPath)
    if (manifest.kind !== 'success') {
      const detail = manifest.kind === 'missing'
        ? {
            code: 'PACKAGE_MANIFEST_MISSING' as const,
            message: `local bundle ${packageName} has no package.json`,
          }
        : manifest.kind === 'invalid'
          ? {
              code: 'PACKAGE_MANIFEST_INVALID' as const,
              message: `local bundle ${packageName} has an invalid package.json`,
            }
          : manifest.kind === 'too-large'
            ? {
                code: 'PACKAGE_MANIFEST_TOO_LARGE' as const,
                message: `local bundle ${packageName} package.json exceeds ${MAX_MANIFEST_BYTES} bytes`,
              }
            : {
                code: 'PACKAGE_MANIFEST_READ_FAILED' as const,
                message: `local bundle ${packageName} package.json could not be read`,
              }
      warnings.push({ ...detail, path: manifestPath })
      continue
    }

    if (
      typeof manifest.value.name !== 'string'
      || !isValidPackageName(manifest.value.name)
      || manifest.value.name !== packageName
    ) {
      warnings.push({
        code: 'PACKAGE_NAME_MISMATCH',
        path: manifestPath,
        message: `local bundle manifest name does not match candidate ${packageName}`,
      })
      continue
    }

    const descriptor = await createPluginDescriptor(resolved.root, manifest.value, warnings)
    if (descriptor !== undefined && !descriptors.has(resolved.root)) {
      descriptors.set(resolved.root, descriptor)
    }
  }

  return [...descriptors.values()].sort(byText(project => project.root))
}

/** Discover buildable DSH checkouts and profile-linked DSH bundles from explicit process facts. */
export async function discoverProjects(options: DiscoverProjectsOptions): Promise<DiscoveryResult> {
  const profile = requireSafeProfileName(options.profile)
  const dshHome = resolve(options.dshHome)
  const profilesRoot = resolve(dshHome, 'profiles')
  const lexicalProfileRoot = resolve(profilesRoot, profile)
  if (!isWithin(profilesRoot, lexicalProfileRoot)) {
    throw new Error('DSH profile root escapes the profiles directory')
  }
  const canonicalProfilesRoot = await canonical(profilesRoot)
  const canonicalProfileRoot = await canonical(lexicalProfileRoot)
  if (
    canonicalProfileRoot !== undefined
    && (
      canonicalProfilesRoot === undefined
      || !isWithin(canonicalProfilesRoot, canonicalProfileRoot)
    )
  ) {
    throw new Error('canonical DSH profile root escapes the profiles directory')
  }
  const profileRoot = canonicalProfileRoot ?? lexicalProfileRoot

  const warnings: DiscoveryWarning[] = []
  const checkoutRoots = new Set<string>()

  for (const configuredRoot of options.sourceRoots) {
    const absolute = isAbsolute(configuredRoot) ? configuredRoot : resolve(options.cwd, configuredRoot)
    const root = await canonical(absolute)
    if (root !== undefined && await inspectCheckout(root)) {
      checkoutRoots.add(root)
    } else {
      warnings.push({
        code: 'INVALID_DSH_SOURCE_ROOT',
        path: root ?? absolute,
        message: 'source root is not a DSH checkout',
      })
    }
  }

  const environmentRoots = options.env.DSH_DEV_SOURCE_ROOT
    ?.split(delimiter)
    .map(root => root.trim())
    .filter(Boolean) ?? []
  for (const environmentRoot of environmentRoots) {
    const absolute = isAbsolute(environmentRoot)
      ? environmentRoot
      : resolve(options.cwd, environmentRoot)
    const root = await canonical(absolute)
    if (root !== undefined && await inspectCheckout(root)) {
      checkoutRoots.add(root)
    } else {
      warnings.push({
        code: 'INVALID_DSH_SOURCE_ROOT',
        path: root ?? absolute,
        message: 'DSH_DEV_SOURCE_ROOT is not a DSH checkout',
      })
    }
  }

  for (const candidate of [options.cwd, ...options.argv]) {
    const root = await findCheckoutAncestor(candidate, options.cwd)
    if (root !== undefined) checkoutRoots.add(root)
  }

  let runtimeDshRoot: string | undefined
  if (options.installedDshRoot !== undefined) {
    const installed = await canonical(options.installedDshRoot)
    if (installed !== undefined) {
      const sourceRoot = await findCheckoutAncestor(installed, options.cwd)
      if (sourceRoot !== undefined) {
        checkoutRoots.add(sourceRoot)
      } else {
        const manifest = await readManifest(join(installed, 'package.json'))
        if (manifest.kind === 'success' && manifest.value.name === '@deepseek-ai/dsh') {
          runtimeDshRoot = installed
          warnings.push({
            code: 'DSH_RUNTIME_ONLY',
            path: installed,
            message: 'installed @deepseek-ai/dsh contains runtime artifacts but no source checkout',
          })
        }
      }
    }
  }

  const dshProjects = await Promise.all(
    [...checkoutRoots]
      .sort()
      .map(async root => createDshDescriptor(root, (await inspectCheckout(root))!)),
  )
  const linkedProjects = await discoverLinkedPlugins(profileRoot, warnings)
  const projectsByRoot = new Map<string, ProjectDescriptor>()
  for (const project of [...dshProjects, ...linkedProjects]) {
    if (!projectsByRoot.has(project.root)) projectsByRoot.set(project.root, project)
  }
  const projects = [...projectsByRoot.values()].sort(byText(project => project.root))
  warnings.sort(byText(warningKey))

  return {
    projects,
    warnings,
    ...(runtimeDshRoot === undefined ? {} : { runtimeDshRoot }),
  }
}
