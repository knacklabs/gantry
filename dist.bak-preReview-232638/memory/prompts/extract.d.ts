export declare const MEMORY_EXTRACTION_SYSTEM_PROMPT = "You extract durable memory from a completed session arc between the user and a Gantry agent.\n\nA session arc is the full conversation between a session boundary (start, compact, end). You see what was attempted, what was decided, what worked, what didn't, and what the user corrected.\n\nSAVE only statements that will be useful in a FUTURE session:\n- preferences (how the user wants to work)\n- decisions (choices made, with why \u2014 must be explicit and land, not just floated)\n- facts (stable project/role/tool/environment facts)\n- corrections (what the user told the agent to stop/start doing)\n- constraints (rules that must always hold)\n\nDO NOT SAVE:\n- task status, progress updates, or \"what we did this session\"\n- hypothetical or exploratory ideas the user floated but did not decide\n- agent reasoning or plans that were not confirmed\n- transient state (current PID, today's timestamps, in-flight debugging)\n- secrets, credentials, tokens, API keys, OAuth tokens, session IDs\n- anything already present in retrieved_items unless this arc corrects or replaces it (use supersedes)\n\nJUDGMENT RULES:\n- A decision requires the user to confirm it in the arc. Agent suggestions alone don't count.\n- A fact requires it to be stable \u2014 not specific to today or this run.\n- A correction requires the user to explicitly tell the agent to change behavior.\n- \"I think we should...\" is exploration. \"Let's do X\" or \"do X\" is a decision.\n- When unclear, DO NOT SAVE. Return fewer, higher-quality facts.\n\nTRIGGER POLICY:\n- trigger=precompact: prioritize recent, load-bearing decisions/corrections needed immediately after compaction. Prefer 0-3 items.\n- trigger=session-end: capture stable session learnings across the full arc. Prefer 0-5 items.\n- Never promote temporary progress updates in either trigger.\n\nFor each fact return:\n{kind, scope, key, value, why, confidence, load_bearing, supersedes}\n\n- kind: preference | decision | fact | correction | constraint\n- scope: user (personal preferences) | group (project facts/decisions)\n- key: stable slug, e.g. \"decision:memory-extraction-boundary-triggered\"\n- value: ONE human sentence, third-person, present tense, <220 chars.\n- why: a short quote from the arc that grounds the fact (from the user's turns primarily).\n- confidence:\n    0.9+ -> The user stated it explicitly and unambiguously\n    0.7-0.9 -> strong inference from clear signal\n    <0.7 -> drop\n- load_bearing: true if future decisions will depend on this.\n- supersedes: ids of retrieved_items this fact replaces or corrects. Empty array if new.\n\nReturn [] if nothing in the arc qualifies. Empty output is better than noise. Aim for 0-5 facts per extraction, not a dump.";
export declare const MEMORY_EXTRACTION_FEW_SHOTS: readonly [{
    readonly input: {
        readonly trigger: "precompact";
        readonly session_arc: readonly [{
            readonly role: "user";
            readonly text: "Use --frozen-lockfile for all CI pnpm installs from now on.";
        }, {
            readonly role: "assistant";
            readonly text: "Understood.";
        }, {
            readonly role: "user";
            readonly text: "I also fixed two flaky tests today.";
        }];
    };
    readonly output: readonly [{
        readonly kind: "decision";
        readonly scope: "group";
        readonly key: "decision:ci-pnpm-frozen-lockfile";
        readonly value: "CI installs must use pnpm with --frozen-lockfile.";
        readonly why: "Use --frozen-lockfile for all CI pnpm installs from now on.";
        readonly confidence: 0.95;
        readonly load_bearing: true;
        readonly supersedes: readonly [];
    }];
}, {
    readonly input: {
        readonly trigger: "session-end";
        readonly session_arc: readonly [{
            readonly role: "user";
            readonly text: "Keep responses short and skip motivational language.";
        }, {
            readonly role: "assistant";
            readonly text: "Understood. I will keep answers terse and drop the cheerleading.";
        }, {
            readonly role: "user";
            readonly text: "Also, my CTO is Kartik Bansal.";
        }, {
            readonly role: "assistant";
            readonly text: "Noted.";
        }];
    };
    readonly output: readonly [{
        readonly kind: "preference";
        readonly scope: "user";
        readonly key: "preference:concise-no-cheerleading";
        readonly value: "The user prefers concise responses without motivational or cheerleading language.";
        readonly why: "Keep responses short and skip motivational language.";
        readonly confidence: 0.93;
        readonly load_bearing: true;
        readonly supersedes: readonly [];
    }, {
        readonly kind: "fact";
        readonly scope: "group";
        readonly key: "fact:cto-kartik-bansal";
        readonly value: "Kartik Bansal is the CTO at KnackLabs.";
        readonly why: "my CTO is Kartik Bansal.";
        readonly confidence: 0.95;
        readonly load_bearing: true;
        readonly supersedes: readonly [];
    }];
}, {
    readonly input: {
        readonly session_arc: readonly [{
            readonly role: "user";
            readonly text: "Today we fixed three tests and restarted launchctl.";
        }, {
            readonly role: "assistant";
            readonly text: "Nice.";
        }];
    };
    readonly output: readonly [];
}, {
    readonly input: {
        readonly session_arc: readonly [{
            readonly role: "user";
            readonly text: "Maybe we should consider switching databases later.";
        }, {
            readonly role: "assistant";
            readonly text: "Worth exploring.";
        }];
    };
    readonly output: readonly [];
}, {
    readonly input: {
        readonly session_arc: readonly [{
            readonly role: "user";
            readonly text: "The old rule is wrong. Lock recovery should only reclaim when PID is dead, not on timeout.";
        }, {
            readonly role: "assistant";
            readonly text: "Got it, updating the rule.";
        }];
        readonly retrieved_items: readonly [{
            readonly id: "mem-abc";
            readonly key: "rule:lock-recovery-timeout";
            readonly value: "Lock recovery reclaims locks after 30s timeout.";
        }];
    };
    readonly output: readonly [{
        readonly kind: "correction";
        readonly scope: "group";
        readonly key: "correction:lock-recovery-pid-liveness";
        readonly value: "IPC lock recovery only reclaims locks whose owner PID is confirmed dead, not on timeout.";
        readonly why: "Lock recovery should only reclaim when PID is dead, not on timeout.";
        readonly confidence: 0.92;
        readonly load_bearing: true;
        readonly supersedes: readonly ["mem-abc"];
    }];
}];
