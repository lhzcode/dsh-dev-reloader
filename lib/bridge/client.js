import { connectToSupervisor, } from '../supervisor/ipc.js';
export function createBridgeClient(options) {
    let client;
    let latestStatus;
    async function start() {
        if (client !== undefined)
            return;
        const connected = await options.connect({
            endpoint: options.endpoint,
            token: options.token,
            hello: options.hello,
            onEvent: (event) => {
                if (event.type === 'status') {
                    latestStatus = event.status;
                    options.onStatus?.(event.status);
                }
            },
        });
        client = connected;
    }
    // Always return a rejected promise (never throw synchronously) so callers
    // such as `void bridge.emit(...).catch(...)` can observe the disconnect.
    const disconnectedError = () => new Error('supervisor is not connected');
    return {
        get status() {
            return latestStatus;
        },
        get connected() {
            return client !== undefined && !client.closed;
        },
        start,
        emit(event) {
            if (client === undefined)
                return Promise.reject(disconnectedError());
            return client.emit(event);
        },
        request(command) {
            if (client === undefined)
                return Promise.reject(disconnectedError());
            return client.request(command);
        },
        async close() {
            const current = client;
            client = undefined;
            if (current !== undefined && !current.closed) {
                await current.close();
            }
        },
    };
}
export { connectToSupervisor };
//# sourceMappingURL=client.js.map