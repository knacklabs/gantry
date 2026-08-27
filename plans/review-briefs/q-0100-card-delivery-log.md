# Review brief — lite window Q-0100 (log the provider result of every job-permission card delivery)

Facts: a card edit at 2026-08-26 14:47Z was recorded `sent` in outbound_delivery_items but left no log line; whether the buttons reached the chat could not be proven from logs.

Contract for this diff (provider-neutral): the durability service logs one INFO line when a card revision delivery is confirmed (jobId, cardId, revision, operation, provider, providerMessageId, deliveryId) and one WARN when it is failed (same keys + reason). Logger injected through the existing deps with a no-op default; runtime logger wired in job-permission-durability-wiring.ts. No provider change, no new events.

Focus: the log fires exactly once per confirmed/failed revision (not on repeats/no-ops), never throws, and fields are correct on the replace path. Ignore style.

Rounds: R1 "guard logger calls against throwing" — REJECTED BY DESIGN: the injected runtime logger is pino (non-throwing by contract) and the default is a no-op; a try/catch around a log line adds ceremony for an impossible case.
