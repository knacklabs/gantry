import { type ControlPlaneReadModel } from '../../application/control-plane/control-plane-read-model.js';
import type { AppId } from '../../domain/app/app.js';
import type { ControlRouteContext } from './handler-context.js';
/**
 * Build the unified control-plane read model for an authorized control request.
 * Shared by the status route and the guided-action routes so the read model
 * (and therefore the derived next action) is identical across them.
 */
export declare function buildControlPlaneReadModelForRequest(ctx: ControlRouteContext, appId: AppId): Promise<ControlPlaneReadModel>;
