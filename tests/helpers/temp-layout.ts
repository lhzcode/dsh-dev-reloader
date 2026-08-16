import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface TempLayout {
  readonly root: string
  readonly dshHome: string
  readonly profileRoot: string
  path(...parts: readonly string[]): string
  mkdir(path: string): Promise<void>
  writeJson(path: string, value: unknown): Promise<void>
  writeText(path: string, value?: string): Promise<void>
  symlinkDirectory(target: string, path: string): Promise<void>
  cleanup(): Promise<void>
}

export async function createTempLayout(profile = 'web'): Promise<TempLayout> {
  // Canonicalize the system temp directory before registering file watchers.
  // Windows runners may expose an 8.3 path (RUNNER~1) while fs events report
  // the long path, which violates libuv's watched-directory prefix invariant.
  const temporaryRoot = await realpath(tmpdir())
  const root = await mkdtemp(join(temporaryRoot, 'dsh-dev-reloader-discovery-'))
  const dshHome = join(root, 'dsh-home')
  const profileRoot = join(dshHome, 'profiles', profile)

  async function ensureParent(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
  }

  return {
    root,
    dshHome,
    profileRoot,
    path: (...parts) => join(root, ...parts),
    mkdir: path => mkdir(path, { recursive: true }).then(() => undefined),
    async writeJson(path, value) {
      await ensureParent(path)
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    },
    async writeText(path, value = '') {
      await ensureParent(path)
      await writeFile(path, value, 'utf8')
    },
    async symlinkDirectory(target, path) {
      await ensureParent(path)
      await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    },
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  }
}

export async function createDshCheckout(
  layout: TempLayout,
  root: string,
  options: { readonly name?: string; readonly build?: boolean } = {},
): Promise<void> {
  await layout.writeJson(join(root, 'package.json'), {
    name: options.name ?? 'deepseek-harness',
    private: true,
    scripts: options.build === false ? {} : { build: 'pnpm build:all' },
  })
  await layout.writeText(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n")
  await layout.writeText(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await layout.writeText(join(root, 'apps', 'web', 'src', 'main.tsx'), 'export {}\n')
}

export async function createLinkedPlugin(
  layout: TempLayout,
  root: string,
  options: {
    readonly name: string
    readonly client?: boolean
    readonly server?: boolean
    readonly build?: boolean
    readonly devWeb?: boolean
    readonly patch?: string
  },
): Promise<void> {
  const patch = options.patch ?? 'cordis.patch.yml'
  await layout.writeJson(join(root, 'package.json'), {
    name: options.name,
    type: 'module',
    main: './lib/index.js',
    exports: {
      '.': './lib/index.js',
      ...(options.client ? { './client': './lib/client.js' } : {}),
    },
    scripts: {
      ...(options.build === false ? {} : { build: 'tsc' }),
      ...(options.devWeb ? { 'dev:web': 'tsdown --watch' } : {}),
    },
    dsh: {
      bundle: { patch: `./${patch}` },
      ...(options.client ? { client: { platform: 'web' } } : {}),
    },
  })
  await layout.writeText(join(root, patch), '- insert: []\n')
  if (options.server !== false) {
    await layout.writeText(join(root, 'src', 'index.ts'), 'export {}\n')
  }
  if (options.client) {
    await layout.writeText(join(root, 'src', 'client', 'index.tsx'), 'export {}\n')
  }
  await layout.writeText(join(root, 'tsconfig.json'), '{}\n')
  await layout.writeText(join(root, 'tsdown.config.ts'), 'export default {}\n')
}
