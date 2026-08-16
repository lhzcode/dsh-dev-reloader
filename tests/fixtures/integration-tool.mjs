/**
 * Real subprocess tool executed by the supervisor's `build` / `dev:web`
 * commands during integration tests. It is spawned as `node <this> <mode>`
 * with `cwd` set to a fixture plugin root, so all state lives in that directory
 * and never touches the test process.
 *
 * All writes go under `<cwd>/generated/`, which the integration config ignores
 * (`ignored: ['generated/**']`), so a completed build or a ready marker never
 * re-triggers a watch cycle and destabilizes the routing being asserted.
 *
 * Modes:
 *   build    - run one build cycle. Honors a `build-mode` file in cwd:
 *               "fail"  -> exit 1, writes no success marker
 *               "block" -> writes the marker then holds the process alive
 *               default -> writes the marker and exits 0
 *   dev-web  - "persistent" client watcher: writes a ready marker, then holds
 *              the process alive (like `tsdown --watch`); stopped when the
 *              supervisor's runner shuts it down.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function main() {
  const mode = process.argv[2]
  const cwd = process.cwd()

  if (mode === 'build') {
    const generatedDir = join(cwd, 'generated')
    mkdirSync(generatedDir, { recursive: true })
    let mode_ = ''
    try {
      // The mode file lives inside `generated/` (ignored by the supervisor), so
      // writing it never re-triggers a watch cycle.
      mode_ = readFileSync(join(generatedDir, 'build-mode'), 'utf8').trim()
    } catch {
      mode_ = ''
    }
    if (mode_ === 'fail') {
      process.stderr.write('integration build failed\n')
      process.exitCode = 1
    } else {
      writeFileSync(join(generatedDir, 'build.generated'), mode_ || 'ok', 'utf8')
      process.stdout.write('integration build ok\n')
      if (mode_ === 'block') {
        // Hold the process so a debounce/recovery waits on a live build.
        setInterval(() => undefined, 60_000)
      }
    }
    return
  }

  if (mode === 'dev-web') {
    const generatedDir = join(cwd, 'generated')
    mkdirSync(generatedDir, { recursive: true })
    writeFileSync(join(generatedDir, 'dev-web.ready'), String(process.pid), 'utf8')
    process.stdout.write('integration dev-web ready\n')
    // tsdown --watch analogue: keep the watcher child alive until killed.
    setInterval(() => undefined, 60_000)
    return
  }

  process.stderr.write(`unknown integration tool mode: ${String(mode)}\n`)
  process.exitCode = 2
}

main()
