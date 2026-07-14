# Gantry Debug Checklist

## Runtime Truth

Gantry runs as a local host process.

## Quick Status Check

```bash
# 1. Is the service running?
gantry status

# 2. Recent runtime errors
grep -E 'ERROR|WARN' logs/gantry.log | tail -20

# 3. Are channels connected?
grep -E 'Connected|Connection closed|channel.*ready' logs/gantry.log | tail -5

# 4. Are groups loaded?
grep 'groupCount' logs/gantry.log | tail -3

# 5. Runtime diagnostics output
gantry status
```

## Session Transcript Inspection

```bash
# Provider transcript exports are debugging artifacts only.
# Runtime continuation comes from canonical Postgres sessions, messages,
# summaries, runs, and memory.

# Check parentUuid branching in a temporary SDK JSONL export
python3 -c "
import json
lines = open('/tmp/gantry-sdk-jsonl-export/<session>.jsonl').read().strip().split('\n')
for i, line in enumerate(lines):
  try:
    d = json.loads(line)
    if d.get('type') == 'user' and d.get('message'):
      parent = d.get('parentUuid', 'ROOT')[:8]
      content = str(d['message'].get('content', ''))[:60]
      print(f'L{i+1} parent={parent} {content}')
  except Exception:
    pass
"
```

## Timeout / Queue Investigation

```bash
# Check for recent timeout logs
grep -E 'timeout|timed out|idle timeout' logs/gantry.log | tail -20

# Check if retries were scheduled
grep -E 'Scheduling retry|retry|Max retries' logs/gantry.log | tail -10

# Check processing pipeline
grep -E 'Processing messages|Spawning host agent|Piped messages' logs/gantry.log | tail -20

# Confirm runtime health before DB-level checks
gantry status
```

## Group Config Inspection

```bash
# Review runtime settings
cat ~/gantry/settings.yaml

# Inspect conversation installs
psql "$GANTRY_DATABASE_URL" -c "SELECT display_name, conversation_id, provider_account_id, status FROM gantry.conversation_installs;"
```

## Channel Auth Issues

```bash
# Check auth-related logs
grep 'authentication required\|token\|connect' logs/gantry.log | tail -20

# Check auth files
ls -la store/auth/
```

If auth state is missing or expired, rerun guided setup with `gantry setup`.

## Service Management

```bash
# Restart
gantry service restart

# View live logs
tail -f logs/gantry.log

# Stop service
gantry service stop

# Install or reinstall service
gantry service install

# Start an already-installed service without rewriting it
gantry service start

# Rebuild after code changes
npm run build && gantry service restart
```
