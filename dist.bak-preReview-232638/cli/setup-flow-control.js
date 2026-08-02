import * as p from '@clack/prompts';
export function toAction(value) {
    if (p.isCancel(value))
        return { type: 'resume' };
    if (value === 'next')
        return { type: 'next' };
    if (value === 'start_now')
        return { type: 'start_now' };
    if (value === 'back')
        return { type: 'back' };
    if (value === 'resume')
        return { type: 'resume' };
    if (value === 'cancel')
        return { type: 'cancel' };
    if (typeof value === 'string' && value.startsWith('goto:')) {
        const step = value.slice('goto:'.length);
        return { type: 'goto', step };
    }
    return { type: 'next' };
}
export function isInputFlowControl(value) {
    const normalized = value.trim().toLowerCase();
    return (normalized === '/back' ||
        normalized === '/resume' ||
        normalized === '/cancel');
}
export function parseInputFlowControl(value) {
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase();
    if (normalized === '/back')
        return { type: 'back' };
    if (normalized === '/resume')
        return { type: 'resume' };
    if (normalized === '/cancel')
        return { type: 'cancel' };
    return null;
}
