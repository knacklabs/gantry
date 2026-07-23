// Evidence bundle assembly for agent E2E runs (AgentE2EEvidence in
// ../types.ts). Uploaded as a CI artifact on success AND failure; everything
// written is scrubbed against the run's generated secrets and any provided
// credential before it reaches disk.

import fs from 'node:fs';
import path from 'node:path';

import type { AgentE2EEvidence } from '../types.js';
import type { SessionEvent } from './api-client.js';

export interface EvidenceRun {
  evidence: AgentE2EEvidence;
  /** Raw session/runtime event extracts written beside the evidence JSON. */
  events: SessionEvent[];
  /** Mark the start of a named phase; ended by the next mark or finish(). */
  phase(name: string): void;
  /** Close the current phase (if any). */
  finishPhases(): void;
  /**
   * Write `<scenario>.evidence.json` (+ `<scenario>.events.json` when events
   * were recorded) under dir, redacted. Returns the evidence file path.
   */
  write(dir: string): string;
}

export function startEvidenceRun(input: {
  scenario: string;
  secrets: string[];
  imageDigest?: string;
  modelAlias?: string;
  modelRoute?: string;
  provider?: string;
  harness?: string;
}): EvidenceRun {
  const evidence: AgentE2EEvidence = {
    scenario: input.scenario,
    imageDigest: input.imageDigest ?? 'local-process',
    modelAlias: input.modelAlias ?? 'none',
    modelRoute: input.modelRoute ?? 'none',
    provider: input.provider ?? 'none',
    harness: input.harness ?? 'none',
    selectedSkills: [],
    mcpCalls: [],
    capabilityDecisions: [],
    auditIds: [],
    timings: {},
  };
  const events: SessionEvent[] = [];
  let openPhase: { name: string; startedAt: number } | undefined;

  const closePhase = () => {
    if (!openPhase) return;
    evidence.timings[openPhase.name] = Date.now() - openPhase.startedAt;
    openPhase = undefined;
  };

  return {
    evidence,
    events,
    phase(name: string) {
      closePhase();
      openPhase = { name, startedAt: Date.now() };
    },
    finishPhases: closePhase,
    write(dir: string): string {
      closePhase();
      fs.mkdirSync(dir, { recursive: true });
      const evidencePath = path.join(dir, `${input.scenario}.evidence.json`);
      fs.writeFileSync(
        evidencePath,
        redactText(JSON.stringify(evidence, null, 2), input.secrets),
      );
      if (events.length > 0) {
        fs.writeFileSync(
          path.join(dir, `${input.scenario}.events.json`),
          redactText(JSON.stringify(events, null, 2), input.secrets),
        );
      }
      return evidencePath;
    },
  };
}

/** Replace every occurrence of each secret with [REDACTED]. */
export function redactText(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join('[REDACTED]');
    // Secrets can appear JSON-escaped inside stringified payloads.
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) {
      redacted = redacted.split(escaped).join('[REDACTED]');
    }
  }
  return redacted;
}
