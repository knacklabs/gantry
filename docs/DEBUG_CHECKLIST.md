# MyClaw Debug Checklist

## Runtime Truth

MyClaw currently supports host runtime execution only.
If you see container-oriented names in logs or schema (for example `container_config`, `containerName`), treat them as legacy naming debt.

## Quick Status Check

```bash
# 1. Is the service running?
launchctl list | grep myclaw

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

# Compare router cursor vs latest messages
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

## Group Config Inspection

```bash
# Review registered group agent config (legacy column name retained)
sqlite3 store/messages.db "SELECT name, container_config FROM registered_groups;"

# Review runtime settings
cat ~/myclaw/settings.yaml
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
launchctl kickstart -k gui/$(id -u)/com.myclaw

# View live logs
tail -f logs/myclaw.log

# Stop service
launchctl bootout gui/$(id -u)/com.myclaw

# Start service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.myclaw.plist

# Rebuild after code changes
npm run build && launchctl kickstart -k gui/$(id -u)/com.myclaw
```
