# Review brief — lite window Q-0085 (heredoc commands + honest job prompt copy)

Facts (live, run fba3fbe7 2026-08-26 05:05Z): a scheduled run issued `grep … /dev/stdin << 'EOF' … EOF`. The bash parser has no heredoc support (`<<` → "redirection target missing"), so the tool-rule matcher could not evaluate the command, no persistent rule could be derived, and `attachRequest` in the job-permission durability wiring returned false — the run got the classic interactive prompt (allow_once/cancel, 24h row) instead of the JOBPERM living card, and the prompt copy said "Reply in 1m" although job prompts never expire (prompt-binding resolveInteractionSettlementDelayMs → undefined for jobId).

Contract for this diff:
- Parser: `<<`/`<<-` heredocs parse; the body is literal data attached to the redirect, never argv; bare delimiters with `$`/backtick in the body are rejected (expansion), quoted delimiters accept anything; unterminated heredocs are rejected; all pre-existing parse results/errors unchanged.
- Prompt copy: requests with `jobId` render "This job waits for your decision." and never a minutes deadline; non-job requests unchanged.
- No change to the rule matcher, the durability wiring, or the classic prompt's keyboard (it already carries Allow once / Cancel).

Focus: heredoc body must not leak into leaf argv or rule matching (a body line that looks like a command must not become a leaf); `<<` inside quotes must stay literal; newline handling after the terminating delimiter; CRLF bodies; the Telegram HTML renderer must not still print "Reply in" for job prompts. Ignore style.
