import { mkdir, realpath } from 'node:fs/promises'
import { dirname, join, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  discoverProjects,
  type DiscoveryWarning,
} from '../../src/supervisor/discovery.js'
import {
  createDshCheckout,
  createLinkedPlugin,
  createTempLayout,
  type TempLayout,
} from '../helpers/temp-layout.js'

const layouts: TempLayout[] = []

async function temporaryLayout(): Promise<TempLayout> {
  const layout = await createTempLayout()
  layouts.push(layout)
  return layout
}

afterEach(async () => {
  await Promise.all(layouts.splice(0).map(layout => layout.cleanup()))
})

function warningKeys(warnings: readonly DiscoveryWarning[]): string[] {
  return warnings.map(warning => `${warning.code}:${warning.path}:${warning.message}`)
}

describe('discoverProjects DSH checkout discovery', () => {
  it('combines explicit, environment, argv, and cwd ancestors then deduplicates real paths', async () => {
    const layout = await temporaryLayout()
    const explicit = layout.path('z-explicit')
    const environment = layout.path('b-environment')
    const argvRoot = layout.path('m-argv')
    const cwdRoot = layout.path('a-cwd')
    await Promise.all([
      createDshCheckout(layout, explicit),
      createDshCheckout(layout, environment),
      createDshCheckout(layout, argvRoot),
      createDshCheckout(layout, cwdRoot),
    ])
    const explicitAlias = layout.path('explicit-alias')
    await layout.symlinkDirectory(explicit, explicitAlias)

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [explicitAlias, explicit],
      env: { DSH_DEV_SOURCE_ROOT: environment },
      argv: [process.execPath, join(argvRoot, 'apps', 'web', 'src', 'main.tsx')],
      cwd: join(cwdRoot, 'apps', 'web', 'src'),
    })

    const expectedRoots = await Promise.all(
      [cwdRoot, environment, argvRoot, explicit].map(root => realpath(root)),
    )
    expect(result.projects.map(project => project.root)).toEqual(expectedRoots.sort())
    expect(result.projects.every(project => project.kind === 'dsh-checkout')).toBe(true)
    expect(result.projects.map(project => project.id)).toEqual(
      result.projects.map(project => project.id).toSorted(),
    )
    expect(result.warnings).toEqual([])
  })

  it('requires all checkout markers and reports a published DSH package as runtime-only', async () => {
    const layout = await temporaryLayout()
    const wrongName = layout.path('wrong-name')
    await createDshCheckout(layout, wrongName, { name: 'not-deepseek-harness' })
    const missingWeb = layout.path('missing-web')
    await layout.writeJson(join(missingWeb, 'package.json'), {
      name: 'deepseek-harness',
      private: true,
    })
    await layout.writeText(join(missingWeb, 'pnpm-workspace.yaml'), 'packages: []\n')

    const runtime = layout.path('published', 'node_modules', '@deepseek-ai', 'dsh')
    await layout.writeJson(join(runtime, 'package.json'), {
      name: '@deepseek-ai/dsh',
      version: '0.1.0-rc.6',
      main: 'lib/bin.js',
    })
    await layout.writeText(join(runtime, 'lib', 'bin.js'), 'export {}\n')

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [wrongName, missingWeb],
      env: {},
      argv: [],
      cwd: layout.root,
      installedDshRoot: runtime,
    })

    expect(result.projects).toEqual([])
    expect(result.runtimeDshRoot).toBe(await realpath(runtime))
    expect(result.warnings.map(warning => warning.code)).toEqual([
      'DSH_RUNTIME_ONLY',
      'INVALID_DSH_SOURCE_ROOT',
      'INVALID_DSH_SOURCE_ROOT',
    ])
    expect(warningKeys(result.warnings)).toEqual(warningKeys(result.warnings).toSorted())
  })
})

describe('discoverProjects linked profile bundles', () => {
  it('resolves workspace, link, file, and external node_modules symlinks relative to the temporary profile', async () => {
    const layout = await temporaryLayout()
    const workspacePlugin = layout.path('plugins', 'workspace-plugin')
    const linkPlugin = layout.path('plugins', 'link-plugin')
    const filePlugin = layout.path('plugins', 'file-plugin')
    const externalPlugin = layout.path('plugins', 'external-plugin')
    await Promise.all([
      createLinkedPlugin(layout, workspacePlugin, { name: '@fixture/workspace' }),
      createLinkedPlugin(layout, linkPlugin, { name: '@fixture/link' }),
      createLinkedPlugin(layout, filePlugin, { name: 'fixture-file' }),
      createLinkedPlugin(layout, externalPlugin, { name: 'fixture-external' }),
    ])

    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: {
        '@fixture/workspace': 'workspace:*',
        '@fixture/link': `link:${join('..', '..', '..', 'plugins', 'link-plugin')}`,
        'fixture-file': `file:${join('..', '..', '..', 'plugins', 'file-plugin')}`,
        'fixture-external': '1.2.3',
        'fixture-duplicate': `link:${join('..', '..', '..', 'plugins', 'link-plugin')}`,
      },
      dsh: {
        profile: {
          bundles: [
            'fixture-external',
            'fixture-file',
            '@fixture/link',
            '@fixture/workspace',
            'fixture-duplicate',
          ],
        },
      },
    })
    await layout.symlinkDirectory(
      workspacePlugin,
      join(layout.profileRoot, 'node_modules', '@fixture', 'workspace'),
    )
    await layout.symlinkDirectory(
      externalPlugin,
      join(layout.profileRoot, 'node_modules', 'fixture-external'),
    )

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })

    expect(result.projects.map(project => project.packageName)).toEqual([
      'fixture-external',
      'fixture-file',
      '@fixture/link',
      '@fixture/workspace',
    ])
    const expectedRoots = await Promise.all(
      [linkPlugin, workspacePlugin, externalPlugin, filePlugin].map(path => realpath(path)),
    )
    expect(result.projects.map(project => project.root)).toEqual(expectedRoots.sort())
    expect(new Set(result.projects.map(project => project.root)).size).toBe(4)
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'PACKAGE_NAME_MISMATCH',
        message: expect.stringContaining('fixture-duplicate'),
      }),
    ])
  })

  it('derives entries, manifests, workspace, output roots, and argv-only build commands', async () => {
    const layout = await temporaryLayout()
    const workspace = layout.path('plugin-workspace')
    const plugin = join(workspace, 'packages', 'plugin-a')
    await layout.writeText(join(workspace, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
    await createLinkedPlugin(layout, plugin, {
      name: 'plugin-a',
      client: true,
      devWeb: true,
      patch: 'bundle.patch.yml',
    })
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: {
        'plugin-a': `link:${join('..', '..', '..', 'plugin-workspace', 'packages', 'plugin-a')}`,
      },
      dsh: { profile: { bundles: ['plugin-a'] } },
    })

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })
    const descriptor = result.projects[0]
    const pluginRoot = await realpath(plugin)
    const workspaceRoot = await realpath(workspace)

    expect(descriptor).toMatchObject({
      id: expect.stringMatching(/^linked-plugin:plugin-a:[a-f0-9]{12}$/),
      kind: 'linked-plugin',
      root: pluginRoot,
      workspaceRoot,
      packageName: 'plugin-a',
      build: { executable: 'pnpm', args: ['run', 'build'], cwd: pluginRoot },
      devWeb: { executable: 'pnpm', args: ['run', 'dev:web'], cwd: pluginRoot },
    })
    expect(descriptor?.serverEntries).toEqual([join(pluginRoot, 'src', 'index.ts')])
    expect(descriptor?.clientEntries).toEqual([join(pluginRoot, 'src', 'client', 'index.tsx')])
    expect(descriptor?.manifests).toEqual([
      join(pluginRoot, 'bundle.patch.yml'),
      join(pluginRoot, 'package.json'),
      join(pluginRoot, 'tsconfig.json'),
      join(pluginRoot, 'tsdown.config.ts'),
    ].sort())
    expect(descriptor?.outputRoots).toEqual([
      join(pluginRoot, 'coverage'),
      join(pluginRoot, 'dist'),
      join(pluginRoot, 'lib'),
    ].sort())
  })

  it('sorts projects and structured warnings deterministically while tolerating missing manifests', async () => {
    const layout = await temporaryLayout()
    const missingA = layout.path('plugins', 'missing-a')
    const missingZ = layout.path('plugins', 'missing-z')
    await Promise.all([mkdir(missingA, { recursive: true }), mkdir(missingZ, { recursive: true })])
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: {
        'missing-z': `file:${join('..', '..', '..', 'plugins', 'missing-z')}`,
        'missing-a': `link:${join('..', '..', '..', 'plugins', 'missing-a')}`,
        absent: 'link:../../../plugins/absent',
      },
      dsh: { profile: { bundles: ['missing-z', 'absent', 'missing-a'] } },
    })

    const first = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })
    const second = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })

    expect(first.projects).toEqual([])
    expect(first).toEqual(second)
    expect(first.warnings.map(warning => warning.code)).toEqual([
      'LOCAL_BUNDLE_MISSING',
      'PACKAGE_MANIFEST_MISSING',
      'PACKAGE_MANIFEST_MISSING',
    ])
    expect(warningKeys(first.warnings)).toEqual(warningKeys(first.warnings).toSorted())
  })
})

describe('discoverProjects hardened package metadata', () => {
  it('accepts checkout markers without requiring private true', async () => {
    const layout = await temporaryLayout()
    const checkout = layout.path('public-checkout')
    await layout.writeJson(join(checkout, 'package.json'), {
      name: 'deepseek-harness',
      private: false,
      scripts: { build: 'pnpm build:all' },
    })
    await layout.writeText(join(checkout, 'pnpm-workspace.yaml'), 'packages: []\n')
    await layout.writeText(join(checkout, 'apps', 'web', 'src', 'main.tsx'), 'export {}\n')

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [checkout],
      env: {},
      argv: [],
      cwd: layout.root,
    })

    expect(result.projects).toHaveLength(1)
    expect(result.projects[0]?.kind).toBe('dsh-checkout')
    expect(result.warnings).toEqual([])
  })

  it('derives safe existing server and client entries from main, exports, and dsh client metadata', async () => {
    const layout = await temporaryLayout()
    const plugin = layout.path('plugins', 'metadata-plugin')
    const outsideServer = layout.path('outside-entry-root', 'server.ts')
    const outsideClient = layout.path('outside-client.tsx')
    const outsidePatch = layout.path('outside.patch.yml')
    await Promise.all([
      layout.writeText(join(plugin, 'source', 'main.ts'), 'export {}\n'),
      layout.writeText(join(plugin, 'build', 'server.mjs'), 'export {}\n'),
      layout.writeText(join(plugin, 'source', 'conditional.ts'), 'export {}\n'),
      layout.writeText(join(plugin, 'ui', 'entry.tsx'), 'export {}\n'),
      layout.writeText(join(plugin, 'build', 'client.js'), 'export {}\n'),
      layout.writeText(join(plugin, 'src', 'index.ts'), 'export {}\n'),
      layout.writeText(join(plugin, 'src', 'client', 'index.tsx'), 'export {}\n'),
      layout.writeText(outsideServer, 'export {}\n'),
      layout.writeText(outsideClient, 'export {}\n'),
      layout.writeText(outsidePatch, '- insert: []\n'),
    ])
    await layout.symlinkDirectory(dirname(outsideServer), join(plugin, 'linked'))
    await layout.writeJson(join(plugin, 'package.json'), {
      name: 'metadata-plugin',
      main: '.\\source\\main.ts',
      exports: {
        '.': [
          {
            import: './build/server.mjs',
            source: ['./source/conditional.ts', './linked/server.ts'],
          },
          '../outside-server.ts',
        ],
        './client': {
          browser: ['./build/client.js', '../outside-client.tsx'],
        },
      },
      dsh: {
        bundle: { patch: '../outside.patch.yml' },
        client: {
          platform: 'web',
          entry: './ui/entry.tsx',
          inject: ['@deepseek-ai/dsh-client-runtime'],
        },
      },
    })
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: {
        'metadata-plugin': 'link:../../../plugins/metadata-plugin',
      },
      dsh: { profile: { bundles: ['metadata-plugin'] } },
    })

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })
    const descriptor = result.projects[0]
    const root = await realpath(plugin)

    expect(descriptor?.serverEntries).toEqual([
      join(root, 'build', 'server.mjs'),
      join(root, 'source', 'conditional.ts'),
      join(root, 'source', 'main.ts'),
      join(root, 'src', 'index.ts'),
    ].sort())
    expect(descriptor?.clientEntries).toEqual([
      join(root, 'build', 'client.js'),
      join(root, 'src', 'client', 'index.tsx'),
      join(root, 'ui', 'entry.tsx'),
    ].sort())
    expect(descriptor?.manifests).toEqual([join(root, 'package.json')])
    expect([...descriptor?.serverEntries ?? [], ...descriptor?.clientEntries ?? []])
      .not.toContain(outsideServer)
    expect(descriptor?.manifests).not.toContain(outsidePatch)
  })

  it('checks every dependency for an external node_modules symlink but ignores ordinary installs', async () => {
    const layout = await temporaryLayout()
    const external = layout.path('plugins', 'external-semver')
    const installed = join(layout.profileRoot, 'node_modules', 'ordinary-install')
    await Promise.all([
      createLinkedPlugin(layout, external, { name: 'external-semver' }),
      createLinkedPlugin(layout, installed, { name: 'ordinary-install' }),
    ])
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: {
        'external-semver': '^1.2.3',
        'ordinary-install': '^4.5.6',
      },
      dsh: { profile: { bundles: [] } },
    })
    await layout.symlinkDirectory(
      external,
      join(layout.profileRoot, 'node_modules', 'external-semver'),
    )

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })

    expect(result.projects.map(project => project.packageName)).toEqual(['external-semver'])
    expect(result.warnings).toEqual([])
  })

  it('rejects unsafe package names and local tarballs without probing escaped package paths', async () => {
    const layout = await temporaryLayout()
    const tarball = layout.path('plugins', 'bundle.tgz')
    await layout.writeText(tarball, 'not a directory\n')
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: {
        '../../escape': '^1.0.0',
        '@scope/../escape': '^1.0.0',
        tarball: 'file:../../../plugins/bundle.tgz',
      },
      dsh: { profile: { bundles: ['../../escape', '@scope/../escape', 'tarball'] } },
    })

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })

    expect(result.projects).toEqual([])
    expect(result.warnings.map(warning => warning.code)).toEqual([
      'INVALID_PACKAGE_NAME',
      'INVALID_PACKAGE_NAME',
      'LOCAL_BUNDLE_NOT_DIRECTORY',
    ])
  })

  it('bounds manifest reads and distinguishes missing manifests from I/O failures', async () => {
    const layout = await temporaryLayout()
    const oversized = layout.path('plugins', 'oversized')
    const unreadable = layout.path('plugins', 'unreadable')
    const missing = layout.path('plugins', 'missing')
    await Promise.all([
      layout.mkdir(oversized),
      layout.mkdir(unreadable),
      layout.mkdir(missing),
      layout.writeText(join(oversized, 'package.json'), `{"padding":"${'x'.repeat(300_000)}"}\n`),
      layout.mkdir(join(unreadable, 'package.json')),
    ])
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: {
        oversized: 'link:../../../plugins/oversized',
        unreadable: 'link:../../../plugins/unreadable',
        missing: 'link:../../../plugins/missing',
      },
      dsh: { profile: { bundles: ['oversized', 'unreadable', 'missing'] } },
    })

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })

    expect(result.warnings.map(warning => warning.code)).toEqual([
      'PACKAGE_MANIFEST_MISSING',
      'PACKAGE_MANIFEST_READ_FAILED',
      'PACKAGE_MANIFEST_TOO_LARGE',
    ])
  })

  it('preserves Windows absolute file specs and handles scoped package paths portably', async () => {
    const layout = await temporaryLayout()
    const windowsPath = win32.join('C:\\', 'plugins', 'missing-plugin')
    const scoped = layout.path('plugins', 'scoped')
    await createLinkedPlugin(layout, scoped, { name: '@scope/scoped' })
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: {
        '@scope/scoped': '^1.0.0',
        'windows-missing': `file:${windowsPath}`,
      },
      dsh: { profile: { bundles: ['windows-missing'] } },
    })
    await layout.symlinkDirectory(
      scoped,
      join(layout.profileRoot, 'node_modules', '@scope', 'scoped'),
    )

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })

    expect(result.projects.map(project => project.packageName)).toEqual(['@scope/scoped'])
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'LOCAL_BUNDLE_MISSING',
        path: windowsPath,
      }),
    ])
  })

  it('resolves a POSIX absolute local file spec without win32 mangling', async () => {
    const layout = await temporaryLayout()
    const absolute = join(layout.root, 'plugins', 'posix-absolute')
    await createLinkedPlugin(layout, absolute, { name: 'posix-absolute' })
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: { 'posix-absolute': `file:${absolute}` },
      dsh: { profile: { bundles: ['posix-absolute'] } },
    })

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })

    expect(result.projects.map(project => project.packageName)).toEqual(['posix-absolute'])
    expect(result.warnings.filter(warning => warning.code === 'LOCAL_BUNDLE_MISSING')).toEqual([])
  })

  it.each(['../escape', '/absolute', '..\\escape'])(
    'rejects an unsafe profile name before reading profile metadata: %s',
    async profile => {
      const layout = await temporaryLayout()
      await expect(discoverProjects({
        dshHome: layout.dshHome,
        profile,
        sourceRoots: [],
        env: {},
        argv: [],
        cwd: layout.root,
      })).rejects.toThrow(/profile/i)
    },
  )

  it('rejects a profile directory whose canonical path escapes the profiles root', async () => {
    const layout = await temporaryLayout()
    const outside = layout.path('outside-profile')
    await layout.writeJson(join(outside, 'package.json'), { dependencies: {} })
    await layout.symlinkDirectory(outside, join(dirname(layout.profileRoot), 'escape'))

    await expect(discoverProjects({
      dshHome: layout.dshHome,
      profile: 'escape',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })).rejects.toThrow(/profile|contain/i)
  })

  it('ignores a candidate whose manifest name does not match the requested package', async () => {
    const layout = await temporaryLayout()
    const plugin = layout.path('plugins', 'mismatch')
    const invalid = layout.path('plugins', 'invalid-name')
    await Promise.all([
      createLinkedPlugin(layout, plugin, { name: 'actual-name' }),
      createLinkedPlugin(layout, invalid, { name: '../unsafe' }),
    ])
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: {
        'invalid-name': 'link:../../../plugins/invalid-name',
        'requested-name': 'link:../../../plugins/mismatch',
      },
      dsh: { profile: { bundles: ['invalid-name', 'requested-name'] } },
    })

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })

    expect(result.projects).toEqual([])
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'PACKAGE_NAME_MISMATCH' }),
      expect.objectContaining({ code: 'PACKAGE_NAME_MISMATCH' }),
    ])
  })

  it('uses deterministic root-derived ids while preserving realpath deduplication', async () => {
    const layout = await temporaryLayout()
    const plugin = layout.path('plugins', 'stable-id')
    const alias = layout.path('plugins', 'stable-id-alias')
    const other = layout.path('plugins', 'stable-id-other')
    await Promise.all([
      createLinkedPlugin(layout, plugin, { name: 'stable-id' }),
      createLinkedPlugin(layout, other, { name: 'stable-id' }),
    ])
    await layout.symlinkDirectory(plugin, alias)
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: {
        'stable-id': 'link:../../../plugins/stable-id',
      },
      dsh: { profile: { bundles: ['stable-id'] } },
    })

    const first = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: {
        'stable-id': 'link:../../../plugins/stable-id-alias',
      },
      dsh: { profile: { bundles: ['stable-id'] } },
    })
    const second = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: {
        'stable-id': 'link:../../../plugins/stable-id-other',
      },
      dsh: { profile: { bundles: ['stable-id'] } },
    })
    const third = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })

    expect(first.projects).toHaveLength(1)
    expect(second.projects).toHaveLength(1)
    expect(third.projects).toHaveLength(1)
    expect(first.projects[0]?.id).toBe(second.projects[0]?.id)
    expect(first.projects[0]?.id).toMatch(/^linked-plugin:stable-id:[a-f0-9]{12}$/)
    expect(third.projects[0]?.id).toMatch(/^linked-plugin:stable-id:[a-f0-9]{12}$/)
    expect(third.projects[0]?.id).not.toBe(first.projects[0]?.id)
  })

  it('treats workspace semver ranges as node_modules specs, not local paths', async () => {
    const layout = await temporaryLayout()
    const caret = layout.path('plugins', 'workspace-caret')
    const tilde = layout.path('plugins', 'workspace-tilde')
    const local = layout.path('plugins', 'workspace-local')
    await Promise.all([
      createLinkedPlugin(layout, caret, { name: 'workspace-caret' }),
      createLinkedPlugin(layout, tilde, { name: 'workspace-tilde' }),
      createLinkedPlugin(layout, local, { name: 'workspace-local' }),
    ])
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: {
        'workspace-caret': 'workspace:^1.2.3',
        'workspace-local': 'workspace:../../../plugins/workspace-local',
        'workspace-tilde': 'workspace:~1.2.3',
      },
      dsh: { profile: { bundles: ['workspace-caret', 'workspace-local', 'workspace-tilde'] } },
    })
    await Promise.all([
      layout.symlinkDirectory(caret, join(layout.profileRoot, 'node_modules', 'workspace-caret')),
      layout.symlinkDirectory(tilde, join(layout.profileRoot, 'node_modules', 'workspace-tilde')),
    ])

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })

    expect(result.projects.map(project => project.packageName)).toEqual([
      'workspace-caret',
      'workspace-local',
      'workspace-tilde',
    ])
    expect(result.warnings).toEqual([])
  })

  it('does not claim an unrelated or empty ancestor workspace', async () => {
    const layout = await temporaryLayout()
    const workspace = layout.path('workspace')
    const unrelated = join(workspace, 'other', 'plugin-a')
    const empty = join(workspace, 'empty', 'plugin-b')
    await layout.writeText(join(workspace, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
    await createLinkedPlugin(layout, unrelated, { name: 'plugin-a' })
    await createLinkedPlugin(layout, empty, { name: 'plugin-b' })
    await layout.writeText(join(workspace, 'empty', 'pnpm-workspace.yaml'), 'sharedWorkspaceLockfile: true\n')
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: {
        'plugin-a': 'link:../../../workspace/other/plugin-a',
        'plugin-b': 'link:../../../workspace/empty/plugin-b',
      },
      dsh: { profile: { bundles: ['plugin-a', 'plugin-b'] } },
    })

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })

    expect(result.projects.map(project => project.workspaceRoot)).toEqual([
      await realpath(unrelated),
      await realpath(empty),
    ].sort())
  })

  it('rejects oversized candidate names with bounded diagnostics', async () => {
    const layout = await temporaryLayout()
    const oversizedName = 'x'.repeat(1_000)
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies: { [oversizedName]: '^1.0.0' },
      dsh: { profile: { bundles: [oversizedName] } },
    })

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })

    expect(result.projects).toEqual([])
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'INVALID_PACKAGE_NAME' }),
    ])
    expect(result.warnings[0]?.path.length).toBeLessThanOrEqual(512)
  })

  it('bounds workspace config and profile candidate work with structured warnings', async () => {
    const layout = await temporaryLayout()
    const workspace = layout.path('oversized-workspace')
    const plugin = join(workspace, 'packages', 'plugin')
    await createLinkedPlugin(layout, plugin, { name: 'bounded-plugin' })
    await layout.writeText(join(workspace, 'pnpm-workspace.yaml'), `packages:\n  - '${'x'.repeat(300_000)}'\n`)

    const dependencies = Object.fromEntries([
      ['bounded-plugin', 'link:../../../oversized-workspace/packages/plugin'],
      ['long-spec', `link:${'x'.repeat(20_000)}`],
      ...Array.from({ length: 300 }, (_, index) => [`candidate-${String(index).padStart(3, '0')}`, '^1.0.0']),
    ])
    const bundles = Array.from({ length: 300 }, (_, index) => `bundle-${String(index).padStart(3, '0')}`)
    await layout.writeJson(join(layout.profileRoot, 'package.json'), {
      dependencies,
      dsh: { profile: { bundles } },
    })

    const result = await discoverProjects({
      dshHome: layout.dshHome,
      profile: 'web',
      sourceRoots: [],
      env: {},
      argv: [],
      cwd: layout.root,
    })

    expect(result.projects).toHaveLength(1)
    expect(result.projects[0]?.workspaceRoot).toBe(await realpath(plugin))
    expect(result.warnings.map(warning => warning.code)).toEqual(expect.arrayContaining([
      'DEPENDENCY_SPEC_TOO_LONG',
      'PROFILE_BUNDLES_LIMIT_EXCEEDED',
      'PROFILE_CANDIDATES_LIMIT_EXCEEDED',
      'PROFILE_DEPENDENCIES_LIMIT_EXCEEDED',
      'WORKSPACE_CONFIG_TOO_LARGE',
    ]))
  })
})
