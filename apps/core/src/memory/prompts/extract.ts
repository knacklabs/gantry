export const MEMORY_EXTRACTION_SYSTEM_PROMPT = `You extract durable memory from a completed session arc between Ravi (user) and an AI assistant.

A session arc is the full conversation between a session boundary (start, compact, end). You see what was attempted, what was decided, what worked, what didn't, and what the user corrected.

SAVE only statements that will be useful in a FUTURE session:
- preferences (how Ravi wants to work)
- decisions (choices made, with why — must be explicit and land, not just floated)
- facts (stable project/role/tool/environment facts)
- corrections (what Ravi told the assistant to stop/start doing)
- constraints (rules that must always hold)

DO NOT SAVE:
- task status, progress updates, or "what we did this session"
- hypothetical or exploratory ideas Ravi floated but did not decide
- assistant reasoning or plans that were not confirmed
- transient state (current PID, today's timestamps, in-flight debugging)
- secrets, credentials, tokens, API keys, OAuth tokens, session IDs
- anything already present in retrieved_items unless this arc corrects or replaces it (use supersedes)

JUDGMENT RULES:
- A decision requires Ravi to confirm it in the arc. Assistant suggestions alone don't count.
- A fact requires it to be stable — not specific to today or this run.
- A correction requires Ravi to explicitly tell the assistant to change behavior.
- "I think we should..." is exploration. "Let's do X" or "do X" is a decision.
- When unclear, DO NOT SAVE. Return fewer, higher-quality facts.

TRIGGER POLICY:
- trigger=precompact: prioritize recent, load-bearing decisions/corrections needed immediately after compaction. Prefer 0-3 items.
- trigger=session-end: capture stable session learnings across the full arc. Prefer 0-5 items.
- Never promote temporary progress updates in either trigger.

For each fact return:
{kind, scope, key, value, why, confidence, load_bearing, supersedes}

- kind: preference | decision | fact | correction | constraint
- scope: user (personal preferences) | group (project facts/decisions) | global (truly universal rules)
- key: stable slug, e.g. "decision:memory-extraction-boundary-triggered"
- value: ONE human sentence, third-person, present tense, <220 chars.
- why: a short quote from the arc that grounds the fact (from the user's turns primarily).
- confidence:
    0.9+ -> Ravi stated it explicitly and unambiguously
    0.7-0.9 -> strong inference from clear signal
    <0.7 -> drop
- load_bearing: true if future decisions will depend on this.
- supersedes: ids of retrieved_items this fact replaces or corrects. Empty array if new.

Return [] if nothing in the arc qualifies. Empty output is better than noise. Aim for 0-5 facts per extraction, not a dump.`;

export const MEMORY_EXTRACTION_FEW_SHOTS = [
  {
    input: {
      trigger: 'precompact',
      session_arc: [
        {
          role: 'user',
          text: 'Use --frozen-lockfile for all CI pnpm installs from now on.',
        },
        {
          role: 'assistant',
          text: 'Understood.',
        },
        {
          role: 'user',
          text: 'I also fixed two flaky tests today.',
        },
      ],
    },
    output: [
      {
        kind: 'decision',
        scope: 'group',
        key: 'decision:ci-pnpm-frozen-lockfile',
        value: 'CI installs must use pnpm with --frozen-lockfile.',
        why: 'Use --frozen-lockfile for all CI pnpm installs from now on.',
        confidence: 0.95,
        load_bearing: true,
        supersedes: [],
      },
    ],
  },
  {
    input: {
      trigger: 'session-end',
      session_arc: [
        {
          role: 'user',
          text: 'Keep responses short and skip motivational language.',
        },
        {
          role: 'assistant',
          text: 'Understood. I will keep answers terse and drop the cheerleading.',
        },
        { role: 'user', text: 'Also, my CTO is Kartik Bansal.' },
        { role: 'assistant', text: 'Noted.' },
      ],
    },
    output: [
      {
        kind: 'preference',
        scope: 'user',
        key: 'preference:concise-no-cheerleading',
        value:
          'Ravi prefers concise responses without motivational or cheerleading language.',
        why: 'Keep responses short and skip motivational language.',
        confidence: 0.93,
        load_bearing: true,
        supersedes: [],
      },
      {
        kind: 'fact',
        scope: 'group',
        key: 'fact:cto-kartik-bansal',
        value: 'Kartik Bansal is the CTO at KnackLabs.',
        why: 'my CTO is Kartik Bansal.',
        confidence: 0.95,
        load_bearing: true,
        supersedes: [],
      },
    ],
  },
  {
    input: {
      session_arc: [
        {
          role: 'user',
          text: 'Today we fixed three tests and restarted launchctl.',
        },
        { role: 'assistant', text: 'Nice.' },
      ],
    },
    output: [],
  },
  {
    input: {
      session_arc: [
        {
          role: 'user',
          text: 'Maybe we should consider switching databases later.',
        },
        { role: 'assistant', text: 'Worth exploring.' },
      ],
    },
    output: [],
  },
  {
    input: {
      session_arc: [
        {
          role: 'user',
          text: 'The old rule is wrong. Lock recovery should only reclaim when PID is dead, not on timeout.',
        },
        { role: 'assistant', text: 'Got it, updating the rule.' },
      ],
      retrieved_items: [
        {
          id: 'mem-abc',
          key: 'rule:lock-recovery-timeout',
          value: 'Lock recovery reclaims locks after 30s timeout.',
        },
      ],
    },
    output: [
      {
        kind: 'correction',
        scope: 'group',
        key: 'correction:lock-recovery-pid-liveness',
        value:
          'IPC lock recovery only reclaims locks whose owner PID is confirmed dead, not on timeout.',
        why: 'Lock recovery should only reclaim when PID is dead, not on timeout.',
        confidence: 0.92,
        load_bearing: true,
        supersedes: ['mem-abc'],
      },
    ],
  },
] as const;
