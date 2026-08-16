import { describe, expect, it } from 'vitest'

import {
  classifyChange,
  mergeActions,
  type ChangeAction,
  type Impact,
} from '../../src/supervisor/classifier.js'
import type { ProjectDescriptor } from '../../src/supervisor/discovery.js'

const build = {
  executable: 'pnpm',
  args: ['run', 'build'],
  cwd: '/workspace/packages/plugin-a',
} as const
const devWeb = {
  executable: 'pnpm',
  args: ['run', 'dev:web'],
  cwd: '/workspace/packages/plugin-a',
} as const

const plugin: ProjectDescriptor = {
  id: 'linked-plugin:plugin-a',
  kind: 'linked-plugin',
  root: '/workspace/packages/plugin-a',
  workspaceRoot: '/workspace',
  packageName: 'plugin-a',
  serverEntries: ['/workspace/packages/plugin-a/src/index.ts'],
  clientEntries: ['/workspace/packages/plugin-a/src/client/index.tsx'],
  manifests: [
    '/workspace/packages/plugin-a/cordis.patch.yml',
    '/workspace/packages/plugin-a/package.json',
    '/workspace/packages/plugin-a/tsdown.config.ts',
  ],
  build,
  devWeb,
  outputRoots: [
    '/workspace/packages/plugin-a/coverage',
    '/workspace/packages/plugin-a/dist',
    '/workspace/packages/plugin-a/lib',
  ],
}

const dsh: ProjectDescriptor = {
  id: 'dsh-checkout:/checkout',
  kind: 'dsh-checkout',
  root: '/checkout',
  workspaceRoot: '/checkout',
  packageName: 'deepseek-harness',
  serverEntries: ['/checkout/apps/cli/src/index.ts'],
  clientEntries: ['/checkout/apps/web/src/main.tsx'],
  manifests: [
    '/checkout/package.json',
    '/checkout/pnpm-lock.yaml',
    '/checkout/pnpm-workspace.yaml',
  ],
  build: {
    executable: 'pnpm',
    args: ['run', 'build'],
    cwd: '/checkout',
  },
  outputRoots: ['/checkout/apps/web/dist', '/checkout/lib'],
}

function kinds(actions: readonly ChangeAction[]): string[] {
  return actions.map(action => action.kind)
}

interface ClassificationCase {
  readonly name: string
  readonly project: ProjectDescriptor
  readonly path: string
  readonly impact: Impact
  readonly kinds: readonly string[]
}

const cases: readonly ClassificationCase[] = [
  {
    name: 'profile cordis patch delegates to configuration HMR',
    project: dsh,
    path: 'profiles/web/cordis.patch.yml',
    impact: 'config-hmr',
    kinds: ['config-hmr'],
  },
  {
    name: 'home cordis patch delegates to configuration HMR',
    project: dsh,
    path: 'home/cordis.patch.yml',
    impact: 'config-hmr',
    kinds: ['config-hmr'],
  },
  {
    name: 'linked server source builds then waits for server HMR',
    project: plugin,
    path: 'src/index.ts',
    impact: 'server-hmr',
    kinds: ['build', 'server-hmr'],
  },
  {
    name: 'linked client source uses the persistent client watcher',
    project: plugin,
    path: 'src/client/SettingsCard.tsx',
    impact: 'client-hmr',
    kinds: ['client-watch'],
  },
  {
    name: 'package manifest builds then requires a full restart',
    project: plugin,
    path: 'package.json',
    impact: 'full-restart',
    kinds: ['build', 'full-restart'],
  },
  {
    name: 'bundle patch builds then requires a full restart',
    project: plugin,
    path: 'cordis.patch.yml',
    impact: 'full-restart',
    kinds: ['build', 'full-restart'],
  },
  {
    name: 'build configuration builds then requires a full restart',
    project: plugin,
    path: 'tsdown.config.ts',
    impact: 'full-restart',
    kinds: ['build', 'full-restart'],
  },
  {
    name: 'DSH Web Shell runtime source builds then fully restarts',
    project: dsh,
    path: 'apps/web/src/App.tsx',
    impact: 'full-restart',
    kinds: ['build', 'full-restart'],
  },
  {
    name: 'DSH shared package runtime source builds then fully restarts',
    project: dsh,
    path: 'packages/core/agent/src/index.ts',
    impact: 'full-restart',
    kinds: ['build', 'full-restart'],
  },
  {
    name: 'lockfile installs frozen dependencies, builds, then fully restarts',
    project: dsh,
    path: 'pnpm-lock.yaml',
    impact: 'full-restart',
    kinds: ['dependency-install', 'build', 'full-restart'],
  },
  {
    name: 'documentation is ignored',
    project: plugin,
    path: 'docs/architecture.md',
    impact: 'ignore',
    kinds: [],
  },
  {
    name: 'tests are ignored',
    project: plugin,
    path: 'tests/unit/plugin.test.ts',
    impact: 'ignore',
    kinds: [],
  },
  {
    name: 'Git metadata is ignored',
    project: plugin,
    path: '.git/index',
    impact: 'ignore',
    kinds: [],
  },
  {
    name: 'discovered build output is ignored',
    project: plugin,
    path: 'lib/index.js',
    impact: 'ignore',
    kinds: [],
  },
  {
    name: 'unknown linked runtime source fails closed',
    project: plugin,
    path: 'src/runtime/unknown.ts',
    impact: 'full-restart',
    kinds: ['build', 'full-restart'],
  },
]

describe('classifyChange', () => {
  it.each(cases)('$name', ({ project, path, impact, kinds: expectedKinds }) => {
    const plan = mergeActions(classifyChange(project, path))

    expect(plan.impact).toBe(impact)
    expect(kinds(plan.actions)).toEqual(expectedKinds)
  })

  it('creates an argv-only frozen pnpm install for a workspace-root lockfile', () => {
    const plan = mergeActions(classifyChange(plugin, 'pnpm-lock.yaml', 'workspace'))
    const install = plan.actions.find(action => action.kind === 'dependency-install')

    expect(install).toEqual({
      kind: 'dependency-install',
      impact: 'full-restart',
      projectId: plugin.id,
      command: {
        executable: 'pnpm',
        args: ['install', '--frozen-lockfile'],
        cwd: plugin.workspaceRoot,
      },
    })
    expect(install).not.toHaveProperty('shell')
  })

  it('rejects traversal and encoded separator boundaries', () => {
    for (const path of [
      '/absolute.ts',
      '..',
      '../escape.ts',
      'src/../escape.ts',
      'src\\index.ts',
      'src//index.ts',
      '%2e%2e/escape.ts',
      'src%2fescape.ts',
      'src%5cescape.ts',
      'src%252fescape.ts',
      'src/%252e%252e/escape.ts',
    ]) {
      expect(() => classifyChange(plugin, path)).toThrow(/POSIX normalized relative/i)
    }
  })

  it.each([
    'src/plugin.test.ts',
    'src/plugin.spec.tsx',
    'src/__tests__/plugin.ts',
    '__tests__/plugin.ts',
    'src/test/plugin.ts',
    'src/tests/plugin.ts',
    'test/plugin.ts',
    'tests/plugin.ts',
  ])('ignores test source %s', path => {
    expect(mergeActions(classifyChange(plugin, path))).toEqual({
      impact: 'ignore',
      actions: [],
    })
  })

  it('does not mistake runtime names containing test for test directories', () => {
    const plan = mergeActions(classifyChange(plugin, 'src/contest.ts'))

    expect(plan.impact).toBe('full-restart')
    expect(kinds(plan.actions)).toEqual(['build', 'full-restart'])
  })

  it('distinguishes workspace-root lockfiles from project-local lookalikes', () => {
    const workspacePlan = mergeActions(classifyChange({
      project: plugin,
      origin: 'workspace',
      path: 'pnpm-lock.yaml',
    }))
    const projectPlan = mergeActions(classifyChange({
      project: plugin,
      origin: 'project',
      path: 'pnpm-lock.yaml',
    }))
    const nestedWorkspacePlan = mergeActions(classifyChange({
      project: plugin,
      origin: 'workspace',
      path: 'packages/plugin-a/pnpm-lock.yaml',
    }))
    const workspaceProjectSource = mergeActions(classifyChange({
      project: plugin,
      origin: 'workspace',
      path: 'packages/plugin-a/src/index.ts',
    }))
    const unrelatedWorkspaceOutput = mergeActions(classifyChange({
      project: plugin,
      origin: 'workspace',
      path: 'lib/index.js',
    }))

    expect(kinds(workspacePlan.actions)).toEqual([
      'dependency-install',
      'build',
      'full-restart',
    ])
    expect(workspacePlan.actions.find(action => action.kind === 'dependency-install')).toMatchObject({
      command: { cwd: plugin.workspaceRoot },
    })
    expect(kinds(projectPlan.actions)).toEqual(['build', 'full-restart'])
    expect(kinds(nestedWorkspacePlan.actions)).toEqual(['build', 'full-restart'])
    expect(kinds(workspaceProjectSource.actions)).toEqual(['build', 'server-hmr'])
    expect(kinds(unrelatedWorkspaceOutput.actions)).toEqual(['build', 'full-restart'])
  })

  it('defaults legacy two-argument calls to project-relative paths', () => {
    expect(classifyChange(plugin, 'src/index.ts')).toEqual(
      classifyChange({ project: plugin, path: 'src/index.ts' }),
    )
  })

  it('matches Windows drive and UNC descriptor roots case-insensitively at boundaries', () => {
    const windowsDrive: ProjectDescriptor = {
      ...plugin,
      root: 'C:\\Work\\Plugin',
      workspaceRoot: 'c:\\work\\plugin',
      serverEntries: ['c:\\work\\PLUGIN\\src\\index.ts'],
      clientEntries: [],
      manifests: [
        'c:\\work\\plugin\\package.json',
        'c:\\work\\plugin-other\\package.json',
      ],
      outputRoots: ['c:\\work\\plugin\\lib'],
      build: { ...build, cwd: 'C:\\Work\\Plugin' },
    }
    const windowsUnc: ProjectDescriptor = {
      ...windowsDrive,
      root: '\\\\Server\\Share\\Plugin',
      workspaceRoot: '\\\\server\\share\\plugin',
      serverEntries: ['\\\\SERVER\\SHARE\\PLUGIN\\src\\index.ts'],
      manifests: [],
      outputRoots: ['\\\\server\\share\\plugin\\lib'],
    }
    const driveBoundary: ProjectDescriptor = {
      ...windowsDrive,
      serverEntries: ['C:\\Work\\Plugin-other\\src\\index.ts'],
      manifests: ['C:\\Work\\Plugin-other\\custom.manifest'],
      outputRoots: ['C:\\Work\\Plugin-other\\lib'],
    }
    const uncBoundary: ProjectDescriptor = {
      ...windowsUnc,
      serverEntries: ['\\\\Server\\Share\\Plugin-other\\src\\index.ts'],
      outputRoots: ['\\\\Server\\Share\\Plugin-other\\lib'],
    }

    expect(kinds(classifyChange(windowsDrive, 'SRC/INDEX.TS'))).toEqual(['build', 'server-hmr'])
    expect(classifyChange(windowsDrive, 'LIB/INDEX.JS')).toEqual([])
    expect(kinds(classifyChange(windowsDrive, 'PNPM-LOCK.YAML'))).toEqual([
      'dependency-install',
      'build',
      'full-restart',
    ])
    expect(kinds(classifyChange(windowsUnc, 'SRC/INDEX.TS'))).toEqual(['build', 'server-hmr'])
    expect(classifyChange(windowsUnc, 'LIB/INDEX.JS')).toEqual([])
    expect(kinds(classifyChange(driveBoundary, 'src/index.ts'))).toEqual(['build', 'full-restart'])
    expect(kinds(classifyChange(driveBoundary, 'lib/index.js'))).toEqual(['build', 'full-restart'])
    expect(kinds(classifyChange(uncBoundary, 'src/index.ts'))).toEqual(['build', 'full-restart'])
    expect(kinds(classifyChange(uncBoundary, 'lib/index.js'))).toEqual(['build', 'full-restart'])
    expect(
      classifyChange(driveBoundary, 'custom.manifest').find(action => action.kind === 'full-restart'),
    ).toMatchObject({ reason: 'runtime' })
  })

  it('keeps POSIX descriptor matching case-sensitive', () => {
    const posixCase: ProjectDescriptor = {
      ...plugin,
      root: '/Workspace/Plugin',
      workspaceRoot: '/Workspace',
      serverEntries: ['/workspace/plugin/src/index.ts'],
      clientEntries: [],
      manifests: [],
      outputRoots: ['/workspace/plugin/lib'],
      build: { ...build, cwd: '/Workspace/Plugin' },
    }

    expect(kinds(classifyChange(posixCase, 'src/index.ts'))).toEqual(['build', 'full-restart'])
    expect(kinds(classifyChange(posixCase, 'lib/index.js'))).toEqual(['build', 'full-restart'])
  })
})

describe('mergeActions', () => {
  it('uses the exact impact order and retains independent install/build/watch actions', () => {
    const config = classifyChange(dsh, 'profiles/web/cordis.patch.yml')
    const server = classifyChange(plugin, 'src/index.ts')
    const client = classifyChange(plugin, 'src/client/SettingsCard.tsx')
    const lockfile = classifyChange(plugin, 'pnpm-lock.yaml', 'workspace')
    const plan = mergeActions([
      ...config,
      ...server,
      ...client,
      ...lockfile,
      ...lockfile,
      ...client,
      ...server,
    ])

    expect(plan.impact).toBe('full-restart')
    expect(kinds(plan.actions)).toEqual([
      'dependency-install',
      'build',
      'client-watch',
      'config-hmr',
      'server-hmr',
      'full-restart',
    ])
    expect(plan.actions.filter(action => action.kind === 'dependency-install')).toHaveLength(1)
    expect(plan.actions.filter(action => action.kind === 'build')).toHaveLength(1)
    expect(plan.actions.filter(action => action.kind === 'client-watch')).toHaveLength(1)
  })

  it('orders impacts as ignore < config-hmr < server-hmr < client-hmr < full-restart', () => {
    const expected: readonly Impact[] = [
      'ignore',
      'config-hmr',
      'server-hmr',
      'client-hmr',
      'full-restart',
    ]
    const config = classifyChange(dsh, 'profiles/web/cordis.patch.yml')
    const server = classifyChange(plugin, 'src/index.ts')
    const client = classifyChange(plugin, 'src/client/index.tsx')
    const restart = classifyChange(plugin, 'package.json')
    const groups = [
      [],
      config,
      [...config, ...server],
      [...config, ...server, ...client],
      [...config, ...server, ...client, ...restart],
    ] as const

    for (let index = 0; index < expected.length; index += 1) {
      expect(mergeActions(groups[index] ?? []).impact).toBe(expected[index])
    }
  })

  it('returns an identical plan for every permutation of equal-key actions', () => {
    const manifest = classifyChange(plugin, 'package.json')
    const runtime = classifyChange(plugin, 'src/runtime/z.ts')
    const watch = classifyChange(plugin, 'src/client/index.tsx')
    const actions: ChangeAction[] = [
      ...manifest,
      ...runtime,
      ...watch,
      {
        kind: 'server-hmr',
        impact: 'server-hmr',
        projectId: plugin.id,
        path: 'src/z.ts',
      },
      {
        kind: 'server-hmr',
        impact: 'server-hmr',
        projectId: plugin.id,
        path: 'src/a.ts',
      },
    ]
    const expected = mergeActions(actions)
    let checked = 0

    function visit(prefix: ChangeAction[], remaining: ChangeAction[]): void {
      if (remaining.length === 0) {
        expect(mergeActions(prefix)).toEqual(expected)
        checked += 1
        return
      }
      for (let index = 0; index < remaining.length; index += 1) {
        const action = remaining[index]
        if (action === undefined) continue
        visit(
          [...prefix, action],
          [...remaining.slice(0, index), ...remaining.slice(index + 1)],
        )
      }
    }

    visit([], actions)
    expect(checked).toBeGreaterThan(1)
    expect(expected.actions.find(action => action.kind === 'full-restart')).toMatchObject({
      path: 'package.json',
      reason: 'manifest',
    })
    expect(expected.actions.find(action => action.kind === 'server-hmr')).toMatchObject({
      path: 'src/a.ts',
    })
  })
})
