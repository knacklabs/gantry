---
slug: one-way-to-do-each-thing
title: One way to do each thing, and nothing said twice
status: draft
saved: 2026-10-02T09:30:35+00:00
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

- **Questions are the one way to ask for input.** The form tool is removed, along with its submit handling on every provider. When the agent needs answers, it asks questions, and the answers reach the agent. Other rich views (lists, tables, facts, media) stay.
- **One card per piece of work.** The plan and progress card is a single message per turn. It shows the plan and the current step, and it is updated in place. There is no separate progress line.
- **No "I'm on it" message.** The agent's default instructions no longer ask for a first message before working. Ambient progress shows that it is working. The agent still sends real updates when they carry news, and its answer.
- **"Other" is answered by replying to the question.** Tapping "Other" on Telegram doesn't post anything new; at most it shows Telegram's brief built-in toast. Replying to the original question with text answers it. No helper messages are left behind.
- **Options are listed once.** The question text lists the numbered options with their descriptions. The buttons show only the numbers. On a provider without buttons, the person replies with the number, as today.
- **One spelling for each session command.**
  - **On Telegram, Discord and the web:** `/stop`, `/new`, `/compact`, `/model` and `/settings`, typed as a message.
  - **On Slack:** `/gantry stop` and the other `/gantry` forms. Slack refuses unknown slash commands, so its registered command is the one that works there.
  - **`!stop` and the other `!` forms are removed.** Help lists only the spelling for the provider it is shown on.
  - Owner choice, 2026-10-02: "/stop, plus Slack's /gantry stop".
- **A command is answered once.** On Discord, Gantry gives Discord's required acknowledgement silently and then shows the command's result. No "Gantry received …" message is sent.
- **Fallback text is just the content.** When a rich view can't be shown, the text version is sent without any preface about rendering.

**Decisions this changes:** the progress-card behaviour of 0110 (ambient liveness) is kept, and the separate progress surface is removed.

## Risks

- **A removed tool and removed command spellings.** Agents that call the form tool get a clear "not available, ask questions instead" error. People who type `!stop` get help showing `/stop`, once per conversation. No data is deleted.

## Acceptance criteria

- **AC1. No form tool.** The form tool is gone. Asking for several inputs uses questions, and every answer reaches the agent on Telegram, Slack and Discord.
- **AC2. One plan and progress card.** A turn that updates its plan and its progress shows one card, updated in place.
- **AC3. No "I'm on it" instruction.** The default agent instructions contain no first-message instruction.
- **AC4. Telegram "Other".** Tapping "Other" sends no message. A text reply to the question answers it, and nothing extra stays in the chat.
- **AC5. Options once.** On Telegram, Slack and Discord, each option label appears once in a question, in the text. The buttons show numbers.
- **AC6. Command spellings.** `/stop` stops a turn on Telegram, Discord and the web, and `/gantry stop` does on Slack. `!stop` is not a command, and gets help, once. Help shows one spelling per provider.
- **AC7. Discord commands.** A Discord `/gantry` command produces only its result message.
- **AC8. Fallback text.** A rich view that falls back to text carries no rendering preface.

## Success measure

- Metric: messages Gantry sends per answered request, excluding the answer itself, from the live database (median per week).
- Baseline: the median over the week before UX-1 starts.
- Target: half the baseline or less in the first full month after UX-1 merges.
- Check date: 2027-03-01

## Roadmap

- UX-1: One way to do each thing, and nothing said twice
