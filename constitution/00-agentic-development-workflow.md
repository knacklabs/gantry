# Playbook 00 - Agentic Development Workflow

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

### TL;DR Version 
```plain text
┌─────────────────────────────────────────────┐
│           AGENTIC DEV CHEAT SHEET           │
├─────────────────────────────────────────────┤
│                                             │
│  1. DECOMPOSE                               │
│     Break project → sequential + parallel   │
│     Bootstrap → Deploy → Auth → Features    │
│                                             │
│  2. PLAN (per feature)                      │
│     What → How → Acceptance criteria        │
│     → Implementation order → Out of scope   │
│                                             │
│  3. ITERATE THE PLAN                        │
│     Read it again. Find gaps. Fix them.     │
│     "Would a junior dev have questions?"    │
│                                             │
│  4. IMPLEMENT (agent does this)             │
│     Give plan to agent. Switch terminals.   │
│     Start planning the next feature.        │
│                                             │
│  5. REVIEW                                  │
│     Read the diff. Run tests. Try to break  │
│     it. Don't fix it — tell agent to fix.   │
│                                             │
│  6. PUSH                                    │
│     Commit → CI → Next feature              │
│                                             │
│  PARALLEL RULE:                             │
│  You plan. Agent implements. You review.    │
│  Rotate between these three activities.     │
│                                             │
└─────────────────────────────────────────────┘
```

---

### Why This Matters
Using AI coding agents like Codex or Claude Code as a "faster typewriter" (prompt → wait → accept/reject → reiterate) leaves 80% of the value on the table. The real productivity unlock comes from treating the agent as a **junior developer you manage**, not a fancy autocomplete.
The difference:

| Approach | What it looks like | Productivity gain |
| --- | --- | --- |
| Typewriter mode | Open IDE, prompt agent, wait, accept/reject | 1.5-2x |
| **Agentic workflow** | Plan in doc, iterate plan, agent implements, you review, parallel streams | **5-10x** |

---

### Part 1: The Mindset Shift

#### Stop Coding. Start Managing.
Your job changes from "person who writes code" to "person who designs, decomposes, and reviews." The agent writes. You think.
**Old loop:** Think → Code → Debug → Code → Debug → Ship
**New loop:** Plan → Agent implements → Review → Ship
The better your plan, the better the agent's output. Garbage in, garbage out — this hasn't changed.

#### CLI Over IDE
IDEs encourage you to watch the agent type. That's a trap. You're now a spectator burning time.
**Use the CLI instead.** Open a terminal, give the agent a task, switch to another terminal, and start planning the next feature. When the first task finishes, review it. This is how you run multiple streams in parallel.
Think of it like managing a team of 3-4 junior devs — you don't sit behind each one watching them type.

---

### Part 2: The Workflow

#### Step 0: Decompose the Project
Before touching any code, break the entire project into **independent, sequenced work units.**
**The decomposition order for any new application:**
```plain text
1. Bootstrap & Scaffolding
   - Project setup (Next.js/Express/etc.)
   - Linting (ESLint, Prettier)
   - Type checking (TypeScript config)
   - ORM setup (Prisma/Drizzle)
   - Docker / docker-compose
   - CI/CD pipeline skeleton
   - Environment config (.env structure)

2. Deployment (Yes, before features)
   - Infrastructure setup (GCP/AWS/Vercel)
   - Deploy the skeleton app
   - Verify it's live and healthy
   - Set up staging + production environments
   Why first? Because "it works on my machine" is not shipping.

3. Authentication & Authorization
   - Auth provider setup (Clerk/NextAuth/custom)
   - User model + migration
   - Login/signup flows
   - Role-based access (if needed)
   - Session management
   Why before features? Almost every feature depends on "who is the user."

4. Core Data Models
   - Define schemas for primary entities
   - Write migrations
   - Seed scripts for dev data

5. Feature Development (NOW parallelizable)
   - Feature A (backend + frontend)
   - Feature B (backend + frontend)
   - Feature C ...
   Each feature is an independent stream. This is where you go wide.
```
**Key insight:** Steps 1-4 are sequential (each depends on the previous). Step 5 is parallel. Most teams try to parallelise too early, creating merge hell.

#### Step 1: Write the Plan (Not the Code)
For each feature/task, create a plan document. Not a vague description — a specific, implementable plan.
**A good plan includes:**
```markdown
## Feature: [Name]

### What
One paragraph describing what this feature does from the user's perspective.

### Technical Approach
- What files need to be created/modified
- What APIs/endpoints are involved
- What the data model looks like
- What external dependencies are needed

### Acceptance Criteria
- [ ] User can do X
- [ ] API returns Y when Z
- [ ] Error case A is handled
- [ ] Tests cover B, C, D

### Out of Scope
- Things that are NOT part of this task (explicit boundaries)

### Implementation Order
1. First, do this
2. Then this
3. Then this
```
**Why this matters:** The agent follows instructions literally. If your plan is vague ("build a dashboard"), you'll get a generic mess. If your plan is specific ("build a dashboard with these 4 charts, using this API endpoint, with this filter sidebar"), you'll get something usable.

#### Step 2: Iterate the Plan
This is the step most people skip. Don't.
- Read the plan again. Find gaps.
- Ask yourself: "If I gave this to a junior dev, would they have questions?" If yes, add the answers to the plan.
- Run the plan by the agent: "Review this plan for gaps and edge cases" — use the agent's reasoning before using its coding.
- Update the plan 2-3 times before implementation.
**The plan is the product.** Code is just the plan compiled into a different format.

#### Step 3: Agent Implements
Now give the plan to the agent:
```plain text
Implement the following feature based on this plan:
[paste plan]

Follow the implementation order exactly.
Write tests for each acceptance criterion.
Don't modify files outside the scope of this feature.
```
**While the agent works:**
- Open another terminal
- Start planning the next feature (back to Step 1)
- Or review a previously completed feature

#### Step 4: Review
When the agent finishes:
1. **Read the diff** — don't just run it. Understand what changed.
1. **Run the tests** — did the agent actually write them? Do they pass?
1. **Check for drift** — did the agent modify things outside scope?
1. **Try to break it** — edge cases, invalid inputs, permission checks.
If something's wrong, don't fix it yourself. Tell the agent what's wrong and let it fix it. You're the reviewer, not the coder.

#### Step 5: Push & Move On
```bash
git add -A
git commit -m "feat: [feature name]"
git push
```
CI runs tests. If green, move to the next feature. If red, the agent fixes.

---

### Part 3: Parallel Execution
Once bootstrap + deploy + auth are done, your workflow looks like this:
```plain text
Terminal 1: Agent implementing Feature A
Terminal 2: You're planning Feature B
Terminal 3: Agent implementing Feature C (from earlier plan)

You rotate between:
- Planning (creative work, requires your brain)
- Reviewing (quality work, requires your judgment)
- The agent handles the implementation (mechanical work)
```
**Rules for parallelism:**
- Never have two agents modifying the same files simultaneously
- Use feature branches to isolate work
- Each feature should have clear file boundaries
- Review before merging — always

---

### Part 4: Task Decomposition Framework
When you get a big project and don't know where to start, use this framework:

#### The 4-Question Breakdown
For any feature or project, ask:
1. **What does the user see?** (UI/UX layer)
1. **What data does it need?** (Models/Schema layer)
1. **What logic connects them?** (API/Business logic layer)
1. **What external systems are involved?** (Integrations layer)
Each answer becomes a task. Each task becomes a plan.

#### Size Your Tasks
A good task for an AI agent:
- Takes the agent 5-30 minutes to implement
- Touches 3-10 files max
- Has clear inputs and outputs
- Can be tested independently
Too big → agent loses context and makes mistakes
Too small → overhead of planning exceeds implementation time

#### The Dependency Graph
Draw it out (mentally or on paper):
```plain text
Bootstrap ──→ Deploy ──→ Auth ──→ Feature A
                              ──→ Feature B
                              ──→ Feature C
		                                       ──→ Feature D (depends on C)
```
Work left-to-right. Parallelise only when the graph allows it.

---

### Part 5: Common Mistakes
1. **Prompting without a plan** — "Build me a REST API for users" → garbage
1. **Watching the agent code** — you're wasting your planning time
1. **Not reviewing** — the agent is confident but often wrong in subtle ways
1. **Fixing code yourself** — if you're typing code, you've lost the game
1. **No tests in the plan** — if you didn't specify tests, the agent won't write good ones
1. **Monster tasks** — one prompt to build an entire module = disaster
1. **No scope boundaries** — agent "helpfully" refactors unrelated code
1. **Skipping deployment setup** — "I'll deploy later" = "I'll debug infra issues during crunch time"

---

### Part 6: Daily Development Rhythm
```plain text
Morning:
  - Review yesterday's pending PRs
  - Plan today's 2-3 features (write plans)

Work blocks (90 min each):
  - Iterate plan → Give to agent → Switch to next plan
  - Review completed work → Push → Start next

End of day:
  - Review all PRs from the day
  - Note what's ready for tomorrow
  - Commit and push everything
```

---
