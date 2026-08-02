import fs from 'fs';
import { onboardingStatePath } from '../config/settings/runtime-home.js';
import { nowIso } from '../shared/time/datetime.js';
export function createInitialState(runtimeHome) {
    return {
        version: 1,
        status: 'in_progress',
        currentStep: 'welcome',
        updatedAt: nowIso(),
        data: { runtimeHome },
    };
}
export function readOnboardingState(runtimeHome) {
    const filePath = onboardingStatePath(runtimeHome);
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.version !== 1)
            return null;
        if (!parsed.data || typeof parsed.data.runtimeHome !== 'string')
            return null;
        if (parsed.status !== 'in_progress' && parsed.status !== 'completed') {
            return null;
        }
        if (!parsed.currentStep)
            return null;
        return {
            version: 1,
            status: parsed.status,
            currentStep: parsed.currentStep,
            updatedAt: parsed.updatedAt || nowIso(),
            data: parsed.data,
        };
    }
    catch {
        return null;
    }
}
export function writeOnboardingState(runtimeHome, state) {
    const filePath = onboardingStatePath(runtimeHome);
    const next = {
        ...state,
        version: 1,
        updatedAt: nowIso(),
        data: {
            ...state.data,
            runtimeHome,
        },
    };
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
    });
    try {
        fs.chmodSync(filePath, 0o600);
    }
    catch {
        // Best effort on filesystems without POSIX modes.
    }
}
export function clearOnboardingState(runtimeHome) {
    const filePath = onboardingStatePath(runtimeHome);
    try {
        fs.unlinkSync(filePath);
    }
    catch {
        // no-op
    }
}
