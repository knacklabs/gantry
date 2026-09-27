---
name: remote-approval
description: Start a named Remote Control Claude Code session in a chosen checkout so the human can approve or act from the Claude mobile app, e.g. a story approval that only that checkout's hooks record. Use when the human is away from the laptop and an action must happen in a session other than the current one.
---

# Remote approval session

Use this when something must happen in a session whose hooks come from a specific checkout, and the
human isn't at the laptop. Example: approving a story, which only the story checkout's Plan Mode
hook records. Never record an approval any other way.

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

- `<plain-English thing> <action>`, e.g. `Payments story approval` or `Client migration check`;
- no IDs, hashes or branch names;
- under about 30 characters.

## Tell the human

Send one message with:

- the name and the link;
- the exact sentence to say there, e.g. "Show plans/<KEY>.md in Plan Mode and exit Plan Mode with it
  as the plan";
- what happens after they act.

Then check the result yourself: for an approval, `forge next` should no longer say the story is
waiting.
