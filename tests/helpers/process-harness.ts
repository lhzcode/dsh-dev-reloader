import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export interface FakeHostReady {
  readonly type: 'ready'
  readonly pid: number
  readonly port: number
  readonly bootId: string
}

export interface FakeHostProcess {
  readonly child: ChildProcess
  readonly ready: Promise<FakeHostReady>
  stop(): Promise<void>
}

const fixture = fileURLToPath(new URL('../fixtures/fake-host.ts', import.meta.url))

export function spawnFakeHost(environment: Readonly<Record<string, string>> = {}): FakeHostProcess {
  const child = spawn(process.execPath, ['--experimental-strip-types', fixture], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...environment },
  })
  const ready = firstJsonLine(child).then(value => {
    if (
      value === null
      || typeof value !== 'object'
      || (value as { type?: unknown }).type !== 'ready'
    ) throw new Error('fake host did not report readiness')
    return value as FakeHostReady
  })
  return {
    child,
    ready,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGKILL')
      await new Promise<void>(resolve => child.once('close', () => resolve()))
    },
  }
}

function firstJsonLine(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      cleanup()
      try {
        resolve(JSON.parse(buffer.slice(0, newline)))
      } catch (error) {
        reject(error)
      }
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('fake host exited before readiness'))
    }
    const cleanup = () => {
      child.stdout?.off('data', onData)
      child.off('error', onError)
      child.off('close', onClose)
    }
    child.stdout?.on('data', onData)
    child.once('error', onError)
    child.once('close', onClose)
  })
}
