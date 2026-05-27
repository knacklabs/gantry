// Module-scoped singleton registry that lets the Interakt webhook HTTP route
// reach the live InteraktChannel instance.
//
// Why a singleton and not the existing `connectedChannels` array in
// channel-wiring.ts: that array is closure-private; the webhook route has
// only `ControlRouteContext` in scope. Plumbing a new wiring API for one
// channel is more disruptive than a one-file registry for Phase 1.
//
// Phase 2 TODO: replace with `Map<appId, InteraktChannel>` for multi-tenant.

import type { InteraktChannel } from './channel.js';

let liveChannel: InteraktChannel | null = null;

export function setLiveInteraktChannel(ch: InteraktChannel): void {
  liveChannel = ch;
}

export function clearLiveInteraktChannel(ch: InteraktChannel): void {
  if (liveChannel === ch) liveChannel = null;
}

export function getLiveInteraktChannel(): InteraktChannel | null {
  return liveChannel;
}
