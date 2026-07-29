---
name: herdr-update
description: How to move herdr to a new version. hrdle spawns the herdr binary as a child process per pane, so incompatibility starts the moment the binary is swapped and the server restarts at a time nobody chose. Triggers on "update herdr", "bump herdr's version", "herdr is old", "switch to the preview channel", "hrdle says a herdr update is pending", "the update broke it / resume is broken", "herdr を更新して", "herdr のバージョンを上げて", "herdr が古い". Driving herdr itself (panes, tabs, workspaces) is a different skill (herdr).
---

# Updating herdr

## First: "swap the binary now, restart later" does not exist

hrdle **spawns `herdr terminal session control` as a child process** per pane
(`PaneController` in `services/herdr-client.ts`). The moment the binary is
replaced, a new CLI is talking to an old server and the controllers start
exiting as soon as they spawn. That churn makes systemd (`Restart=always`)
restart herdr, and **the server comes up on the new binary at a time nobody
chose**.

What actually happened on 2026-07-30 (0.7.4 -> 0.7.5):

1. `~/.local/bin/herdr` was replaced with 0.7.5. The server was still 0.7.4
2. `herdr status server` reported `compatible: no`, and the CLI's `agent list`
   returned nothing
3. hrdle's log filled with a `controller exited` -> `controller spawned` loop
   (w4Y:p1)
4. The herdr server restarted. It restored from `session.json` and **the
   workspace ids changed**, `w4W` -> `w53` -> `w54`
5. The user reported that resume felt broken
6. Reading the log, the conclusion was "the skew is doing damage, put 0.7.4
   back" — **but the server was already on 0.7.5**, so rolling back
   manufactured the mismatch in the other direction
7. Once noticed, going back to 0.7.5 finally made it consistent

Step 6 is the second failure. **Before undoing anything, ask
`herdr status server` which version the server is on.** If the swap already
caused a restart, what needs reverting is the decision, not the binary.

## The correct procedure

### 1. Check the impact, and get agreement if needed

A restart **recreates every pane's PTY**.

- Agent conversations come back (confirm `resume_agents_on_restore = true` in
  `~/.config/herdr/config.toml`)
- **A running command does not come back**
- Workspace ids change (labels are preserved)
- **If you are inside one of those panes, you are restarted too.** Write down
  what matters before running it

### 2. Record the state first

So that "was it restored?" can be answered afterwards.

```bash
herdr --version
herdr status server                      # version / protocol / compatible
herdr workspace list                     # labels and pane counts
herdr agent list                         # agent count and native session ids
grep resume_agents_on_restore ~/.config/herdr/config.toml
```

### 3. Apply it through hrdle

```bash
curl -sk -X POST https://localhost:5924/api/herdr/apply-update
```

The dashboard button in the web UI does the same thing. Under systemd it runs
`herdr update` and then `systemctl --user restart herdr`, and a failed
`herdr update` never reaches the restart (`buildHerdrApplyCommands` in
`services/herdr-update.ts`).

**This is the only correct route.** hrdle's server process lives outside herdr,
so `herdr update` is allowed there. Run from inside a pane it is refused (see
below).

With `canApply: false` the button does not appear. Look at `herdrUpdate` in
`GET /api/dashboard`:

```json
{"binaryVersion":"0.7.5","serverVersion":"0.7.5","restartNeeded":false,"canApply":false}
```

### 4. Confirm the restore

```bash
herdr status server                      # compatible: yes, and the newer version
herdr agent list                         # the count matches what was recorded
curl -sk https://localhost:5924/api/sessions | jq '.sessions | length'
```

## What not to do

- **`herdr update` from inside a pane** — refused with `update failed: run
  'herdr update' outside herdr after detaching from the session`. An agent is
  normally inside a pane
- **`herdr update --handoff`** — `CLAUDE.md` forbids it explicitly. A handed-over
  server is not supervised
- **Replacing the binary by hand** (`gh release download` then `mv`) — this is
  the accident above. A running binary cannot be `cp`-ed over (`Text file busy`)
  so `mv` swaps it, and incompatibility starts at that instant
- **Running it from the `hrdle update --auto` timer** — hrdle excludes this
  deliberately. A restart is a person's decision

## When a specific version is needed

`herdr update` moves to the latest stable. For a preview or a specific version,
`gh release list --repo ogulcancelik/herdr` shows what exists, but **a manual
swap is to be avoided for the reason above**. Check first whether herdr itself
offers a way to switch channels (`herdr update --help` only shows `[--handoff]`,
so a channel would be somewhere else).

## Related

- Do not judge whether a fix is in from a release date; compare it against the
  issue's creation date. [herdr#1789](https://github.com/ogulcancelik/herdr/issues/1789),
  reported on 2026-07-23, is not in v0.7.5 (released 2026-07-21), and it still
  reproduced after updating to v0.7.5 (measured)
- Driving herdr itself is the `herdr` skill (`~/.claude/skills/herdr/` — that is
  herdr's own repository, so do not write to it)
