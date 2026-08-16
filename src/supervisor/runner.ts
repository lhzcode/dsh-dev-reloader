import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'

import type { CommandTemplate } from '../shared/protocol.js'

const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024
const REDACTION = '[REDACTED]'
const SENSITIVE_ENVIRONMENT_NAME = /(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential)/i
const AUTHORIZATION_HEADER = /\bAuthorization\s*:\s*[^\r\n]*/gi
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi
const SENSITIVE_ASSIGNMENT = /\b(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi

export interface CommandSpec extends CommandTemplate {
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface CommandResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

export interface PersistentProcess {
  readonly key: string
  readonly command: CommandSpec
  readonly pid: number | undefined
  readonly done: Promise<CommandResult>
  stop(): Promise<void>
}

export interface CommandRunner {
  run(command: CommandSpec, signal?: AbortSignal): Promise<CommandResult>
  ensurePersistent(key: string, command: CommandSpec): Promise<PersistentProcess>
  stopAll(): Promise<void>
  readonly persistentCount: number
}

export type SpawnAdapter = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

export interface CommandRunnerOptions {
  readonly spawn?: SpawnAdapter
  /** Platform used for executable shim handling; injectable for deterministic tests. */
  readonly platform?: NodeJS.Platform
  readonly outputLimitBytes?: number
  readonly secrets?: readonly string[]
  readonly stopGraceMs?: number
}

interface RunningChild {
  readonly child: ChildProcess
  readonly started: Promise<void>
  readonly done: Promise<CommandResult>
}

interface PersistentEntry {
  readonly command: CommandSpec
  readonly ready: Promise<PersistentProcess>
  stopping?: Promise<void>
}

class ByteTail {
  private value: Buffer = Buffer.alloc(0)

  constructor(private readonly limit: number) {}

  append(chunk: string | Buffer): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (incoming.length >= this.limit) {
      this.value = incoming.subarray(incoming.length - this.limit)
      return
    }

    const excess = this.value.length + incoming.length - this.limit
    if (excess > 0) this.value = this.value.subarray(excess)
    this.value = Buffer.concat([this.value, incoming], this.value.length + incoming.length)
  }

  toUtf8(): string {
    return decodeUtf8Tail(this.value)
  }
}

const AUTHORIZATION_PREFIX = /\bAuthorization\s*:\s*/i
const BEARER_PREFIX = /Bearer\s+/i
const SENSITIVE_ASSIGNMENT_PREFIX = /\b(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential)(\s*[:=]\s*)/i
const BEARER_CHARACTER = /^[-A-Za-z0-9._~+/=]$/

/** Redact unbounded bearer tokens before they enter the bounded output tail. */
class RedactedByteTail {
  private readonly decoder = new TextDecoder()
  private readonly tail: ByteTail
  private readonly carryLength: number
  private pending = ''
  private inAuthorization = false
  private inBearer = false
  private inSensitiveValue = false
  private sensitiveValueStarted = false
  private sensitiveQuote: '"' | "'" | null | undefined

  constructor(
    limit: number,
    private readonly secrets: readonly string[],
  ) {
    this.tail = new ByteTail(limit)
    this.carryLength = Math.max(64, ...secrets.map(secret => secret.length - 1))
  }

  append(chunk: string | Buffer): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.pending += this.decoder.decode(bytes, { stream: true })
    this.process(false)
  }

  finish(): string {
    this.pending += this.decoder.decode()
    this.process(true)
    return this.tail.toUtf8()
  }

  private process(final: boolean): void {
    while (this.pending.length > 0) {
      if (this.inAuthorization) {
        const end = this.pending.search(/[\r\n]/)
        if (end < 0) {
          this.pending = ''
          return
        }
        this.pending = this.pending.slice(end)
        this.inAuthorization = false
        continue
      }

      if (this.inBearer) {
        let end = 0
        while (end < this.pending.length && BEARER_CHARACTER.test(this.pending[end]!)) end += 1
        if (end === this.pending.length) {
          this.pending = ''
          return
        }
        this.pending = this.pending.slice(end)
        this.inBearer = false
        continue
      }

      if (this.inSensitiveValue) {
        if (!this.sensitiveValueStarted) {
          const leadingWhitespace = /^\s+/.exec(this.pending)?.[0].length ?? 0
          this.pending = this.pending.slice(leadingWhitespace)
          if (this.pending.length === 0) return
          this.sensitiveValueStarted = true
        }

        if (this.sensitiveQuote === undefined) {
          const first = this.pending[0]
          if (first === '"' || first === "'") {
            this.sensitiveQuote = first
            this.pending = this.pending.slice(1)
            if (this.pending.length === 0) return
          } else {
            this.sensitiveQuote = null
          }
        }

        if (this.sensitiveQuote !== null) {
          const end = this.pending.indexOf(this.sensitiveQuote)
          if (end < 0) {
            this.pending = ''
            return
          }
          this.pending = this.pending.slice(end + 1)
        } else {
          const end = this.pending.search(/[\s,;]/)
          if (end < 0) {
            this.pending = ''
            return
          }
          this.pending = this.pending.slice(end)
        }
        this.inSensitiveValue = false
        this.sensitiveValueStarted = false
        this.sensitiveQuote = undefined
        continue
      }

      const candidates = [
        { kind: 'authorization' as const, match: AUTHORIZATION_PREFIX.exec(this.pending) },
        { kind: 'bearer' as const, match: BEARER_PREFIX.exec(this.pending) },
        { kind: 'assignment' as const, match: SENSITIVE_ASSIGNMENT_PREFIX.exec(this.pending) },
      ].filter((candidate): candidate is typeof candidate & { match: RegExpExecArray } =>
        candidate.match !== null)
      candidates.sort((left, right) => left.match.index - right.match.index)
      const next = candidates[0]
      if (next !== undefined) {
        const { kind, match } = next
        this.emit(this.pending.slice(0, match.index))
        if (kind === 'authorization') {
          this.tail.append(`Authorization: ${REDACTION}`)
          this.inAuthorization = true
        } else if (kind === 'bearer') {
          this.tail.append(`Bearer ${REDACTION}`)
          this.inBearer = true
        } else {
          this.tail.append(`${match[1]}${match[2]}${REDACTION}`)
          this.inSensitiveValue = true
          this.sensitiveValueStarted = false
          this.sensitiveQuote = undefined
        }
        this.pending = this.pending.slice(match.index + match[0].length)
        continue
      }

      if (final) {
        this.emit(this.pending)
        this.pending = ''
        return
      }

      if (this.pending.length <= this.carryLength) return
      let emitLength = this.pending.length - this.carryLength
      for (const secret of this.secrets) {
        const maxOverlap = Math.min(secret.length - 1, emitLength)
        for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
          if (
            this.pending.slice(emitLength - overlap, emitLength)
            === secret.slice(0, overlap)
          ) {
            emitLength -= overlap
            break
          }
        }
      }
      if (emitLength === 0) return
      this.emit(this.pending.slice(0, emitLength))
      this.pending = this.pending.slice(emitLength)
    }
  }

  private emit(value: string): void {
    this.tail.append(redactSensitiveText(value, this.secrets))
  }
}

function needsWindowsPnpmShim(executable: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false
  const basename = executable.split(/[\\/]/).at(-1)?.toLowerCase()
  return basename === 'pnpm' || basename === 'pnpm.cmd'
}

export function createCommandRunner(options: CommandRunnerOptions = {}): CommandRunner {
  const spawn = options.spawn ?? nodeSpawn
  const platform = options.platform ?? process.platform
  const outputLimitBytes = normalizeOutputLimit(options.outputLimitBytes)
  const stopGraceMs = normalizeStopGrace(options.stopGraceMs)
  const configuredSecrets = uniqueSecrets(options.secrets ?? [])
  const persistent = new Map<string, PersistentEntry>()
  let stoppingPersistent = false
  let stopAllPromise: Promise<void> | undefined

  function start(command: CommandSpec): RunningChild {
    const secrets = uniqueSecrets([
      ...configuredSecrets,
      ...sensitiveEnvironmentValues(command.env),
    ])
    const stdout = new RedactedByteTail(outputLimitBytes, secrets)
    const stderr = new RedactedByteTail(outputLimitBytes, secrets)
    const spawnOptions: SpawnOptions = {
      // Windows pnpm installations are commonly .cmd shims. Limit shell use to
      // that trusted package-manager boundary; every other command stays direct.
      shell: needsWindowsPnpmShim(command.executable, platform),
      ...(platform === 'win32' ? {} : { detached: true }),
    }
    if (command.cwd !== undefined) spawnOptions.cwd = command.cwd
    if (command.env !== undefined) spawnOptions.env = command.env

    const child = spawn(command.executable, command.args, spawnOptions)
    child.stdout?.on('data', chunk => stdout.append(chunk as Buffer))
    child.stderr?.on('data', chunk => stderr.append(chunk as Buffer))

    let spawnError: Error | undefined
    const started = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', error => {
        spawnError = sanitizedError(error, secrets)
        reject(spawnError)
      })
    })
    const done = new Promise<CommandResult>((resolve, reject) => {
      child.once('close', (exitCode, signal) => {
        if (spawnError !== undefined) {
          reject(spawnError)
          return
        }
        resolve({
          exitCode,
          signal,
          stdout: stdout.finish(),
          stderr: stderr.finish(),
        })
      })
    })

    return { child, started, done }
  }

  return {
    async run(command, signal) {
      if (signal?.aborted) throw abortError()

      const running = start(command)
      let aborted = false
      let aborting: Promise<void> | undefined
      const abort = () => {
        if (aborted) return
        aborted = true
        aborting = running.started
          .catch(() => undefined)
          .then(() => terminateChild(running, stopGraceMs))
      }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        await running.started
        const result = await running.done
        if (aborted) throw abortError()
        return result
      } catch (error) {
        if (aborted) {
          await aborting?.catch(() => undefined)
          throw abortError()
        }
        await running.done.catch(() => undefined)
        throw error
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    },

    ensurePersistent(key, command) {
      if (stoppingPersistent) return Promise.reject(persistentRunnerStopping())

      const existing = persistent.get(key)
      if (existing !== undefined) {
        if (existing.stopping !== undefined) {
          return Promise.reject(persistentProcessStopping(key))
        }
        if (!commandsEqual(existing.command, command)) {
          return Promise.reject(persistentConflict(key))
        }
        return existing.ready
      }

      const storedCommand = cloneCommand(command)
      let entry!: PersistentEntry
      const ready = (async (): Promise<PersistentProcess> => {
        const running = start(storedCommand)
        try {
          await running.started
        } catch (error) {
          await running.done.catch(() => undefined)
          throw error
        }

        let handle!: PersistentProcess
        let stopPromise: Promise<void> | undefined
        handle = {
          key,
          command: storedCommand,
          pid: running.child.pid,
          done: running.done,
          stop() {
            if (stopPromise !== undefined) return stopPromise
            stopPromise = terminateChild(running, stopGraceMs)
            entry.stopping = stopPromise
            void stopPromise.then(
              () => {
                if (persistent.get(key) === entry) persistent.delete(key)
              },
              () => {
                if (persistent.get(key) === entry) persistent.delete(key)
              },
            )
            return stopPromise
          },
        }
        void running.done.then(
          () => {
            if (entry.stopping === undefined && persistent.get(key) === entry) {
              persistent.delete(key)
            }
          },
          () => {
            if (entry.stopping === undefined && persistent.get(key) === entry) {
              persistent.delete(key)
            }
          },
        )
        return handle
      })()
      entry = { command: storedCommand, ready }
      persistent.set(key, entry)
      void ready.catch(() => {
        if (persistent.get(key) === entry) persistent.delete(key)
      })
      return ready
    },

    stopAll() {
      if (stopAllPromise !== undefined) return stopAllPromise

      stoppingPersistent = true
      const entries = [...persistent.values()]
      const operation = Promise.all(entries.map(entry =>
        entry.ready.then(process => process.stop(), () => undefined),
      )).then(() => undefined)
      stopAllPromise = operation.finally(() => {
        stoppingPersistent = false
        stopAllPromise = undefined
      })
      return stopAllPromise
    },

    get persistentCount() {
      return persistent.size
    },
  }
}

function normalizeOutputLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OUTPUT_LIMIT_BYTES
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('outputLimitBytes must be a positive safe integer')
  }
  return value
}

function normalizeStopGrace(value: number | undefined): number {
  if (value === undefined) return 2_000
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('stopGraceMs must be a non-negative safe integer')
  }
  return value
}

function childIsRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

async function terminateChild(running: RunningChild, graceMs: number): Promise<void> {
  await signalProcessTree(running.child, 'SIGTERM')
  if (childIsRunning(running.child)) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      running.done.then(() => false, () => false),
      new Promise<true>(resolve => {
        timer = setTimeout(resolve, graceMs, true)
        timer.unref?.()
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (timedOut || processTreeIsRunning(running.child)) {
      await signalProcessTree(running.child, 'SIGKILL')
    }
  } else if (processTreeIsRunning(running.child)) {
    await signalProcessTree(running.child, 'SIGKILL')
  }
  await running.done
}

function processTreeIsRunning(child: ChildProcess): boolean {
  if (process.platform === 'win32' || child.pid === undefined) return childIsRunning(child)
  try {
    process.kill(-child.pid, 0)
    return true
  } catch {
    return false
  }
}

async function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  if (child.pid === undefined) {
    if (childIsRunning(child)) child.kill(signal)
    return
  }

  if (process.platform === 'win32') {
    await taskkill(child.pid, signal === 'SIGKILL')
    return
  }

  try {
    process.kill(-child.pid, signal)
  } catch {
    if (childIsRunning(child)) child.kill(signal)
  }
}

function taskkill(pid: number, force: boolean): Promise<void> {
  return new Promise(resolve => {
    const args = ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])]
    let child: ChildProcess
    try {
      child = nodeSpawn('taskkill.exe', args, {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      resolve()
      return
    }
    child.once('error', () => resolve())
    child.once('close', () => resolve())
  })
}

function sensitiveEnvironmentValues(
  env: Readonly<Record<string, string | undefined>> | undefined,
): string[] {
  if (env === undefined) return []
  return Object.entries(env)
    .filter(([name, value]) => value !== undefined && SENSITIVE_ENVIRONMENT_NAME.test(name))
    .map(([, value]) => value as string)
}

function uniqueSecrets(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => value.length > 0))]
    .sort((left, right) => right.length - left.length)
}

export function redactSensitiveText(
  value: string,
  secrets: readonly string[] = [],
): string {
  let sanitized = value
    .replace(AUTHORIZATION_HEADER, `Authorization: ${REDACTION}`)
    .replace(BEARER_TOKEN, `Bearer ${REDACTION}`)
    .replace(SENSITIVE_ASSIGNMENT, (_match, key: string, separator: string) =>
      `${key}${separator}${REDACTION}`)
  for (const secret of uniqueSecrets(secrets)) {
    sanitized = sanitized.split(secret).join(REDACTION)
  }
  return sanitized
}

function sanitizedError(error: Error, secrets: readonly string[]): Error & { code?: unknown } {
  const sanitized = new Error(redactSensitiveText(error.message, secrets)) as Error & {
    code?: unknown
  }
  sanitized.name = error.name
  if ('code' in error) sanitized.code = (error as Error & { code?: unknown }).code
  return sanitized
}

function decodeUtf8Tail(value: Buffer): string {
  for (let offset = 0; offset < Math.min(4, value.length + 1); offset += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(value.subarray(offset))
    } catch {
      // A bounded byte tail may begin in the middle of one UTF-8 code point.
    }
  }
  return value.toString('utf8')
}

function cloneCommand(command: CommandSpec): CommandSpec {
  return {
    executable: command.executable,
    args: [...command.args],
    ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    ...(command.env === undefined ? {} : { env: { ...command.env } }),
  }
}

function commandsEqual(left: CommandSpec, right: CommandSpec): boolean {
  if (left.executable !== right.executable || left.cwd !== right.cwd) return false
  if (left.args.length !== right.args.length) return false
  if (left.args.some((value, index) => value !== right.args[index])) return false

  const leftEnv = left.env
  const rightEnv = right.env
  if (leftEnv === undefined || rightEnv === undefined) return leftEnv === rightEnv
  const leftKeys = Object.keys(leftEnv).sort()
  const rightKeys = Object.keys(rightEnv).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && leftEnv[key] === rightEnv[key])
}

function persistentConflict(key: string): Error & { code: string } {
  return Object.assign(
    new Error(`persistent command conflict for key: ${key}`),
    { code: 'PERSISTENT_COMMAND_CONFLICT' },
  )
}

function persistentProcessStopping(key: string): Error & { code: string } {
  return Object.assign(
    new Error(`persistent process is stopping for key: ${key}`),
    { code: 'PERSISTENT_PROCESS_STOPPING' },
  )
}

function persistentRunnerStopping(): Error & { code: string } {
  return Object.assign(
    new Error('persistent process registry is stopping'),
    { code: 'PERSISTENT_RUNNER_STOPPING' },
  )
}

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}
