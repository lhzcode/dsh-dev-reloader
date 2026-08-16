import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  resolveSupervisorCli,
  spawnSupervisor,
} from '../../src/bridge/spawn.js'

describe('spawn factory', () => {
  it('resolves the supervisor CLI to lib/supervisor/cli.js under the package root', () => {
    // Simulate the built module path <package>/lib/bridge/spawn.js with a
    // native absolute path so the file URL round-trip is valid on every OS.
    const packageRoot = join(process.cwd(), 'fixture-package')
    const fakeModuleUrl = pathToFileURL(join(packageRoot, 'lib', 'bridge', 'spawn.js')).href

    const cli = resolveSupervisorCli(fakeModuleUrl)

    expect(cli).toBe(join(packageRoot, 'lib', 'supervisor', 'cli.js'))
  })

  it('spawns a detached supervisor with process.execPath, ignored stdio, and unref', () => {
    const spawn = vi.fn(() => ({ pid: 12345, unref: vi.fn() }))

    spawnSupervisor({
      cliPath: '/pkg/lib/supervisor/cli.js',
      profile: 'web',
      env: { DSH_HOME: '/tmp/home' },
      spawn: spawn as never,
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    const [file, args, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
    expect(file).toBe(process.execPath)
    expect(args).toEqual(['/pkg/lib/supervisor/cli.js', '--serve', '--profile', 'web'])
    expect(options.detached).toBe(true)
    expect(options.stdio).toBe('ignore')
    expect(options.env).toMatchObject({ DSH_HOME: '/tmp/home' })
    const unref = (spawn.mock.results[0]?.value as { unref: ReturnType<typeof vi.fn> }).unref
    expect(unref).toHaveBeenCalledTimes(1)
  })

  it('returns the spawned child and its pid', () => {
    const spawn = vi.fn(() => ({ pid: 999, unref: vi.fn() }))

    const result = spawnSupervisor({
      cliPath: '/pkg/lib/supervisor/cli.js',
      profile: 'web',
      env: {},
      spawn: spawn as never,
    })

    expect(result.pid).toBe(999)
    expect(result.process).toBeDefined()
  })
})
