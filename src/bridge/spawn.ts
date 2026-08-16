import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Resolve the supervisor CLI entry under the current package's `lib`. */
export function resolveSupervisorCli(moduleUrl?: string): string {
  const modulePath = fileURLToPath(moduleUrl ?? import.meta.url)
  // Built module lives at <package>/lib/bridge/spawn.js → <package>/lib/supervisor/cli.js
  return join(dirname(dirname(modulePath)), 'supervisor', 'cli.js')
}

export interface SpawnSupervisorOptions {
  /** Absolute path to the built supervisor CLI entry. */
  readonly cliPath: string
  /** DSH profile the supervisor should serve. */
  readonly profile: string
  /** Environment inherited in memory by the detached supervisor. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Test seam for the child-process spawner. */
  readonly spawn?: (
    file: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess
}

export interface SpawnSupervisorResult {
  readonly process: ChildProcess
  readonly pid: number
}

/**
 * Launch the dev supervisor as a detached daemon so it outlives the host.
 * The child inherits `process.execPath`, ignored stdio, and is unref'd so it
 * never keeps the host's event loop alive.
 */
export function spawnSupervisor(options: SpawnSupervisorOptions): SpawnSupervisorResult {
  const doSpawn = options.spawn ?? nodeSpawn
  const packageRoot = dirname(dirname(options.cliPath))
  const processChild = doSpawn(
    process.execPath,
    [options.cliPath, '--serve', '--profile', options.profile],
    {
      shell: false,
      detached: true,
      stdio: 'ignore',
      cwd: packageRoot,
      env: { ...process.env, ...options.env },
    },
  )
  processChild.unref()
  const pid = processChild.pid
  if (pid === undefined) {
    throw new Error('detached supervisor did not receive a PID')
  }
  return { process: processChild, pid }
}
