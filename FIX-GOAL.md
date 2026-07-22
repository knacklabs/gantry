# Fix goal: Observer S3a — resolve the 7 autoreview findings (5 P1 blocking)

Your Stage 3a implementation is staged on `feature/observer-s3-batch` (tests pass 73/73 gateway +
30 batch) BUT a mandatory xhigh autoreview found 7 findings — 5 P1 blocking. Full report:
`./AUTOREVIEW_FINDINGS.txt` (read it). Fix ALL of them; these are correctness/security fixes to make
the impl match the approved design (scoped credentials, security-preserving gateway, honest
durability). Keep the prefer-orphan durability decision + the gateway "extend not bypass" model.

## P1 (blocking) — must fix
1. **Batch-scoped authorization** (`gantry-model-gateway-routing.ts` + credential/token model):
   batch submit/list/download must NOT be reachable by an ordinary model-runtime gateway token.
   Require a distinct batch-purpose scope/token; ordinary tokens get 403 on batch/file paths.
   Also ensure a many-item batch is not under-counted by the request-rate limiter.
2. **Preflight before `submission_unknown`** (`memory/chat-batch-state-machine.ts:111`): perform ALL
   deterministic pre-send validation (credential resolution, abort-signal check, custom-id
   validation, envelope/upload-size check) BEFORE transitioning the intent to `submission_unknown`.
   Record known pre-send failures as a distinct terminal/failed state (NOT unknown) so they don't
   consume the daily reservation and are retryable — do not leave them permanently ambiguous.
3. **Preserve `maxOutputTokens`** (`chat-batch-state-machine.ts:119`): add the output-token cap to
   `ChatBatchSubmitInput`, include it in the content-hash/snapshot, and pass it to `submitBatch` so
   OpenAI sets `max_completion_tokens` and Anthropic does not silently use 4096.
4. **Bound result downloads** (`adapters/llm/chat-batch-http.ts:49`): stream + parse JSONL
   incrementally with explicit byte + row limits before building the durable snapshot; do not buffer
   an unbounded result file into memory (OOM risk). The 14 MiB upload limit does NOT bound output.
5. **Exclude Claude OAuth from direct batch** (`shared/model-provider-registry.ts:156`): batch
   eligibility must depend on the ACTIVE credential mode and REJECT `claude_code_oauth` before
   creating the intent — never inject an OAuth subscription token into the raw Message Batches API
   (respect the Anthropic-SDK-only OAuth boundary).

## P2 — fix too
6. **Real cost accounting** (`openai-chat-batch.ts:417` + Anthropic): providers return token usage,
   NOT a per-result USD field. Estimate cost from catalog pricing + the batch (and cache) discount
   from real usage tokens so persisted `provider_reported_cost_usd` is populated. Update the tests
   to stop fabricating a `cost_usd` field.
7. **Restore result ordering** (`chat-batch-state-machine.ts:204`): rebuild the result array by
   `customId` into `requestSnapshot` order before persisting (OpenAI concatenates output-then-error
   rows, losing input order) so ordered replay can't apply pages out of sequence.

## Verify (real) — before commit
- tsc clean; FULL gateway suite green (`npx vitest run gantry-model-gateway`); batch unit + pg
  integration green; ADD tests for each fix (ordinary-token 403 on batch paths; pre-send failure is
  retryable not unknown; maxOutputTokens flows through; download byte/row limit enforced; OAuth
  rejected before intent; cost populated from usage; result reorder). Paste REAL counts.
- Then `python3 ~/.codex/skills/autoreview/scripts/autoreview --mode local --thinking xhigh` and
  iterate until it reports CLEAN (no accepted/actionable findings) BEFORE committing.
- COMMIT on `feature/observer-s3-batch` (NO Claude-Session trailer). If sandbox blocks commit OR
  autoreview cannot run in the sandbox, leave staged + say so — the orchestrator runs autoreview + commits.
