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

How it plays out:

1. The binary on `PATH` is replaced. The server is still on the old version
2. `herdr status server` reports `compatible: no`, and the CLI's `agent list`
   returns nothing
3. hrdle's log fills with a `controller exited` -> `controller spawned` loop
4. systemd restarts the herdr server. It restores from `session.json`, and the
   workspace ids may change
5. Resume looks broken from the outside
6. The log reads as "the skew is doing damage, put the old binary back" — but
   the server has already moved, so rolling back manufactures the mismatch in
   the other direction

Step 6 is the second failure. **Before undoing anything, ask
`herdr status server` which version the server is on.** If the swap already
caused a restart, what needs reverting is the decision, not the binary.

## The correct procedure

### 1. Check the impact, and get agreement if needed

A restart **recreates every pane's PTY**.

- Agent conversations come back (confirm `resume_agents_on_restore = true` in
  `~/.config/herdr/config.toml`)
- **A running command does not come back**
- Workspace ids *may* change (labels are preserved). They sometimes do and
  sometimes do not. Record them and check rather than assuming either way
- **If you are inside one of those panes, you are restarted too.** Write down
  what matters before running it
- Expect some attrition among panes that were only *records* of an agent. After
  the 0.8.0 upgrade, `w5C` closed itself (`workspace.close` in herdr's log) and
  `w68` came back with only a shell — both had held agents already sitting at
  `revision: 0` with no `foreground_cwd`, i.e. restored session ids rather than
  live processes

### 2. Record the state first

So that "was it restored?" can be answered afterwards.

```bash
herdr --version
herdr status server                      # version / protocol / compatible
herdr workspace list                     # labels and pane counts
herdr agent list                         # agent count and native session ids
grep resume_agents_on_restore ~/.config/herdr/config.toml
```

### 3. Stop, update, start — in that order

**`herdr update` refuses to swap the binary while a server is running, and exits
0 while refusing.** Measured:

```
checking stable channel for updates...
running herdr targets:
  /home/m0a/.config/herdr/herdr.sock: server v0.7.5
  update: 0.8.0

downloading 0.8.0...
downloaded 0.8.0
Herdr was not updated.
Stop running Herdr sessions when ready, then run `herdr update` again.
```

So the server has to be down for the swap, and the three steps have to run from
**outside** the panes they are taking down — the first one kills the shell that
issued it. A transient systemd unit outlives them:

```bash
systemd-run --user --unit=herdr-upgrade --collect --service-type=oneshot \
  /path/to/upgrade.sh
```

with the script doing, and logging to a file that survives the pane:

```bash
systemctl --user stop herdr
herdr update                             # expect "installed <version>"
herdr --version                          # verify before starting back up
systemctl --user start herdr
herdr status server
```

`herdr update` from inside a pane is refused outright on `HERDR_ENV`
(`update failed: run 'herdr update' outside herdr after detaching from the
session`). Under `systemd-run` the environment is already clean; running it by
hand from a pane needs `env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u
HERDR_WORKSPACE_ID`.

### 3a. Or the apply button — but check which version of hrdle is running

```bash
curl -sk -X POST https://localhost:5924/api/herdr/apply-update
```

The dashboard button does the same thing. It does the stop/update/start above,
verifies the version actually moved, and restarts nothing when there is nothing
to install. It also reports that a new herdr exists at all, which is what makes
the button appear.

**An hrdle old enough to lack that does none of it.** There the endpoint runs
`herdr update` *first* and restarts herdr *after*, so it always hits the refusal
above, always exits 0, and reports success while restarting every pane PTY for
nothing — every workspace and every agent on the machine restarted, one of them
possibly mid-turn, with the version exactly where it was. And with binary and
server on the same old version there is no skew to see, so nothing appears at
all:

```json
{"binaryVersion":"0.7.5","serverVersion":"0.7.5","restartNeeded":false,"canApply":false}
```

So on an older hrdle, use section 3 and treat a 200 from this endpoint as
meaningless. What is actually available is one request away, unauthenticated:

```bash
curl -s https://herdr.dev/latest.json | jq '{version, protocol}'
```

### 4. Confirm the restore

```bash
herdr status server                      # compatible: yes, and the newer version
herdr agent list                         # the count matches what was recorded
curl -sk https://localhost:5924/api/sessions | jq '.sessions | length'
```

When the restart went through hrdle's own endpoint, connected browsers are told
(`herdr-restart` over `/ws/mux`) and re-subscribe when it ends. **A restart done
any other way — including the stop/update/start in section 3 — says nothing**,
so the browser keeps showing the pane it was watching, with no output and no
response to input, which reads as a hung page (hrdle#261). Tell the user to
reload; the backend is fine by then.

### 5. Update the integrations it asks for

`herdr update` ends by naming the integrations its new version outgrew:

```
installed herdr integrations need updating; run herdr integration install codex and herdr integration install kimi.
```

Do it — a stale integration degrades agent status reporting silently, which is
the kind of failure nobody attributes to the update weeks later.

```bash
herdr integration status                 # per agent: current / outdated / not installed
herdr integration install codex
herdr integration install kimi
```

## What not to do

- **`herdr update` from inside a pane** — refused with `update failed: run
  'herdr update' outside herdr after detaching from the session`. An agent is
  normally inside a pane
- **`herdr update` with the server still up** — it downloads, discards, prints
  `Herdr was not updated.` and **exits 0**. Never trust its exit code; compare
  `herdr --version` before and after
- **`herdr update --handoff`** — `CLAUDE.md` forbids it explicitly. A handed-over
  server is not supervised
- **Replacing the binary by hand** (`gh release download` then `mv`) — this is
  the accident above. A running binary cannot be `cp`-ed over (`Text file busy`)
  so `mv` swaps it, and incompatibility starts at that instant
- **Running it from the `hrdle update --auto` timer** — hrdle excludes this
  deliberately. A restart is a person's decision

## When a specific version is needed

`herdr update` moves to the latest stable. For a preview or a specific version,
`gh release list --repo herdrdev/herdr` shows what exists (the GitHub org moved
from `ogulcancelik` to `herdrdev` in 0.8.0; the old paths still redirect), but
**a manual swap is to be avoided for the reason above**. Check first whether
herdr itself offers a way to switch channels (`herdr update --help` only shows
`[--handoff]`, so a channel would be somewhere else) — the binary does know
about a preview channel, `https://herdr.dev/preview.json`.

## Related

- Do not judge whether a fix is in from a release date; compare it against the
  issue's creation date. [herdr#1789](https://github.com/herdrdev/herdr/issues/1789),
  reported on 2026-07-23, is not in v0.7.5 (released 2026-07-21), and it still
  reproduced after updating to v0.7.5 (measured). It is listed as fixed in
  v0.8.0
- The three hrdle-side defects this procedure works around: no detection of an
  available release, an apply command order that can never install, and a UI
  that needs a manual reload afterwards. When those are fixed, section 3a is the
  part that changes
- Driving herdr itself is the `herdr` skill (`~/.claude/skills/herdr/` — that is
  herdr's own repository, so do not write to it)
