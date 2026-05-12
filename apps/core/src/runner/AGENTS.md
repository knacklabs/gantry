## Runner MCP Capability Notes

- Admin MyClaw MCP tools should stay registered in the runner MCP surface and enforce selection at call time. Persistent `request_permission` approvals append live tool rules for the current run, so `capability_status` and admin tool handlers must read live rules instead of relying only on startup environment snapshots.
- Memory IPC auth scope includes reviewer authority. When adding or changing runner boundaries, forward `memoryReviewerIsControlApprover` into the MyClaw MCP server environment so memory request signatures match runtime verification.
