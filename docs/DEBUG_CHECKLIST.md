# MyClaw Debug Checklist

## Runtime Truth

MyClaw runs as a local host process.

## Quick Status Check

```bash
# 1. Is the service running?
myclaw status

# 2. Recent runtime errors
grep -E 'ERROR|WARN' logs/myclaw.log | tail -20

# 3. Are channels connected?
grep -E 'Connected|Connection closed|channel.*ready' logs/myclaw.log | tail -5

# 4. Are groups loaded?
grep 'groupCount' logs/myclaw.log | tail -3

# 5. Runtime diagnostics output
myclaw status
```

## Session Transcript Branching

```bash
# Check per-group debug logs
ls -la data/sessions/<group>/.claude/debug/

# Check parentUuid branching in transcript
python3 -c "
import json
lines = open('data/sessions/<group>/.claude/projects/-workspace-group/<session>.jsonl').read().strip().split('\n')
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
grep -E 'timeout|timed out|idle timeout' logs/myclaw.log | tail -20

# Check if retries were scheduled
grep -E 'Scheduling retry|retry|Max retries' logs/myclaw.log | tail -10

# Check processing pipeline
grep -E 'Processing messages|Spawning host agent|Piped messages' logs/myclaw.log | tail -20

# Confirm runtime health before DB-level checks
myclaw status
```

## Group Config Inspection

```bash
# Review runtime settings
cat ~/myclaw/settings.yaml

# Inspect canonical channel bindings
psql "$MYCLAW_DATABASE_URL" -c "SELECT display_name, conversation_id, trigger_pattern FROM myclaw.agent_channel_bindings;"
```

## Channel Auth Issues

```bash
# Check auth-related logs
grep 'authentication required\|token\|connect' logs/myclaw.log | tail -20

# Check auth files
ls -la store/auth/
```

If auth state is missing or expired, rerun guided setup with `myclaw setup`.

## Service Management

```bash
# Restart
myclaw service restart

# View live logs
tail -f logs/myclaw.log

# Stop service
myclaw service stop

# Install or reinstall service
myclaw service install

# Start an already-installed service without rewriting it
myclaw service start

# Rebuild after code changes
npm run build && myclaw service restart
```
