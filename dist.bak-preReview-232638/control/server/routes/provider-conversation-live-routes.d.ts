import type { ConversationInstall, ProviderAccountId } from '../../../domain/provider/provider.js';
import type { ControlRouteContext } from '../handler-context.js';
export declare function projectConversationInstallToRuntime(ctx: ControlRouteContext, install: ConversationInstall): Promise<void>;
export declare function removeProviderAccountRoutesFromRuntime(ctx: ControlRouteContext, providerAccountId: ProviderAccountId): Promise<void>;
export declare function projectProviderAccountRoutesToRuntime(ctx: ControlRouteContext, providerAccountId: ProviderAccountId): Promise<void>;
export declare function removeConversationInstallFromRuntime(ctx: ControlRouteContext, install: ConversationInstall): Promise<void>;
