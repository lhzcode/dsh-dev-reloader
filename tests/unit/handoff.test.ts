import { mkdtemp, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PROTOCOL_VERSION } from '../../src/shared/protocol.js'
import type { HostLaunchSpec } from '../../src/shared/protocol.js'
import type { SupervisorConfig } from '../../src/shared/config.js'
import {
  connectForHandoff,
  createHandoffFollow,
  createHandoffLead,
  decodeHandoffSnapshot,
  listenForHandoff,
  resolveHandoffEndpoint,
  type HandoffChannel,
  type HandoffFollowHooks,
  type HandoffLeadHooks,
  type HandoffMessage,
  type HandoffSnapshot,
  type SupervisorHandoff,
} from '../../src/supervisor/handoff.js'
import type { RuntimePaths } from '../../src/supervisor/paths.js'

const CONFIG: SupervisorConfig = {
  enabled: true,
  profile: 'web',
  sourceRoots: [],
  debounceMs: 250,
  healthTimeoutMs: 60_000,
  shutdownGraceMs: 10_000,
  bridgeGraceMs: 10_000,
  crashWindowMs: 60_000,
  maxCrashRestarts: 3,
  ignored: [],
  projectOverrides: [],
  logLevel: 'info',
}

const LAUNCH: HostLaunchSpec = {
  pid: 42,
  bootId: 'handoff-boot',
  nodeExecutable: process.execPath,
  execArgv: [],
  argv: ['fake-dsh', 'web'],
  cwd: '/repo',
  env: { DSH_DEV_BOOT_ID: 'handoff-boot' },
  profile: 'web',
  webUrl: 'http://127.0.0.1:1',
}

/** The in-memory launch environment payload is carried only across the handoff channel. */
function snapshot(transactionId = 'txn-1', generation = 1): HandoffSnapshot {
  return { protocolVersion: PROTOCOL_VERSION, transactionId, generation, launch: LAUNCH, config: CONFIG }
}

interface Duplex {
  readonly lead: HandoffChannel
  readonly follow: HandoffChannel
}

/** A duplex pair delivered asynchronously, like the two ends of one authenticated socket. */
function duplex(): Duplex {
  let leadListener: ((message: HandoffMessage) => Promise<void>) | undefined
  let followListener: ((message: HandoffMessage) => Promise<void>) | undefined

  const deliver = (
    listener: ((message: HandoffMessage) => Promise<void>) | undefined,
    message: HandoffMessage,
  ): Promise<void> => new Promise<void>(resolve => {
    setImmediate(() => {
      if (listener !== undefined) void Promise.resolve(listener(message)).then(() => resolve(), () => resolve())
      else resolve()
    })
  })

  const lead: HandoffChannel = {
    async send(message) {
      await deliver(followListener, message)
    },
    onMessage(listener) {
      leadListener = listener
      return () => { if (leadListener === listener) leadListener = undefined }
    },
  }
  const follow: HandoffChannel = {
    async send(message) {
      await deliver(leadListener, message)
    },
    onMessage(listener) {
      followListener = listener
      return () => { if (followListener === listener) followListener = undefined }
    },
  }
  return { lead, follow }
}

interface WiredHandoff {
  readonly lead: SupervisorHandoff
  readonly events: string[]
  followStart(): Promise<void>
}

function wire(
  overrides?: {
    readonly readyToPrepare?: () => boolean | Promise<boolean>
    readonly leadCreateSnapshot?: () => HandoffSnapshot | Promise<HandoffSnapshot>
    readonly leadResume?: () => void | Promise<void>
    readonly followVerifyStillOwner?: () => boolean | Promise<boolean>
  },
): WiredHandoff {
  const events: string[] = []
  const { lead, follow } = duplex()

  const leadHooks: HandoffLeadHooks = {
    readyToPrepare: overrides?.readyToPrepare ?? vi.fn(async () => { events.push('ready'); return true }),
    createSnapshot: overrides?.leadCreateSnapshot ?? vi.fn(async () => { events.push('snapshot'); return snapshot() }),
    freezeMutations: vi.fn(async () => { events.push('freeze') }),
    transferOwnership: vi.fn(async () => { events.push('transfer') }),
    resume: overrides?.leadResume ?? vi.fn(async () => { events.push('resume') }),
  }
  const followHooks: HandoffFollowHooks = {
    acceptSnapshot: vi.fn(async value => { events.push(`accept:${value.transactionId}`) }),
    acquireOwnership: vi.fn(async () => { events.push('acquire') }),
    releaseOwnership: vi.fn(async () => { events.push('release') }),
    beginServing: vi.fn(async () => { events.push('serve') }),
    verifyStillOwner: overrides?.followVerifyStillOwner ?? vi.fn(async () => true),
  }
  const coordinator = createHandoffLead(leadHooks, lead)
  const follower = createHandoffFollow(followHooks, follow)
  return {
    lead: coordinator.handoff,
    events,
    followStart: () => follower.start(),
  }
}

async function commitHandoff(overrides?: Parameters<typeof wire>[0]): Promise<WiredHandoff> {
  const harness = wire(overrides)
  const followRun = harness.followStart()
  await harness.lead.prepare()
  await harness.lead.freeze()
  await harness.lead.commit()
  await followRun
  return harness
}

describe('supervisor self-handoff', () => {
  it('carries the in-memory launch environment only across the handoff channel', async () => {
    const harness = await commitHandoff()
    expect(harness.events).toContain('snapshot')
    expect(harness.events).toContain('accept:txn-1')
  })

  it('rejects prepare when the old supervisor is not watching or not healthy', async () => {
    const harness = wire({ readyToPrepare: async () => false })
    const followRun = harness.followStart()
    await expect(harness.lead.prepare()).rejects.toThrow(/watching|healthy|not active/i)
    await followRun
    expect(harness.events).not.toContain('accept:txn-1')
  })

  it('rejects prepare when the snapshot cannot be captured and resumes the old supervisor', async () => {
    const harness = wire({
      leadCreateSnapshot: async () => { throw new Error('snapshot unreadable') },
    })
    const followRun = harness.followStart()
    await expect(harness.lead.prepare()).rejects.toThrow(/snapshot/i)
    await followRun
    expect(harness.events).toContain('resume')
  })

  it('freezes the old supervisor (stops mutations) before ownership moves', async () => {
    const harness = wire()
    const followRun = harness.followStart()
    await harness.lead.prepare()
    await harness.lead.freeze()
    await harness.lead.commit()
    await followRun
    expect(harness.events.indexOf('freeze')).toBeLessThan(harness.events.indexOf('transfer'))
  })

  it('keeps ownership-transfer transport failures recoverable as frozen', async () => {
    let leadListener: ((message: HandoffMessage) => void | Promise<void>) | undefined
    const resume = vi.fn(async () => undefined)
    const channel: HandoffChannel = {
      async send(message) {
        if (message.type === 'handoff-snapshot') {
          setImmediate(() => { void leadListener?.({ protocolVersion: PROTOCOL_VERSION, type: 'handoff-prepared' }) })
        } else if (message.type === 'handoff-freeze') {
          throw new Error('freeze transport failed')
        }
      },
      onMessage(listener) {
        leadListener = listener
        return () => { if (leadListener === listener) leadListener = undefined }
      },
    }
    const handoff = createHandoffLead({
      readyToPrepare: async () => true,
      createSnapshot: async () => snapshot(),
      freezeMutations: async () => undefined,
      transferOwnership: async () => undefined,
      resume,
    }, channel).handoff

    await handoff.prepare()
    await expect(handoff.freeze()).rejects.toThrow('freeze transport failed')
    expect(handoff.phase).toBe('frozen')
    await handoff.abort()
    expect(resume).toHaveBeenCalledOnce()
    expect(handoff.phase).toBe('aborted')
  })

  it('transfers ownership atomically so exactly one side owns the endpoint after commit', async () => {
    const harness = await commitHandoff()
    expect(harness.events).toContain('transfer')
    expect(harness.events).toContain('acquire')
    expect(harness.events.indexOf('transfer')).toBeLessThan(harness.events.indexOf('acquire'))
    expect(harness.events).toContain('serve')
  })

  it('aborts before commit and resumes the old supervisor fully', async () => {
    const harness = wire()
    const followRun = harness.followStart()
    await harness.lead.prepare()
    await harness.lead.abort()
    await followRun
    expect(harness.events).toContain('resume')
    expect(harness.events).not.toContain('transfer')
    expect(harness.events).not.toContain('serve')
  })

  it('fails closed on ambiguous ownership so at most one side serves the endpoint', async () => {
    const harness = wire({
      // The standby sees it did not actually win the exclusive lease.
      followVerifyStillOwner: async () => false,
    })
    const followRun = harness.followStart()
    await harness.lead.prepare()
    await harness.lead.freeze()
    await expect(harness.lead.commit()).rejects.toThrow(/owner|ambiguous/i)
    await followRun
    expect(harness.events).toContain('resume')
    expect(harness.events).not.toContain('serve')
  })

  it('releases the standby lease on an abort/backoff return path after acquisition', async () => {
    const events: string[] = []
    const { lead, follow } = duplex()
    const followHooks: HandoffFollowHooks = {
      acceptSnapshot: vi.fn(async () => { events.push('accept') }),
      acquireOwnership: vi.fn(async () => { events.push('acquire') }),
      verifyStillOwner: vi.fn(async () => {
        // The standby acquired ownership but the old is still holding the lease.
        events.push('verify:false')
        return false
      }),
      beginServing: vi.fn(async () => { events.push('serve') }),
      releaseOwnership: vi.fn(async () => { events.push('release') }),
    }
    const follower = createHandoffFollow(followHooks, follow)
    const followerRun = follower.start()

    // Drive the follow through reduce: lead sends snapshot, then the follow
    // verifies ownership and fails, so it must release the acquired lease.
    const message = (type: HandoffMessage['type']): HandoffMessage =>
      ({ protocolVersion: PROTOCOL_VERSION, type }) as HandoffMessage
    await lead.send({ protocolVersion: PROTOCOL_VERSION, type: 'handoff-snapshot', snapshot: snapshot() })
    await delay(10)
    await lead.send(message('handoff-freeze'))
    await followerRun
    expect(events).toContain('acquire')
    expect(events).toContain('release')
    expect(events).not.toContain('serve')
  })
})

const rootsForTeardown: string[] = []
const endpointsForTeardown: string[] = []
afterEach(async () => {
  await Promise.all(endpointsForTeardown.splice(0).map(endpoint => import('node:fs/promises').then(m => m.unlink(endpoint).catch(() => undefined))))
  await Promise.all(rootsForTeardown.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

async function tempHandoffPaths(): Promise<{ paths: RuntimePaths; transactionId: string; endpoint: string }> {
  const { resolveRuntimePaths } = await import('../../src/supervisor/paths.js')
  // Use a SHORT temp base so the one-use socket lives in the controlled stateDir
  // (under the Unix path bound) instead of a long `/var/folders` fallback that is
  // prone to parallel-worker filesystem flakiness.
  const shortBase = shortTempBase()
  const root = await mkdtemp(join(shortBase, 'dshh-'))
  rootsForTeardown.push(root)
  const paths = await resolveRuntimePaths({ dshHome: root, profile: 'w' })
  const transactionId = randomHex(16)
  return { paths, transactionId, endpoint: resolveHandoffEndpoint(paths, transactionId) }
}

function shortTempBase(): string {
  if (process.platform === 'win32') return tmpdir()
  const candidate = process.platform === 'darwin' ? '/private/tmp' : '/tmp'
  return candidate
}

function randomHex(bytes: number): string {
  return randomUUID().replace(/-/g, '').slice(0, bytes * 2)
}

describe('handoff transport', () => {
  describe('F8 snapshot decode validation', () => {
    function rawSnapshot(mutate: (value: Record<string, unknown>) => void) {
      const value: Record<string, unknown> = {
        protocolVersion: PROTOCOL_VERSION,
        transactionId: 'txn-1',
        generation: 1,
        launch: {
          pid: 42,
          bootId: 'handoff-boot',
          nodeExecutable: process.execPath,
          execArgv: [],
          argv: ['fake-dsh', 'web'],
          cwd: '/repo',
          env: { DSH_DEV_BOOT_ID: 'handoff-boot' },
          profile: 'web',
          webUrl: 'http://127.0.0.1:1',
        },
        config: CONFIG,
      }
      mutate(value)
      return value
    }

    it('rejects a snapshot carrying an oversized env entry', () => {
      const bad = rawSnapshot(value => {
        const launch = value.launch as Record<string, unknown>
        const env = launch.env as Record<string, string | undefined>
        env.PAD = 'x'.repeat(17 * 1024)
      })
      expect(() => decodeHandoffSnapshot(bad)).toThrow(/env|launch/i)
    })

    it('rejects a snapshot carrying an invalid config field', () => {
      const bad = rawSnapshot(value => {
        value.config = { ...CONFIG, debounceMs: -5 }
      })
      expect(() => decodeHandoffSnapshot(bad)).toThrow(/config/i)
    })
  })

  describe('F7 mutual authentication', () => {
    it('a peer without the token cannot complete the handshake in either direction', async () => {
      const { transactionId, endpoint } = await tempHandoffPaths()
      // Server holds one token, client holds another: each side rejects the other,
      // and no side leaks an unobserved auth-failure rejection.
      const handlePromise = listenForHandoff({ endpoint, token: 'b'.repeat(64), transactionId })
      const unhandled: unknown[] = []
      const onUnhandled = (error: unknown): void => { unhandled.push(error) }
      process.on('unhandledRejection', onUnhandled)
      // Attach the server-side rejection assertion immediately so the auth
      // failure can never fire unobserved while the client retries to connect.
      const handleAssertion = expect(handlePromise).rejects.toThrow(/auth|failed|closed|disconnect/i)
      try {
        // Retry until the server is bound (a real auth failure, not ENOENT).
        let authError: unknown
        const deadline = Date.now() + 5_000
        for (;;) {
          try {
            await connectForHandoff({ endpoint, token: 'a'.repeat(64), transactionId })
            throw new Error('expected the standby to reject a peer without the token')
          } catch (error) {
            if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT' && Date.now() < deadline) {
              await delay(20)
              continue
            }
            authError = error
            break
          }
        }
        await handleAssertion
        expect(authError).toBeDefined()
        expect(String(authError)).toMatch(/auth|failed|closed|disconnect|reject/i)
        await new Promise<void>(resolve => setImmediate(resolve))
        await Promise.resolve()
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })

    it('a standby that backtends the wrong server proof cannot satisfy the lead', async () => {
      const { transactionId, endpoint } = await tempHandoffPaths()
      const { createServer } = await import('node:net')
      const server = createServer(socket => {
        const serverNonce = 'f'.repeat(32)
        socket.setEncoding('utf8')
        let buffer = ''
        socket.write(JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          type: 'handoff-auth-challenge',
          serverNonce,
        }) + '\n', 'utf8')
        socket.on('data', chunk => {
          buffer += chunk
          const line = buffer
          buffer = ''
          try {
            const frame = JSON.parse(line)
            if (frame.type === 'handoff-auth') {
              // Server responds with WRONG proof (does not know the token).
              socket.write(JSON.stringify({
                protocolVersion: PROTOCOL_VERSION,
                type: 'handoff-auth-ok',
                serverNonce,
                proof: '0'.repeat(32),
              }) + '\n', 'utf8')
            }
          } catch {
            socket.destroy()
          }
        })
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(endpoint, resolve)
      })
      try {
        await expect(
          connectForHandoff({ endpoint, token: 'a'.repeat(64), transactionId }),
        ).rejects.toThrow(/auth|proof|reject|failed/i)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
        await import('node:fs/promises').then(m => m.unlink(endpoint).catch(() => undefined))
      }
    })
  })

  describe('F3 protocol deadline and close rejection', () => {
    it('a lead message wait rejects within the protocol deadline instead of hanging', async () => {
      const { lead, follow } = duplex()
      // A follow side that never replies: swallow the incoming snapshot so the
      // lead's `handoff-prepared` wait must time out quickly.
      follow.onMessage(() => undefined)
      const captured = snapshot()
      const leadHooks: HandoffLeadHooks = {
        readyToPrepare: vi.fn(async () => true),
        createSnapshot: vi.fn(async () => captured),
        freezeMutations: vi.fn(),
        transferOwnership: vi.fn(),
        resume: vi.fn(),
      }
      const coordinator = createHandoffLead(leadHooks, lead, { timeoutMs: 100 })
      const started = new Date()
      await expect(coordinator.handoff.prepare()).rejects.toThrow(/timeout|protocol/i)
      expect(new Date().getTime() - started.getTime()).toBeLessThan(5_000)
    })

    it('a half-close mid-protocol rejects the peer wait instead of hanging', async () => {
      const { transactionId, endpoint } = await tempHandoffPaths()
      const [handle, connect] = await Promise.all([
        listenForHandoff({ endpoint, token: 'a'.repeat(64), transactionId }),
        connectForHandoff({ endpoint, token: 'a'.repeat(64), transactionId }),
      ])
      const acquireOwnership = vi.fn(async () => undefined)
      const releaseOwnership = vi.fn(async () => undefined)
      const followWait = (async () => {
        const follower = createHandoffFollow({
          acceptSnapshot: async () => undefined,
          acquireOwnership,
          verifyStillOwner: async () => true,
          beginServing: async () => undefined,
          releaseOwnership,
        }, handle.channel, { timeoutMs: 500 })
        return follower.start()
      })()
      // Attach the rejection assertion immediately so the forced socket close
      // cannot leave the follow's wait rejection unobserved.
      const followAssertion = expect(followWait).rejects.toThrow(/closed|disconnect|failed|closed channel/i)
      // Drive the standby through acquisition, then close while it waits for the
      // final decision. Its finally path must release the acquired lease.
      await connect.channel.send({
        protocolVersion: PROTOCOL_VERSION,
        type: 'handoff-snapshot',
        snapshot: snapshot(),
      })
      await delay(20)
      await connect.channel.send({ protocolVersion: PROTOCOL_VERSION, type: 'handoff-freeze' })
      await vi.waitFor(() => expect(acquireOwnership).toHaveBeenCalledOnce())
      await connect.close()
      await followAssertion
      expect(releaseOwnership).toHaveBeenCalledOnce()
      await handle.close()
      await import('node:fs/promises').then(m => m.unlink(endpoint).catch(() => undefined))
    })
  })

  describe('F4 listening server teardown', () => {
    it('removes the one-use socket node and closes the listening handle after commit', async () => {
      const { transactionId, endpoint } = await tempHandoffPaths()
      const [handle, connect] = await Promise.all([
        listenForHandoff({ endpoint, token: 'a'.repeat(64), transactionId }),
        connectForHandoff({ endpoint, token: 'a'.repeat(64), transactionId }),
      ])
      await connect.channel.send({
        protocolVersion: PROTOCOL_VERSION,
        type: 'handoff-snapshot',
        snapshot: snapshot(),
      })
      await delay(20)
      await connect.close()
      await handle.close()
      const exists = await stat(endpoint).then(() => true, () => false)
      expect(exists).toBe(false)
    })
  })
})
