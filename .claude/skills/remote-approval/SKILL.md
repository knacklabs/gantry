---
name: remote-approval
description: Start a named Remote Control Claude Code session in a chosen checkout for an action the human must take from the Claude mobile app. Stories in every Forge repo can be approved from the one main chat; use this when another action needs its own session.
---

# Remote Control session

Use this when an action must happen in a session in a specific checkout, and the human isn't at
the laptop. Stories in every Forge repo can be approved from the one main chat without opening
another session.

## Start it

Run it in the background, so your own session keeps working:

```bash
cd <checkout> && exec claude remote-control --name "<name>"
```

- It prints `Connected · <repo> · <branch>` and a `https://claude.ai/code/session_…` link.
- The human opens that link, or finds the session by its name in the Claude app.
- Stop the background run once the action is recorded.

## Name it plainly

The human reads the name on a phone, so it must say what the chat is for:

- `<plain-English thing> <action>`, e.g. `Client migration check`;
- no IDs, hashes or branch names;
- under about 30 characters.

## Tell the human

Send one message with:

- the name and the link;
- the exact sentence to say there, e.g. "Check the client migration result";
- what happens after they act.

Then check the result yourself.
