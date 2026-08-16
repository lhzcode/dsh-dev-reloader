import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink, } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { requireSafeProfileName } from '../shared/profile.js';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
/** macOS sockaddr_un.sun_path is 104 bytes including its trailing NUL. */
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;
function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : undefined;
}
async function ensurePrivateDirectory(path, platform) {
    try {
        await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    const pathMetadata = await lstat(path);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isDirectory()) {
        throw new Error(`private runtime path is not a real directory: ${path}`);
    }
    if (platform === 'win32')
        return;
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        let metadata = await handle.stat();
        if (!metadata.isDirectory()
            || metadata.dev !== pathMetadata.dev
            || metadata.ino !== pathMetadata.ino) {
            throw new Error(`private runtime directory changed during validation: ${path}`);
        }
        const uid = currentUid();
        if (uid !== undefined && metadata.uid !== uid) {
            throw new Error(`private runtime directory is not owned by the current user: ${path}`);
        }
        if ((metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
            await handle.chmod(PRIVATE_DIRECTORY_MODE);
            metadata = await handle.stat();
        }
        if ((metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
            throw new Error(`private runtime directory mode is not 0700: ${path}`);
        }
        if (uid !== undefined && metadata.uid !== uid) {
            throw new Error(`private runtime directory owner changed during validation: ${path}`);
        }
    }
    finally {
        await handle.close();
    }
}
function endpointIdentity(stateDir, profile, length) {
    return createHash('sha256')
        .update(stateDir)
        .update('\0')
        .update(profile)
        .digest('hex')
        .slice(0, length);
}
function windowsPipeName(stateDir, profile) {
    return `\\\\.\\pipe\\dsh-dev-reloader-${endpointIdentity(stateDir, profile, 24)}`;
}
async function unixSocketLocation(stateDir, profile, platform) {
    const local = join(stateDir, 'supervisor.sock');
    if (Buffer.byteLength(local) <= MAX_UNIX_SOCKET_PATH_BYTES) {
        return { endpoint: local, endpointDir: stateDir, endpointDirKind: 'state' };
    }
    const uid = currentUid();
    if (uid === undefined) {
        throw new Error('current uid is required for a private Unix socket fallback');
    }
    const endpointDir = join(tmpdir(), `dsh-dr-${uid}-${endpointIdentity(stateDir, profile, 16)}`);
    const endpoint = join(endpointDir, 's.sock');
    if (Buffer.byteLength(endpoint) > MAX_UNIX_SOCKET_PATH_BYTES) {
        throw new Error('temporary directory is too long for a safe Unix supervisor socket');
    }
    await ensurePrivateDirectory(endpointDir, platform);
    return { endpoint, endpointDir, endpointDirKind: 'temporary' };
}
export async function resolveRuntimePaths(options) {
    requireSafeProfileName(options.profile);
    const platform = options.platform ?? process.platform;
    if (options.dshHome !== undefined && options.dshHome.trim().length === 0) {
        throw new Error('explicit dshHome must not be blank');
    }
    const dshHome = resolveDshHome(options.dshHome, options.env ?? process.env);
    const stateDir = join(dshHome, 'plugins', 'dsh-dev-reloader', options.profile);
    await ensurePrivateDirectory(stateDir, platform);
    const endpointLocation = platform === 'win32'
        ? {
            endpoint: windowsPipeName(stateDir, options.profile),
            endpointDirKind: 'named-pipe',
        }
        : await unixSocketLocation(stateDir, options.profile, platform);
    return {
        platform,
        dshHome,
        profile: options.profile,
        stateDir,
        ...endpointLocation,
        tokenFile: join(stateDir, 'supervisor.token'),
        lockFile: join(stateDir, 'supervisor.lock'),
        guardFile: join(stateDir, 'supervisor.lock.guard'),
        logFile: join(stateDir, 'supervisor.log'),
    };
}
/** Remove a stale Unix socket after the caller has acquired the supervisor lock. */
export async function removeStaleSupervisorSocket(paths) {
    if (paths.endpointDirKind === 'named-pipe')
        return;
    let metadata;
    try {
        metadata = await lstat(paths.endpoint);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    if (!metadata.isSocket()) {
        throw new Error(`supervisor endpoint is not a socket: ${paths.endpoint}`);
    }
    await unlink(paths.endpoint);
}
async function syncDirectory(path, platform) {
    let handle;
    try {
        handle = await open(path, 'r');
        await handle.sync();
    }
    catch (error) {
        const code = error.code;
        if (platform !== 'win32' || (code !== 'EISDIR' && code !== 'EPERM' && code !== 'EINVAL')) {
            throw error;
        }
    }
    finally {
        await handle?.close();
    }
}
/** Write a same-directory temporary file, fsync it, then atomically rename it. */
export async function writePrivateFileAtomic(path, content, platform = process.platform, hooks = {}) {
    const directory = dirname(path);
    await ensurePrivateDirectory(directory, platform);
    const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
        handle = await open(temporary, 'wx', PRIVATE_FILE_MODE);
        await handle.writeFile(content, { encoding: 'utf8' });
        if (platform !== 'win32')
            await handle.chmod(PRIVATE_FILE_MODE);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, path);
        await hooks.beforeDirectorySync?.(directory);
        await syncDirectory(directory, platform);
    }
    catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
        throw error;
    }
}
//# sourceMappingURL=paths.js.map