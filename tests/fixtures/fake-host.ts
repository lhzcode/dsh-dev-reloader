import { createServer } from 'node:http'

// Prefer the lifecycle-injected boot id so a replacement fake host reports the
// exact bootId the supervisor expects, then fall back to the explicit override.
const bootId = process.env.DSH_DEV_BOOT_ID ?? process.env.FAKE_HOST_BOOT_ID ?? 'fake-boot'
const ignoreTerm = process.env.FAKE_HOST_IGNORE_TERM === '1'
const shutdownDelayMs = Number(process.env.FAKE_HOST_SHUTDOWN_DELAY_MS ?? '0')
const requestedPort = Number(process.env.FAKE_HOST_PORT ?? '0')
// Crash-recovery integration: a lifecycle-spawned replacement that must be
// observed as immediately-crashed exits right after binding its port, or as a
// delayed-crash host that serves health briefly (so the bridge can adopt it)
// before crashing.
const exitImmediately = process.env.FAKE_HOST_EXIT_IMMEDIATE === '1'
const crashAfterMs = Number(process.env.FAKE_HOST_CRASH_AFTER_MS ?? '0')

const server = createServer((request, response) => {
  // The supervisor's restart health check probes the web URL root (a real DSH
  // web host serves its UI there with 2xx), while the harness reads /health for
  // the boot id. Both must answer 2xx or restarts can never pass health.
  if (request.url === '/health' || request.url === '/') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, bootId, pid: process.pid }))
    return
  }
  response.writeHead(404)
  response.end()
})

server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected TCP address')
  process.stdout.write(`${JSON.stringify({ type: 'ready', pid: process.pid, port: address.port, bootId })}\n`)
  if (exitImmediately) {
    setTimeout(() => process.exit(1), 50).unref()
  } else if (crashAfterMs > 0) {
    // Serve health for a short window (so a bridge can adopt the pid and boot
    // id) then crash, exercising the correlated-crash circuit in the lifecycle.
    setTimeout(() => process.exit(1), crashAfterMs).unref()
  }
})

function shutdown(signal: string): void {
  process.stdout.write(`${JSON.stringify({ type: 'signal', signal })}\n`)
  if (ignoreTerm && signal === 'SIGTERM') return
  setTimeout(() => server.close(() => process.exit(0)), shutdownDelayMs).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
