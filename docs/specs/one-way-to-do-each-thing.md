---
slug: one-way-to-do-each-thing
title: One way to do each thing, and nothing said twice
status: confirmed
saved: 2026-10-02T09:30:35+00:00
confirmed_by: "Ravi"
confirmed_hash: a9c418ca9b40fe1a331defde6829ab08b5023b428993289ff0f25119640ae635
---

# One way to do each thing, and nothing said twice

## Why

The owner's rule is a clean UX. Each thing a person does has one way to do it, and each thing that happens is said once. A read-only audit of every provider on 2026-10-02 found eight places that break this rule. None of them is covered by the permission flow (PERMFLOW) or messaging pipeline (MSG) plans.

- **Forms lose answers.** The agent can show a form. On Slack and Discord the submitted values are thrown away: the person sees "Submitted by …", and the agent never gets the answers. Questions already have a working answer path.
- **One piece of work shows two cards.** A plan (the todo card) and a progress line are separate messages for the same work, each updated on its own.
- **Agents are told to say "I'm on it" first.** The default instructions tell the agent to send a first message before working. Gantry already shows progress in the chat on its own, so this is a second message saying the same thing.
- **Telegram's "Other" button piles up messages.** Each tap adds a "Reply to this message with your answer" message and a popup saying the same. The extra messages stay after the question is answered.
- **Question options are shown twice:** once in the text, and again as button labels (Telegram, Slack, Discord).
- **Session commands have three spellings,** `/stop`, `/gantry stop` and `!stop`, and the same for new, compact, model and settings.
- **Discord answers a command twice.** It says "Gantry received /new" and then gives the real result.
- **Text fallback explains our plumbing.** When a rich view can't be shown, the text starts with "Rich view unavailable in this conversation. Showing text version".

## Behaviour

- **Two ways to ask for input, and no forms.**
  - **Choices:** the agent asks a question with options, and the answers reach the agent.
  - **Free text** (a name, an address): the agent asks in its message, and the person's next message is the answer, as in any conversation.
  - The form tool is removed, along with its submit handling on every provider. Other rich views (lists, tables, facts, media) stay.
- **One card per turn.** The plan and progress card is a single message per turn. It shows the plan, once there is one, and the current step, and it is updated in place. There is no separate progress line.
  - **Lifecycle.** The card follows today's ambient progress card. It is keyed by the turn, updates from an older turn are ignored, it ends showing its final state, and an edit that may have failed is retried as an edit, never as a new message.
- **No "I'm on it" message.** The agent's default instructions no longer ask for a first message before working. Ambient progress shows that it is working. The agent still sends real updates when they carry news, and its answer.
- **"Other" is answered by replying to the question.** Tapping "Other" on Telegram doesn't post anything new; at most it shows Telegram's brief built-in toast. Replying to the original question with text answers it. No helper messages are left behind.
- **Options are listed once.** The question text lists the numbered options with their descriptions, and the option buttons show only the numbers. The "Other" and "Done" buttons keep their words, and a selected option keeps its mark. On a provider without buttons, the person replies with the number, as today.
- **One spelling for each session command:** the commands help lists today (`/stop`, `/new`, `/compact`, `/status`, `/model` and the rest). No commands are added.
  - **On Telegram, Discord and the web:** `/stop` and the others, typed as a message.
    - Discord's registered `/gantry` command is removed. Typing `/stop` in Discord sends it as a message, which works in threads too.
  - **On Slack, at channel level:** `/gantry stop` and the other `/gantry` forms. Slack refuses unknown slash commands, so its registered command is the one that works there.
  - **On Slack, inside a thread:** mention the bot with the command word, for example "@Gantry stop" or "@Gantry new". A Slack slash command doesn't say which thread it was typed in, but a mention does.
  - **`!stop` and the other `!` forms are removed.** Help lists only the spellings for the provider it is shown on.
  - Owner choices, 2026-10-02: "/stop, plus Slack's /gantry stop", and "@Gantry stop" in Slack threads.
- **A command is answered once.** Removing Discord's registered command also removes its "Gantry received …" receipt. Every command produces only its result.
- **Fallback text is just the content.** When a rich view can't be shown, the text version is sent without any preface about rendering.

**Decisions this changes:** the progress-card behaviour of 0110 (ambient liveness) is kept, and the separate progress surface is removed.

## Risks

- **A removed tool and removed command spellings.** Agents that call the form tool get a clear "not available, ask questions instead" error. People who type `!stop` get help, once per conversation, showing that provider's spelling: `/stop` on Telegram, Discord and the web, and on Slack `/gantry stop` at channel level or "@Gantry stop" in a thread. No data is deleted.

## Acceptance criteria

- **AC1. No form tool.** The form tool is gone. On Telegram, Slack and Discord, a choice answered by button and a free-text answer given as the next message both reach the agent.
- **AC2. One plan and progress card.** A turn that updates its plan and its progress shows one card, updated in place. A later turn gets its own card, and a late update from an earlier turn changes nothing.
- **AC3. No "I'm on it" instruction.** The default agent instructions contain no first-message instruction.
- **AC4. Telegram "Other".** Tapping "Other" sends no message. A text reply to the question answers it, and nothing extra stays in the chat.
- **AC5. Options once.** On Telegram, Slack and Discord, each option label appears once in a question, in the text. Option buttons show numbers, and "Other", "Done" and selected marks still work.
- **AC6. Command spellings.**
  - `/stop` stops a turn on Telegram, Discord (in a thread too) and the web.
  - On Slack, `/gantry stop` stops one at channel level, and "@Gantry stop" stops the run in that thread.
  - `!stop` is not a command; it gets help, once.
  - Help shows only the spellings for its provider.
- **AC7. Discord commands.** Discord has no registered Gantry command, and a typed command produces only its result message.
- **AC8. Fallback text.** A rich view that falls back to text carries no rendering preface.

## Success measure

- Metric: extra messages per request in the end-to-end scenario suite. The fake channel records every new message (not edits). Count every message except the answer, the turn's one card and any questions. The measured scenarios are requests whose fake agent sends no news updates, so any other message is extra.
- Baseline: the count on main for the suite's scenarios, recorded when UX-1 starts.
- Target: zero extra messages in every scenario once UX-1 merges.
- Check date: 2027-03-01

## Roadmap

- UX-1: One way to do each thing, and nothing said twice
