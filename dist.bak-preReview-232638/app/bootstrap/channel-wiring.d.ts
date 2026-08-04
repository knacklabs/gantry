import { RuntimeApp } from './runtime-app.js';
import type { ChannelWiring, ChannelWiringDeps } from './channel-wiring-types.js';
export declare function createChannelWiring(app: RuntimeApp, deps?: Partial<ChannelWiringDeps>): ChannelWiring;
