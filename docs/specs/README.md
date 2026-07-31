# Capability Specs

Save one implementation-neutral capability contract per file with
`./forge spec save <slug> --from <draft.md>`. Drafts may evolve freely during
prototyping. Confirmation requires a fresh spec grill:

```bash
python3 factory/scripts/record_grill_from_json.py --gate spec \
  --input <grill.json> --input-digest docs/specs/<slug>.md
./forge spec confirm <slug>
```

After every spec is confirmed, derive `plans/roadmap.json` with
`./forge roadmap derive --input <roadmap.json>`. Every story must link the
confirmed spec it came from.
