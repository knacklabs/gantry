import { SessionInteractionModule } from '../../application/sessions/session-interaction-module.js';
import type { ControlRouteContext } from './handler-context.js';
export type SessionEventSubscription = Awaited<ReturnType<SessionInteractionModule['subscribeEvents']>>;
export declare function createSessionInteractionModule(input?: {
    liveAdmissionAppId?: string | null;
    getConfiguredAgentRuntime?: ControlRouteContext['getConfiguredAgentRuntime'];
}): SessionInteractionModule;
export declare function ensureSessionForControl(ctx: ControlRouteContext, input: Parameters<SessionInteractionModule['ensureSession']>[0]): Promise<Awaited<ReturnType<SessionInteractionModule['ensureSession']>>>;
export declare function acceptMessageForControl(ctx: ControlRouteContext, input: Parameters<SessionInteractionModule['acceptMessage']>[0]): Promise<Awaited<ReturnType<SessionInteractionModule['acceptMessage']>>>;
