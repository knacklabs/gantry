# Review brief — lite window Q-0095 (rollup label for surplus wrapper browser failures)

Facts: the rollup labels wrapper-side browser failures that have no matching host-side (authoritative) failure as "failed before reaching the browser service". Live run 7f3ec256 (2026-08-26): the single surplus was a click that ran 120,148 ms — the runner's 120 s IPC timeout fired and it reported failure while the host was still executing. The call reached the browser; the runner stopped waiting.

Contract for this diff: the browser label becomes "Browser: no reply in time"; capability sibling label unchanged; no logic change; tests updated. Ignore style.
