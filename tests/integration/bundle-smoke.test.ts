import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

import { afterAll, describe, expect, it } from 'vitest'

import { ensureBuiltPackage } from '../helpers/ensure-build.js'

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)))

let tempRoot: string | undefined

afterAll(async () => {
  if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true })
})

describe('bundle smoke (packed tarball)', () => {
  it('packs, inspects, installs, and imports the built artifacts without leaking the repo path', async () => {
    // The bundle smoke packs the BUILT package, so a build is required first.
    await ensureBuiltPackage()

    tempRoot = await mkdtemp(join(tmpdir(), 'dsh-dev-reloader-pack-'))
    const packDir = join(tempRoot, 'pack')
    const installDir = join(tempRoot, 'install')
    await mkdir(packDir, { recursive: true })
    await mkdir(installDir, { recursive: true })

    // 1. Pack the project into the temp destination.
    await run('pnpm', ['pack', '--pack-destination', packDir])
    const packed = (await readdir(packDir)).filter(name => name.endsWith('.tgz'))
    expect(packed.length).toBe(1)
    const tgz = join(packDir, packed[0]!)
    expect((await stat(tgz)).isFile()).toBe(true)

    // 2. Extract the tarball (headless `dsh plugin link` extraction).
    await run('tar', ['-xzf', tgz, '-C', installDir])

    // 3. Inspect package metadata.
    const manifest = JSON.parse(
      await readFile(join(installDir, 'package', 'package.json'), 'utf8'),
    ) as {
      name?: string
      version?: string
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
    }
    expect(manifest.name).toBe('dsh-dev-reloader')
    const repoManifest = JSON.parse(
      await readFile(join(repoRoot, 'package.json'), 'utf8'),
    ) as { version?: string }
    expect(manifest.version).toBe(repoManifest.version)
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')

    // 4. The cordis patch ships inside the bundle.
    const patch = await readFile(join(installDir, 'package', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('dsh-dev-reloader')

    // 5. Import the Host artifact and execute the client's lazy-CJS registration protocol.
    const hostModule = await import(pathToFileURL(join(installDir, 'package', 'lib', 'index.js')).href)
    expect(hostModule.createHostPlugin).toBeTypeOf('function')
    expect(hostModule.default).toBeDefined()

    let registration: {
      id: string
      factory(require: NodeJS.Require): Record<string, unknown>
    } | undefined
    const clientSource = await readFile(join(installDir, 'package', 'lib', 'client.js'), 'utf8')
    runInNewContext(clientSource, {
      TextEncoder,
      window: {
        __ModuleLoader__: {
          load(value: typeof registration) {
            registration = value
          },
        },
      },
    })
    expect(registration?.id).toBe('dsh-dev-reloader')
    const clientModule = registration!.factory(createRequire(import.meta.url))
    expect(typeof clientModule.name).toBe('string')
    expect(typeof clientModule.apply).toBe('function')
    expect(Array.isArray(clientModule.inject)).toBe(true)

    // 6. No built JavaScript or source map references the local repository checkout.
    const forbiddenCheckoutPaths = new Set([repoRoot, repoRoot.replaceAll('\\', '/')])
    for (const file of await listBuildTextFiles(join(installDir, 'package', 'lib'))) {
      const source = await readFile(file, 'utf8')
      for (const checkoutPath of forbiddenCheckoutPaths) expect(source).not.toContain(checkoutPath)
    }
  })
})

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, {
      cwd: repoRoot,
      timeout: 120_000,
      shell: process.platform === 'win32' && cmd === 'pnpm',
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || stdout}`))
      else resolvePromise(stdout)
    })
  })
}

async function listBuildTextFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await listBuildTextFiles(path))
    else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.map'))) found.push(path)
  }
  return found
}
