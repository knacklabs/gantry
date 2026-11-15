# Combined runtime and recipe release

Combines Gantry PR634 hardened runtime/caller evidence/billing with PR607 capability metadata and PR633 CAPTCHA freshness. Both original histories remain in the new release branch. No deployment or existing PR mutation is included.

Runtime source commit: `395e85f7d2b1896fc2a18f011f3a969b1b7a8958`.

Verification:289 focused tests across10files passed; runtime and SDK builds passed. After moving the capability metadata hashing helper to the shared layer, runtime typecheck and proxy/invocation/IPC tests passed again. Calls with and without invocation metadata retain matching audit receipts. No external tender site or paid provider was contacted.

The architecture checker remains failed. Existing oversized modules and existing layer/provider findings are disclosed, not waived in the checker configuration. The integration's newly disallowed crypto import was corrected by locating its helper in the shared layer. Runtime behavior was preserved.

The dedicated autoreview helper is not installed. Its independent quality/performance/security review was not performed. On2026-11-16 the user explicitly authorized treating these two categories as non-blocking release limitations. No passing autoreview evidence is fabricated. This release-specific authorization does not change the repository's general policy or claim that pr_ready.py passed.

A fresh linux/amd64 image is built from a clean archive of the runtime source commit. Its tag is `knacklabs/gantry-runtime:1.2.53-395e85f7-amd64`. Image identity is recorded separately after the build completes. No live provider, target-host sandbox or production acceptance is claimed.
