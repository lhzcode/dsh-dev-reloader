import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Real-process integration tests (restart/crash/handoff) can take tens of
    // seconds on a loaded runner; their own harness waits are deadline-bounded,
    // so this cap is only a last-resort kill and must not fire mid-run (a
    // killed test leaks subprocesses and can poison the next test).
    testTimeout: 300_000,
    hookTimeout: 30_000,
    // The integration suite spawns real supervisor/fake-host subprocesses and
    // reaps them on a per-run port. Running test files in parallel made these
    // starts stall past their deadline and allowed cross-file process conflicts,
    // so the suite is executed serially for determinism.
    fileParallelism: false,
  },
})
