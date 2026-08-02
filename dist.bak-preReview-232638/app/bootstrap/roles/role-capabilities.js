const ROLE_CAPABILITIES = {
    all: {
        controlApi: 'full',
        liveExecution: true,
        jobExecution: true,
        providerInbound: true,
        settingsDesiredStateWrites: true,
        bakeExecution: true,
        workerRegistration: true,
    },
    control: {
        controlApi: 'full',
        liveExecution: false,
        jobExecution: false,
        providerInbound: false,
        settingsDesiredStateWrites: true,
        bakeExecution: false,
        workerRegistration: false,
    },
    'live-worker': {
        controlApi: 'ops',
        liveExecution: true,
        jobExecution: false,
        providerInbound: true,
        settingsDesiredStateWrites: false,
        bakeExecution: false,
        workerRegistration: true,
    },
    'job-worker': {
        controlApi: 'ops',
        liveExecution: false,
        jobExecution: true,
        providerInbound: false,
        settingsDesiredStateWrites: false,
        bakeExecution: true,
        workerRegistration: true,
    },
};
/** The frozen capability record for a role. */
export function roleCapabilities(role) {
    return ROLE_CAPABILITIES[role];
}
