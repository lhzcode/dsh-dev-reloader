import { spawn as nodeSpawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createCommandRunner,
  type CommandResult,
  type SpawnAdapter,
} from '../../src/supervisor/runner.js'
import { eventually } from '../helpers/eventually.js'

const runners: Array<ReturnType<typeof createCommandRunner>> = []
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runner-'))
  temporaryDirectories.push(directory)
  return directory
}

function runner(options: Parameters<typeof createCommandRunner>[0] = {}) {
  const created = createCommandRunner(options)
  runners.push(created)
  return created
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function expectTerminatedByRunner(result: CommandResult): void {
  const terminated = result.exitCode === null
    ? result.signal !== null
    : result.exitCode !== 0
  expect(terminated).toBe(true)
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map(current => current.stopAll()))
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  ))
  vi.restoreAllMocks()
})

describe('command runner', () => {
  it('forwards exact executable, argv, cwd, and env with shell disabled', async () => {
    const cwd = await temporaryDirectory()
    const env = { PATH: process.env.PATH ?? '', TASK_KIND: 'dependency-install' }
    const calls: Array<{ executable: string; args: readonly string[]; options: Record<string, unknown> }> = []
    const spawn: SpawnAdapter = (executable, args, options) => {
      calls.push({ executable, args: [...args], options: options as unknown as Record<string, unknown> })
      return nodeSpawn(executable, [...args], options)
    }
    const commandRunner = runner({ spawn })

    const result = await commandRunner.run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.TASK_KIND ?? "")'],
      cwd,
      env,
    })

    expect(result).toMatchObject({ exitCode: 0, stdout: 'dependency-install' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.TASK_KIND ?? "")'],
      options: { cwd, env, shell: false },
    })
  })

  it('uses the Windows command shim only for pnpm executables', async () => {
    const calls: Array<{ executable: string; args: readonly string[]; options: Record<string, unknown> }> = []
    const spawn: SpawnAdapter = (executable, args, options) => {
      calls.push({ executable, args: [...args], options: options as unknown as Record<string, unknown> })
      return nodeSpawn(process.execPath, ['-e', ''], { shell: false })
    }
    const commandRunner = runner({ spawn, platform: 'win32' })

    await commandRunner.run({ executable: 'pnpm', args: ['run', 'build'] })
    await commandRunner.run({ executable: 'C:\\tools\\pnpm.cmd', args: ['install'] })
    await commandRunner.run({ executable: 'npm.cmd', args: ['run', 'build'] })

    expect(calls).toHaveLength(3)
    expect(calls[0]).toMatchObject({
      executable: 'pnpm',
      args: ['run', 'build'],
      options: { shell: true },
    })
    expect(calls[0]!.options).not.toHaveProperty('detached')
    expect(calls[1]).toMatchObject({
      executable: 'C:\\tools\\pnpm.cmd',
      args: ['install'],
      options: { shell: true },
    })
    expect(calls[2]).toMatchObject({ options: { shell: false } })
  })

  it('keeps bounded valid UTF-8 tails for stdout and stderr', async () => {
    const commandRunner = runner({ outputLimitBytes: 63 })
    const script = [
      "process.stdout.write('old'.repeat(100) + '🙂'.repeat(20) + 'stdout-end')",
      "process.stderr.write('old'.repeat(100) + '界'.repeat(20) + 'stderr-end')",
    ].join(';')

    const result = await commandRunner.run({
      executable: process.execPath,
      args: ['-e', script],
    })

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(63)
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(63)
    expect(result.stdout.endsWith('stdout-end')).toBe(true)
    expect(result.stderr.endsWith('stderr-end')).toBe(true)
    expect(result.stdout).not.toContain('�')
    expect(result.stderr).not.toContain('�')
  })

  it('redacts explicit and sensitive environment values from all captured output', async () => {
    const commandRunner = runner({ outputLimitBytes: 4_096, secrets: ['manual-secret'] })
    const env = {
      PATH: process.env.PATH ?? '',
      API_TOKEN: 'environment-secret',
      NORMAL: 'visible-value',
    }
    const script = "console.log(process.env.API_TOKEN, 'manual-secret', process.env.NORMAL); console.error('Bearer abc.def-123')"

    const result = await commandRunner.run({
      executable: process.execPath,
      args: ['-e', script],
      env,
    })

    expect(`${result.stdout}\n${result.stderr}`).not.toContain('environment-secret')
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('manual-secret')
    expect(result.stderr).not.toContain('abc.def-123')
    expect(result.stdout).toContain('visible-value')
    expect(result.stdout).toContain('[REDACTED]')
  })

  it('stream-redacts an oversized bearer token before bounding the tail', async () => {
    const commandRunner = runner({ outputLimitBytes: 128 })
    const result = await commandRunner.run({
      executable: process.execPath,
      args: [
        '-e',
        "process.stdout.write('Bearer '); for (let i = 0; i < 100; i++) process.stdout.write('a'.repeat(2048)); process.stdout.write('\\nvisible-end')",
      ],
    })

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128)
    expect(result.stdout).toContain('Bearer [REDACTED]')
    expect(result.stdout).toContain('visible-end')
    expect(result.stdout).not.toContain('a'.repeat(32))
  })

  it('stream-redacts an oversized sensitive assignment across chunks', async () => {
    const commandRunner = runner({ outputLimitBytes: 128 })
    const result = await commandRunner.run({
      executable: process.execPath,
      args: [
        '-e',
        "process.stdout.write('TOKEN='); for (let i = 0; i < 100; i++) process.stdout.write('z'.repeat(2048)); process.stdout.write('\\nvisible-end')",
      ],
    })

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128)
    expect(result.stdout).toContain('TOKEN=[REDACTED]')
    expect(result.stdout).toContain('visible-end')
    expect(result.stdout).not.toContain('z'.repeat(32))
  })

  it('keeps assignment redaction active across a whitespace-only chunk', async () => {
    const commandRunner = runner({ outputLimitBytes: 128 })
    const result = await commandRunner.run({
      executable: process.execPath,
      args: [
        '-e',
        [
          "process.stdout.write('TOKEN=')",
          "setTimeout(() => process.stdout.write(' '), 10)",
          "setTimeout(() => process.stdout.write('TOPSECRET'), 30)",
          "setTimeout(() => process.stdout.write('\\nvisible-end'), 50)",
        ].join(';'),
      ],
    })

    expect(result.stdout).toContain('TOKEN=[REDACTED]')
    expect(result.stdout).toContain('visible-end')
    expect(result.stdout).not.toContain('TOPSECRET')
  })

  it('redacts a chunked Basic authorization header through the end of its line', async () => {
    const commandRunner = runner({ outputLimitBytes: 128 })
    const result = await commandRunner.run({
      executable: process.execPath,
      args: [
        '-e',
        [
          "process.stdout.write('Authorization:')",
          "setTimeout(() => process.stdout.write(' Basic '), 10)",
          "setTimeout(() => process.stdout.write('dXNlcjpwYXNz'), 30)",
          "setTimeout(() => process.stdout.write('\\nvisible-end'), 50)",
        ].join(';'),
      ],
    })

    expect(result.stdout).toContain('Authorization: [REDACTED]')
    expect(result.stdout).toContain('visible-end')
    expect(result.stdout).not.toContain('Basic')
    expect(result.stdout).not.toContain('dXNlcjpwYXNz')
  })

  it('aborts a one-shot child and rejects with AbortError', async () => {
    const commandRunner = runner()
    const controller = new AbortController()
    const running = commandRunner.run({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    }, controller.signal)

    controller.abort()

    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  })

  it.runIf(process.platform !== 'win32')('escalates an aborted one-shot child that ignores SIGTERM', async () => {
    const directory = await temporaryDirectory()
    const marker = join(directory, 'one-shot-ready')
    const commandRunner = runner({ stopGraceMs: 25 })
    const controller = new AbortController()
    const running = commandRunner.run({
      executable: process.execPath,
      args: [
        '-e',
        "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)",
        marker,
      ],
    }, controller.signal)
    await eventually(() => access(marker))

    controller.abort()

    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('supports dependency install, build, and persistent dev:web command templates', async () => {
    const seen: string[][] = []
    const spawn: SpawnAdapter = (executable, args, options) => {
      seen.push([executable, ...args])
      const script = args[1] === 'dev:web' ? 'setInterval(() => {}, 1000)' : ''
      return nodeSpawn(process.execPath, ['-e', script], options)
    }
    const commandRunner = runner({ spawn })

    await commandRunner.run({
      executable: 'pnpm',
      args: ['install', '--frozen-lockfile'],
      cwd: process.cwd(),
    })
    await commandRunner.run({
      executable: 'pnpm',
      args: ['run', 'build'],
      cwd: process.cwd(),
    })
    const watcher = await commandRunner.ensurePersistent('dev:web:fixture', {
      executable: 'pnpm',
      args: ['run', 'dev:web'],
      cwd: process.cwd(),
    })

    expect(seen).toEqual([
      ['pnpm', 'install', '--frozen-lockfile'],
      ['pnpm', 'run', 'build'],
      ['pnpm', 'run', 'dev:web'],
    ])
    await watcher.stop()
  })
})

describe('persistent process registry', () => {
  it('coalesces concurrent same-key starts into exactly one child and handle', async () => {
    let spawnCount = 0
    const spawn: SpawnAdapter = (executable, args, options) => {
      spawnCount += 1
      return nodeSpawn(executable, [...args], options)
    }
    const commandRunner = runner({ spawn })
    const command = {
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    } as const

    const [first, second] = await Promise.all([
      commandRunner.ensurePersistent('client:concurrent', command),
      commandRunner.ensurePersistent('client:concurrent', command),
    ])

    expect(spawnCount).toBe(1)
    expect(second).toBe(first)
    expect(commandRunner.persistentCount).toBe(1)
  })

  it('does not orphan a child when stopAll races its spawn boundary', async () => {
    const commandRunner = runner()
    const starting = commandRunner.ensurePersistent('client:racing-stop', {
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    })

    const stopping = commandRunner.stopAll()
    const handle = await starting
    await stopping

    expectTerminatedByRunner(await handle.done)
    expect(commandRunner.persistentCount).toBe(0)
  })

  it.runIf(process.platform !== 'win32')('keeps a stopping key reserved and visible to stopAll until termination settles', async () => {
    const directory = await temporaryDirectory()
    const marker = join(directory, 'delayed-stop-ready')
    const commandRunner = runner({ stopGraceMs: 1_000 })
    const command = {
      executable: process.execPath,
      args: [
        '-e',
        [
          "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150))",
          "require('node:fs').writeFileSync(process.argv[1], 'ready')",
          'setInterval(() => {}, 1000)',
        ].join(';'),
        marker,
      ],
    } as const
    const handle = await commandRunner.ensurePersistent('client:stopping', command)
    await eventually(() => access(marker))

    const stopping = handle.stop()
    await expect(commandRunner.ensurePersistent('client:stopping', command))
      .rejects.toMatchObject({ code: 'PERSISTENT_PROCESS_STOPPING' })
    let drained = false
    const draining = commandRunner.stopAll().then(() => { drained = true })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(drained).toBe(false)

    await Promise.all([stopping, draining])
    expect(commandRunner.persistentCount).toBe(0)
  })

  it('rejects starts while stopAll is draining reserved children', async () => {
    const commandRunner = runner()
    const starting = commandRunner.ensurePersistent('client:draining', {
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    })
    const stopping = commandRunner.stopAll()

    await expect(commandRunner.ensurePersistent('client:late', {
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    })).rejects.toMatchObject({ code: 'PERSISTENT_RUNNER_STOPPING' })
    await starting
    await stopping
  })

  it('reuses a live process by key and rejects conflicting commands', async () => {
    const commandRunner = runner()
    const command = {
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    } as const

    const first = await commandRunner.ensurePersistent('client:a', command)
    const second = await commandRunner.ensurePersistent('client:a', command)

    expect(second).toBe(first)
    await expect(commandRunner.ensurePersistent('client:a', {
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 2000)'],
    })).rejects.toMatchObject({ code: 'PERSISTENT_COMMAND_CONFLICT' })
  })

  it('allows a key to restart after the previous process exits', async () => {
    const commandRunner = runner()
    const command = {
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
    } as const

    const first = await commandRunner.ensurePersistent('short', command)
    await first.done
    const second = await commandRunner.ensurePersistent('short', command)

    expect(second).not.toBe(first)
    await second.done
  })

  it('rejects a persistent command that never reaches the spawn boundary', async () => {
    const commandRunner = runner()

    await expect(commandRunner.ensurePersistent('missing', {
      executable: join(await temporaryDirectory(), 'missing-executable'),
      args: [],
    })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(commandRunner.persistentCount).toBe(0)
  })

  it('stopAll terminates every child and leaves no registered process', async () => {
    const commandRunner = runner()
    const command = {
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    } as const
    const first = await commandRunner.ensurePersistent('one', command)
    const second = await commandRunner.ensurePersistent('two', command)

    await commandRunner.stopAll()

    expectTerminatedByRunner(await first.done)
    expectTerminatedByRunner(await second.done)
    expect(commandRunner.persistentCount).toBe(0)
  })

  it.runIf(process.platform !== 'win32')('terminates the complete persistent process group', async () => {
    const directory = await temporaryDirectory()
    const marker = join(directory, 'descendant-pid')
    const commandRunner = runner({ stopGraceMs: 25 })
    await commandRunner.ensurePersistent('process-tree', {
      executable: process.execPath,
      args: [
        '-e',
        [
          "const { spawn } = require('node:child_process')",
          "const { writeFileSync } = require('node:fs')",
          "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })",
          "writeFileSync(process.argv[1], String(child.pid))",
          "process.on('SIGTERM', () => {})",
          "setInterval(() => {}, 1000)",
        ].join(';'),
        marker,
      ],
    })
    await eventually(() => access(marker))
    const descendantPid = Number(await readFile(marker, 'utf8'))

    try {
      await commandRunner.stopAll()
      await eventually(() => expect(pidIsRunning(descendantPid)).toBe(false))
    } finally {
      if (pidIsRunning(descendantPid)) process.kill(descendantPid, 'SIGKILL')
    }
  })

  it.runIf(process.platform !== 'win32')('escalates termination for a child that ignores SIGTERM', async () => {
    const directory = await temporaryDirectory()
    const marker = join(directory, 'ready')
    const commandRunner = runner({ stopGraceMs: 25 })
    const processHandle = await commandRunner.ensurePersistent('stubborn', {
      executable: process.execPath,
      args: [
        '-e',
        "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)",
        marker,
      ],
    })
    await eventually(() => access(marker))

    await commandRunner.stopAll()

    await expect(processHandle.done).resolves.toMatchObject({ signal: 'SIGKILL' })
    expect(commandRunner.persistentCount).toBe(0)
  })
})
