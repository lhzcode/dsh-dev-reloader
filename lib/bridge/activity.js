function collectJobCounts(listAll, listJobs) {
    const seen = new Set();
    let runningJobs = 0;
    let stoppingJobs = 0;
    const observe = (job) => {
        if (seen.has(job.id))
            return;
        seen.add(job.id);
        if (job.status === 'running')
            runningJobs += 1;
        else if (job.status === 'stopping')
            stoppingJobs += 1;
    };
    // Owner-scoped jobs, then unowned jobs (no caller), deduplicated by job id.
    for (const agent of listAll()) {
        for (const job of listJobs(agent))
            observe(job);
    }
    for (const job of listJobs(undefined))
        observe(job);
    return { runningJobs, stoppingJobs };
}
export function createActivityObserver(options) {
    const now = options.now ?? (() => Date.now());
    let sequence = 0;
    function snapshot() {
        let runningAgents = 0;
        for (const agent of options.roots()) {
            if (agent.status === 'running')
                runningAgents += 1;
        }
        const { runningJobs, stoppingJobs } = collectJobCounts(options.listAll, options.listJobs);
        sequence += 1;
        return {
            sequence,
            capturedAt: now(),
            runningAgents,
            runningJobs,
            stoppingJobs,
        };
    }
    function forwardReload(reloads) {
        const entries = [];
        for (const entry of reloads.values()) {
            if (entry?.filename)
                entries.push(entry.filename);
        }
        if (entries.length > 0)
            options.publishReload?.(entries);
    }
    function start() {
        const stopAgentStatus = options.subscribeAgentStatus(() => {
            options.publish(snapshot());
        });
        const stopJobsChanged = options.subscribeJobsChanged(() => {
            options.publish(snapshot());
        });
        const stopReload = options.subscribeReload(forwardReload);
        return () => {
            stopAgentStatus();
            stopJobsChanged();
            stopReload();
        };
    }
    return { snapshot, start, forwardReload };
}
//# sourceMappingURL=activity.js.map