import { execFile } from 'node:child_process'
import { mkdir, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Path to the repo root (parent of tests/helpers). */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const LIB_CLI = join(repoRoot, 'lib', 'supervisor', 'cli.js')
const BUILD_LOCK = join(tmpdir(), 'dsh-dev-reloader-build.lock')

/** Newest mtime across all source inputs that feed `lib`. */
async function newestSourceMtime(): Promise<number> {
  const inputs = [
    join(repoRoot, 'tsconfig.json'),
    join(repoRoot, 'tsdown.config.ts'),
    ...(await walkSource(join(repoRoot, 'src'))),
  ]
  let newest = 0
  for (const input of inputs) {
    try {
      const info = await stat(input)
      if (info.mtimeMs > newest) newest = info.mtimeMs
    } catch {
      // ignore missing
    }
  }
  return newest
}

async function walkSource(root: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (/\.tsx?$/.test(entry.name)) found.push(path)
    }
  }
  await walk(root)
  return found
}

async function libCliFresh(): Promise<boolean> {
  try {
    const newest = await newestSourceMtime()
    const info = await stat(LIB_CLI)
    return info.mtimeMs >= newest
  } catch {
    return false
  }
}

namespace ensureBuilt {
  let buildPromise: Promise<void> | undefined

  export async function ensure(): Promise<void> {
    if (buildPromise !== undefined) await buildPromise
    buildPromise = withBuildLock(async () => {
      if (await libCliFresh()) return
      await runBuild()
    })
    await buildPromise
  }
}

async function withBuildLock<T>(fn: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      await mkdir(BUILD_LOCK)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return fn()
      await delay(50)
    }
  }
  try {
    return await fn()
  } finally {
    await rm(BUILD_LOCK, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function runBuild(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('pnpm', ['build'], {
      cwd: repoRoot,
      env: { ...process.env, PATH: process.env.PATH ?? '' },
      shell: process.platform === 'win32',
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`pnpm build failed:\n${stdout}\n${stderr}`))
        return
      }
      resolve()
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export function ensureBuiltPackage(): Promise<void> {
  return ensureBuilt.ensure()
}

void dirname
