---
name: glasses-relay
description: Send a note of your own to the G2 glasses relay channel with `hrdle glasses`. The rule is "say the one thing they need to decide, and otherwise stay silent". Triggers on "hrdle glasses", "tell the glasses", "グラスに伝えて", "主人に確認したい", "グラス通知".
---

# glasses-relay

The G2 glasses are not a screen that shows summaries. They are **the channel an
agent uses to reach its owner**. One page holds about 7 lines. Do not compress
mechanically - send only **what the owner needs in order to decide or act right
now**.

## When to send (this is the heart of the skill)

Send **only** when at least one of these is true:

- Is there something for them to **decide** (approve, choose, set a direction)?
- Is there a **blocker** only they can clear?
- Has something happened that **changes their next move**?
- Is there a **risk or a surprise** they should know about?

**If none of them hold, send nothing. Silence is correct.** Never send progress
reports, work logs or full summaries. Once the discipline of silence breaks, the
channel itself stops being trusted.

- Summary thinking (wrong): "edited 3 files, ran the tests, fixed 1 failure, all
  green"
- Contact thinking (right): "Tests are green. Ship it?"

## Usage

```bash
# Ask for approval or a choice (stays on the glasses until answered)
hrdle glasses "Tests are green. Ship it?" --kind waiting --choices "ship,hold"

# Report something that needs no decision (only the newest is kept; expires by TTL)
hrdle glasses "Deployed to staging" --kind info
```

- `--kind waiting` + `--choices`: approval or choice. Answerable on the glasses
  with the ring (swipe to select, tap to confirm).
- `--kind info`: a single fact that needs no decision (a completion, say).
  **One per session, overwritten.**
- Aim for one to three lines of text. The server clamps it to one page anyway.
- **One waiting item per session.** With an unanswered waiting item in place a
  second is rejected with 409 (it cannot overwrite). Before sending, ask again
  whether this really needs the owner's judgement.

## Session resolution

Usually **automatic** (a matching cwd first, then process ancestry). It errors
when that is ambiguous - in a worktree, for instance - and only then does
`--session <id>` need to be explicit:

```bash
hrdle glasses "..." --kind waiting --session my-session
```

## Notes

- It posts to both the production (5924) and dev (3457) ports and **fails
  silently**, exactly like `hrdle notify`, so it never blocks a Bash turn.
- An unmodified worker waiting for input (AskUserQuestion, a permission prompt)
  is detected by hrdle and reaches the glasses on its own. What you write here is
  only the **contextual request for a decision, or a completion**, that automatic
  detection cannot express.
- Answers come from the glasses (a choice through the ring, free text by voice).
  Your side just sends and waits.
