# Capability Specs

Save one implementation-neutral capability contract per file at
`docs/specs/<slug>.md` with `forge spec save <slug>`. Drafts may evolve freely
during prototyping. Before confirming, the spec gets one cold read:

```bash
forge read <slug>
forge spec confirm <slug> --by <name>
```

Once a spec is confirmed, add its items to `plans/roadmap.json` with
`forge roadmap add <slug>`. Every story must link the confirmed spec it came
from.
