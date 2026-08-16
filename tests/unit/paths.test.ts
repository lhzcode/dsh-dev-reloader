import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  removeStaleSupervisorSocket,
  resolveRuntimePaths,
  writePrivateFileAtomic,
} from '../../src/supervisor/paths.js'

const temporaryRoots: string[] = []

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dev-reloader-paths-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('resolveRuntimePaths', () => {
  it.skipIf(process.platform === 'win32')('creates a profile-isolated POSIX runtime directory with explicit platform semantics', async () => {
    const dshHome = await temporaryHome()
    const paths = await resolveRuntimePaths({ dshHome, profile: 'web', platform: 'linux' })

    expect(paths.platform).toBe('linux')
    expect(paths.stateDir).toBe(join(dshHome, 'plugins', 'dsh-dev-reloader', 'web'))
    const localEndpoint = join(paths.stateDir, 'supervisor.sock')
    if (Buffer.byteLength(localEndpoint) <= 103) {
      expect(paths.endpoint).toBe(localEndpoint)
      expect(paths.endpointDirKind).toBe('state')
    } else {
      expect(dirname(paths.endpoint)).toBe(paths.endpointDir)
      expect(paths.endpointDirKind).toBe('temporary')
      expect(Buffer.byteLength(paths.endpoint)).toBeLessThanOrEqual(103)
      temporaryRoots.push(paths.endpointDir!)
    }
    expect(paths.lockFile).toBe(join(paths.stateDir, 'supervisor.lock'))
    expect(paths.guardFile).toBe(join(paths.stateDir, 'supervisor.lock.guard'))
    expect(paths.tokenFile).toBe(join(paths.stateDir, 'supervisor.token'))
    expect((await stat(paths.stateDir)).mode & 0o777).toBe(0o700)
  })

  it('uses deterministic per-profile Windows named pipes and preserves the override', async () => {
    const dshHome = await temporaryHome()
    const web = await resolveRuntimePaths({ dshHome, profile: 'web', platform: 'win32' })
    const test = await resolveRuntimePaths({ dshHome, profile: 'test', platform: 'win32' })

    expect(web.platform).toBe('win32')
    expect(web.endpoint).toMatch(/^\\\\\.\\pipe\\dsh-dev-reloader-[a-f0-9]{24}$/)
    expect(test.endpoint).toMatch(/^\\\\\.\\pipe\\dsh-dev-reloader-[a-f0-9]{24}$/)
    expect(web.endpointDir).toBeUndefined()
    expect(web.endpointDirKind).toBe('named-pipe')
    expect(web.endpoint).not.toBe(test.endpoint)
    expect(web.stateDir).not.toBe(test.stateDir)
  })

  it('resolves DSH_HOME from the supplied launch environment', async () => {
    const dshHome = await temporaryHome()

    const paths = await resolveRuntimePaths({ env: { DSH_HOME: dshHome }, profile: 'web' })

    expect(paths.dshHome).toBe(dshHome)
    expect(paths.stateDir).toBe(join(dshHome, 'plugins', 'dsh-dev-reloader', 'web'))
  })

  it('uses the canonical default home when DSH_HOME is unset or blank', async () => {
    const home = await temporaryHome()
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
    try {
      const unset = await resolveRuntimePaths({ env: {}, profile: 'default-unset' })
      const blank = await resolveRuntimePaths({ env: { DSH_HOME: '   ' }, profile: 'default-blank' })

      expect(unset.dshHome).toBe(join(home, '.dsh'))
      expect(blank.dshHome).toBe(join(home, '.dsh'))
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
    }
  })

  it('rejects blank explicit dshHome overrides instead of resolving them to cwd', async () => {
    await expect(resolveRuntimePaths({ dshHome: '', profile: 'web' }))
      .rejects.toThrow('explicit dshHome must not be blank')
    await expect(resolveRuntimePaths({ dshHome: '   ', profile: 'web' }))
      .rejects.toThrow('explicit dshHome must not be blank')
  })

  it.skipIf(process.platform === 'win32')('keeps a short state-directory socket inside the private state directory', async () => {
    const root = await mkdtemp('/tmp/dsh-dr-short-')
    temporaryRoots.push(root)

    const paths = await resolveRuntimePaths({ dshHome: root, profile: 'web', platform: 'darwin' })

    expect(paths.endpoint).toBe(join(paths.stateDir, 'supervisor.sock'))
    expect(paths.endpointDir).toBe(paths.stateDir)
    expect(paths.endpointDirKind).toBe('state')
  })

  it.skipIf(process.platform === 'win32')('removes a stale Unix supervisor socket before listening', async () => {
    const dshHome = await temporaryHome()
    const paths = await resolveRuntimePaths({ dshHome, profile: 'web' })
    const child = spawn(process.execPath, [
      '-e',
      'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("ready"))',
      paths.endpoint,
    ], { stdio: ['ignore', 'pipe', 'inherit'] })

    await once(child.stdout!, 'data')
    child.kill('SIGKILL')
    await once(child, 'exit')
    expect((await lstat(paths.endpoint)).isSocket()).toBe(true)

    await removeStaleSupervisorSocket(paths)

    await expect(lstat(paths.endpoint)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('refuses to remove a non-socket supervisor endpoint', async () => {
    const dshHome = await temporaryHome()
    const paths = await resolveRuntimePaths({ dshHome, profile: 'web' })
    await writeFile(paths.endpoint, 'occupied')

    await expect(removeStaleSupervisorSocket(paths)).rejects.toThrow(/not a socket/i)
    expect(await readFile(paths.endpoint, 'utf8')).toBe('occupied')
  })

  it.skipIf(process.platform === 'win32')('uses a deterministic private uid-and-state fallback directory for long sockets', async () => {
    const root = await temporaryHome()
    const longHome = join(root, 'x'.repeat(80), 'y'.repeat(80))
    const first = await resolveRuntimePaths({ dshHome: longHome, profile: 'web', platform: 'darwin' })
    const again = await resolveRuntimePaths({ dshHome: longHome, profile: 'web', platform: 'darwin' })
    const other = await resolveRuntimePaths({ dshHome: longHome, profile: 'test', platform: 'darwin' })
    const firstEndpointDir = first.endpointDir!
    const otherEndpointDir = other.endpointDir!
    temporaryRoots.push(firstEndpointDir, otherEndpointDir)

    expect(Buffer.byteLength(first.endpoint)).toBeLessThanOrEqual(103)
    expect(dirname(first.endpoint)).toBe(firstEndpointDir)
    expect(dirname(firstEndpointDir)).toBe(tmpdir())
    expect(firstEndpointDir).toMatch(new RegExp(`dsh-dr-${process.getuid!()}-[a-f0-9]{16}$`))
    expect(first.endpoint).toBe(join(firstEndpointDir, 's.sock'))
    expect(first.endpointDirKind).toBe('temporary')
    expect((await lstat(first.endpointDir)).mode & 0o777).toBe(0o700)
    expect(again.endpoint).toBe(first.endpoint)
    expect(other.endpoint).not.toBe(first.endpoint)
  })

  it.skipIf(process.platform === 'win32')('rejects a preempting non-directory at the fallback endpoint directory', async () => {
    const root = await temporaryHome()
    const longHome = join(root, 'x'.repeat(80), 'y'.repeat(80))
    const first = await resolveRuntimePaths({ dshHome: longHome, profile: 'web', platform: 'darwin' })
    const endpointDir = first.endpointDir!
    temporaryRoots.push(endpointDir)
    await rm(endpointDir, { recursive: true, force: true })
    await writeFile(endpointDir, 'occupied')

    await expect(resolveRuntimePaths({ dshHome: longHome, profile: 'web', platform: 'darwin' }))
      .rejects.toThrow(/directory/i)
    expect((await lstat(endpointDir)).isFile()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink at the fallback endpoint directory', async () => {
    const root = await temporaryHome()
    const longHome = join(root, 'x'.repeat(80), 'y'.repeat(80))
    const first = await resolveRuntimePaths({ dshHome: longHome, profile: 'web', platform: 'darwin' })
    const endpointDir = first.endpointDir!
    temporaryRoots.push(endpointDir)
    await rm(endpointDir, { recursive: true, force: true })
    const target = join(root, 'redirected-endpoint')
    await mkdir(target)
    await symlink(target, endpointDir, 'dir')

    await expect(resolveRuntimePaths({ dshHome: longHome, profile: 'web', platform: 'darwin' }))
      .rejects.toThrow(/symlink|directory/i)
    expect((await lstat(endpointDir)).isSymbolicLink()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('repairs and verifies fallback endpoint-directory mode 0700', async () => {
    const root = await temporaryHome()
    const longHome = join(root, 'x'.repeat(80), 'y'.repeat(80))
    const first = await resolveRuntimePaths({ dshHome: longHome, profile: 'web', platform: 'darwin' })
    const endpointDir = first.endpointDir!
    temporaryRoots.push(endpointDir)
    await chmod(endpointDir, 0o755)

    const again = await resolveRuntimePaths({ dshHome: longHome, profile: 'web', platform: 'darwin' })

    expect(again.endpoint).toBe(first.endpoint)
    expect((await lstat(again.endpointDir!)).mode & 0o777).toBe(0o700)
  })

  it.skipIf(process.platform === 'win32')('writes private files atomically with mode 0600 using the resolved platform', async () => {
    const dshHome = await temporaryHome()
    const paths = await resolveRuntimePaths({ dshHome, profile: 'web', platform: 'linux' })

    await writePrivateFileAtomic(paths.tokenFile, 'first', paths.platform)
    await writePrivateFileAtomic(paths.tokenFile, 'second', paths.platform)

    expect(await readFile(paths.tokenFile, 'utf8')).toBe('second')
    expect((await stat(paths.tokenFile)).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('rejects a final state-directory symlink but permits a DSH_HOME parent symlink', async () => {
    const root = await temporaryHome()
    const realHome = join(root, 'real-home')
    const homeAlias = join(root, 'home-alias')
    await mkdir(realHome)
    await symlink(realHome, homeAlias, 'dir')

    const throughParentLink = await resolveRuntimePaths({
      dshHome: homeAlias,
      profile: 'web',
      platform: 'linux',
    })
    expect((await lstat(throughParentLink.stateDir)).isDirectory()).toBe(true)

    const unsafeHome = join(root, 'unsafe-home')
    const stateDir = join(unsafeHome, 'plugins', 'dsh-dev-reloader', 'web')
    const redirected = join(root, 'redirected')
    await mkdir(dirname(stateDir), { recursive: true })
    await mkdir(redirected)
    await symlink(redirected, stateDir, 'dir')

    await expect(resolveRuntimePaths({ dshHome: unsafeHome, profile: 'web', platform: 'linux' }))
      .rejects.toThrow(/symlink|directory/i)
    expect((await lstat(stateDir)).isSymbolicLink()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('repairs and verifies private state-directory mode', async () => {
    const dshHome = await temporaryHome()
    const stateDir = join(dshHome, 'plugins', 'dsh-dev-reloader', 'web')
    await mkdir(stateDir, { recursive: true, mode: 0o755 })
    await chmod(stateDir, 0o755)

    const paths = await resolveRuntimePaths({ dshHome, profile: 'web', platform: 'linux' })

    expect((await lstat(paths.stateDir)).mode & 0o777).toBe(0o700)
  })

  it('rejects unsafe profile names instead of escaping the runtime root', async () => {
    const dshHome = await temporaryHome()

    await expect(resolveRuntimePaths({ dshHome, profile: '../other' }))
      .rejects.toThrow(/profile/i)
  })
})
