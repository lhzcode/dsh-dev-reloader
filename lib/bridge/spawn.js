import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Resolve the supervisor CLI entry under the current package's `lib`. */
export function resolveSupervisorCli(moduleUrl) {
    const modulePath = fileURLToPath(moduleUrl ?? import.meta.url);
    // Built module lives at <package>/lib/bridge/spawn.js → <package>/lib/supervisor/cli.js
    return join(dirname(dirname(modulePath)), 'supervisor', 'cli.js');
}
/**
 * Launch the dev supervisor as a detached daemon so it outlives the host.
 * The child inherits `process.execPath`, ignored stdio, and is unref'd so it
 * never keeps the host's event loop alive.
 */
export function spawnSupervisor(options) {
    const doSpawn = options.spawn ?? nodeSpawn;
    const packageRoot = dirname(dirname(options.cliPath));
    const processChild = doSpawn(process.execPath, [options.cliPath, '--serve', '--profile', options.profile], {
        shell: false,
        detached: true,
        stdio: 'ignore',
        cwd: packageRoot,
        env: { ...process.env, ...options.env },
    });
    processChild.unref();
    const pid = processChild.pid;
    if (pid === undefined) {
        throw new Error('detached supervisor did not receive a PID');
    }
    return { process: processChild, pid };
}
//# sourceMappingURL=spawn.js.map