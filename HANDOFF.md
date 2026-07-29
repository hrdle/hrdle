# Hrdle — the record of the migration, and what is running now

The project that renamed CC Hub (`m0a/cc-hub`) to Hrdle
([#459](https://github.com/m0a/cc-hub/issues/459)). **The migration finished on
2026-07-29.** This document is not a plan. It records **what happened, what is
running, and how to go back**.

## The migration is done

```
m0a/cc-hub    archived / frozen at v0.2.98 / 0 open issues / 0 open PRs
hrdle/hrdle   v0.3.0 released / 8 issues (carried over from cc-hub)
```

`hrdle` holds the default herdr session (that is, every workspace) on 5924.
**cchub was not shut down** — it was moved to its own herdr session and is alive
on 5923.

### What is running

```
herdr.service        active / enabled     default session  <- used by hrdle
herdr-cchub.service  active / enabled     cchub session    <- used by cchub
herdr-hrdle.service  inactive / disabled  a leftover of running both; its job is done

hrdle.service   active / enabled   :5924  default session  11 workspaces
cchub.service   active / enabled   :5923  cchub session    0 workspaces (empty)
```

**The roles swapped; they still run side by side.** Before the migration cchub
held the default session and hrdle a named one; now it is the other way around.
Each is decided by one `HERDR_SESSION` line in its `EnvironmentFile`:

| | env | meaning |
|---|---|---|
| `~/.config/hrdle/env` | (absent) | takes the default session |
| `~/.config/cchub/env` | `HERDR_SESSION=cchub` | its own session |

The cchub side **starts from an empty session**. The 11 existing workspaces
belong to hrdle, so cchub cannot see them. Creating new ones works normally.

### There are two ways to carry on

**1. Just work in cchub** — 5923 is alive, so new workspaces can be created and
used there. If something happens to hrdle, it does not even have to be stopped.

**2. Take the 11 workspaces over** — if hrdle becomes unusable:

```bash
systemctl --user stop hrdle
# remove the HERDR_SESSION=cchub line from ~/.config/cchub/env
systemctl --user restart cchub          # :5923 takes the default session
```

**Stop hrdle first.** With both looking at the default session they fight over
the same panes (#520).

The lifelines:

- `~/bin/cchub` (v0.2.98) and `~/bin/cchub-v0.2.98-frozen` — the latter is a
  frozen copy placed out of reach of `cchub-update.timer`
- `~/.cc-hub` — intact (it holds only `herdr-last-known-sessions.json`, which
  listed 19 lost sessions from the default-session era, so it was emptied; the
  backup is `.bak-preswap`)
- `cchub.service` / `herdr-cchub.service` — both enabled, and both come back
  after a reboot

Archiving cc-hub **does not change reads**, so the release assets and
`install.sh` remain and `cchub update` keeps resolving up to v0.2.98 (measured).

### Leftovers — what may be deleted and what may not

**Kept permanently (the rollback lifeline):**

| | |
|---|---|
| `~/bin/cchub` / `~/bin/cchub-v0.2.98-frozen` | the latter is a frozen copy out of reach of `cchub-update.timer` |
| `~/.cc-hub` | metadata, `peers.json`, `jwt-secret` |
| `cchub.service` / `herdr-cchub.service` | both enabled. **Do not uninstall them** |

**Time-limited (review around 2026-08-29):**

- `~/cchub-work-1` / `-2` / `-3` — the working clones from the cc-hub era (over
  99MB each, about 300MB in total). Their herdr workspaces were deleted on
  2026-07-29, and **only the directories remain**. Zero uncommitted and zero
  unpushed were confirmed at deletion time, and the contents were moved to the
  hrdle side (#664 by cherry-pick, and #496 the same way). Their origin is the
  archived `m0a/cc-hub`, so **nothing new can be pushed from them**. Kept for a
  month as insurance right after the migration; once hrdle has run without
  trouble they can go

The hrdle working directories are `~/repos/hrdle-work-1..3` (`git worktree`,
6.9MB each plus node_modules). The cchub era used independent clones; worktrees
share one `.git`, so they replaced them. **Remember `bun install` after adding a
worktree** (see the pitfalls below).

### The distribution path is verified end to end

```
tag push -> release.yml -> GitHub Release -> install.sh -> hrdle update
```

All of it ran for v0.3.0. `hrdle update` fetches from the release, verifies the
SHA256, swaps the binary and **restarts the systemd service**, with the 11
workspaces surviving (v0.2.97 -> v0.3.0). The `install.sh` one-liner was also run
for real with `HRDLE_INSTALL_DIR` pointed at a temp directory.

### Groundwork upstream (all released)

| Release | PR | What |
|---|---|---|
| v0.2.84 | #635 | identity consolidation (installer and service names) |
| v0.2.85 | #637 | identity consolidation (runtime paths) |
| v0.2.92 | #653 | namespacing the localStorage keys plus a legacy fallback |
| v0.2.93 | #655 | herdr named session support (`HERDR_SESSION`) |
| v0.2.94 | #658 | routing the message catalogs through identity |
| v0.2.97 | #668 | three gaps a rename walks into (build.sh, dataDirEnv in tests, the operational scan) |
| v0.2.98 | #672 | routing ports and display names through identity (**cc-hub's last release**) |

### The values in identity.json

`identity.json` holds the values below. `shared/identity.ts` composes `SERVICE`
(unit names, launchd labels), `TMP_PATHS`, `assetName()` and `HOOK_COMMAND` from
them. **No call site changed.**

```json
{
  "productName": "Hrdle",
  "tagline": "Coding Agent Session Manager",
  "binaryName": "hrdle",
  "repo": "hrdle/hrdle",
  "assetPrefix": "hrdle",
  "defaultPort": 5924,
  "dataDirName": ".hrdle",
  "dataDirEnv": "HRDLE_DATA_DIR",
  "configDirName": "hrdle",
  "serviceName": "hrdle",
  "launchdPrefix": "com.hrdle",
  "storagePrefix": "hrdle-",
  "legacyStoragePrefixes": ["cchub-", "cc-hub-"],
  "tmpPrefix": "hrdle",
  "browserLogName": "hrdle-browser.log",
  "keychainService": "hrdle"
}
```

Verified: every test green (backend 535 / frontend 90 / glasses 120), lint and
typecheck green, `bun run build:binary` produced `dist/hrdle`, and `--help` calls
itself `hrdle` with default port 5924.

**Note: run `bun install` first.** Without dependencies, `hono` fails to resolve
and a pile of backend tests fail in a way indistinguishable from rename damage.

### Places that cannot read `identity.json` — three, not two

- `install.sh` — runs through `curl | bash`, so there is no checkout
- `.github/workflows/release.yml` — the matrix is evaluated before any step
- `scripts/build.sh` — **it was positioned to read the file and carried its own
  `dist/cchub` instead**. release.yml expects `mv dist/<binaryName>`, so a drift
  **breaks the CI build alone**. The test only looked at release.yml's string,
  and nothing checked those two against each other. It reads identity.json
  through `bun -e` now, which puts the number of copies back at two

The first two are checked for drift by
`backend/tests/unit/identity-consistency.test.ts`.

## Pitfalls found by measurement

### Renaming `dataDirEnv` points the tests at the real data directory (the big one)

Four tests escape their writes to a temp directory with
`process.env.CC_HUB_DATA_DIR = tempDir`. Rename the env var and that line becomes
**a line that sets nothing**, and the tests write into the real data directory.

```
backend/tests/unit/sessions.test.ts
backend/tests/unit/jwt-secret.test.ts
backend/src/services/__tests__/peer-registry-lock.test.ts
backend/src/services/__tests__/session-metadata-lock.test.ts
```

`~/.hrdle` really was created, holding 20 fake sessions and test metadata
(`ses-a`, `ses-b`, ...). **It shows up as contamination rather than failure**, so
a green suite hides it. All four go through `IDENTITY.dataDirEnv` now. **Do not
write a new env reference in that shape.**

### `identity-operational.test.ts` does not fail on a rename

The scan added in v0.2.94 looks for `cchub.service`, `com.cchub`, `/tmp/cc-hub`,
`.cc-hub` and `CC_HUB_DATA_DIR`. After a rename it **keeps passing while looking
for names that no longer exist**. The patterns are composed from `IDENTITY` now,
so the next rename carries them along.

### A rename breaks more than "two files" of tests

Rewriting `identity.json` failed 21 backend tests. What they were and how to
handle them:

- **Golden text** (the systemd unit and launchd plist in `setup-units.test.ts`,
  the scratch paths and keychain in `identity-consistency.test.ts`) -> **update
  the literals by hand**. A golden recomposed from identity matches any output,
  which destroys the point of a golden
- **Logic tests that happen to use a name** (hook detection, the codex hook
  migration, notifyCommandFor, herdr-agent-indicator) -> route them through
  `HOOK_COMMAND` / `IDENTITY`

### herdr injects `HERDR_SOCKET_PATH` into every pane

```
$ env | grep HERDR
HERDR_ENV=1
HERDR_PANE_ID=w4Q:p1
HERDR_SOCKET_PATH=/home/m0a/.config/herdr/herdr.sock
HERDR_TAB_ID=w4Q:t1
HERDR_WORKSPACE_ID=w4Q
```

So that variable **comes from the environment rather than from intent**, which is
why `HERDR_SESSION` takes priority over it (#655). Inverting that makes the most
natural way to test - starting it from a terminal inside another instance -
ignore the session, while appearing to work.

### Starting a test server from inside an agent stops transcripts being saved

A relative of the `HERDR_SOCKET_PATH` problem above, and **quieter**.

Claude Code sets `CLAUDE_CODE_CHILD_SESSION=1` on its children. Starting a test
server from that environment propagates the marker:

```
me (Claude Code)  CLAUDE_CODE_CHILD_SESSION=1
      | starting hrdle by hand from here
hrdle -> herdr(hrdle) -> pane -> claude
                                  \- judged a "child session" -> transcript saving OFF
```

The pane says
`Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`, but
**nobody sees it without looking at the terminal**. The conversation works
normally, so the breakage only surfaces **when a restart tries to restore it**:

```
claude --resume 25c60a6b-...
No conversation found with session ID: 25c60a6b-...
```

`resume_agents_on_restore` does its job, and **the log it should restore never
existed**. The restart on 2026-07-29 hit exactly this.

Started from systemd the environment is clean, so it does not happen (measured:
the MainPID environ of an hrdle started through the unit held only
`HERDR_SESSION`, and a session created there wrote 31KB to
`~/.claude/projects/<cwd>/<id>.jsonl`). **Test through the service too.**

### `HERDR_SOCKET_PATH` alone does not separate sessions

```
$ HERDR_SOCKET_PATH=.../sessions/x/herdr.sock herdr server
api socket: .../sessions/x/herdr.sock   <- separated
logs:       ~/.config/herdr/herdr-server.log  <- still the default
```

The socket moves; the session directory does not. `session.json` (the workspace
restore data) lives there, so two servers destroy each other's state. **Always
start with `herdr --session <name> server`.**

### `herdr session attach` cannot run inside a herdr pane

The nested-herdr check rejects it. The installer needs the server started rather
than attached, so this causes no harm.

### About the name (an unresolved concern)

`herdr` and `hrdle` are five characters apart by one transposition. Side by side
in a CLI, a log or the docs, they get mistyped. This repository has also already
migrated from tmux to herdr, so naming after the backend has a track record of
**the name stopping matching reality**. It was raised once that naming a rename
for generality after a dependency may point the wrong way, but **the user has
explicitly decided to go with Hrdle**. Do not reopen it.

## The stages of the migration (all complete)

### 1-2. Contributing back upstream (done — v0.2.97 #668 / v0.2.98 #672)

Every "value that does not go through identity" found during the rename was
**contributed upstream under the cchub name first** and then taken here. Leaving
them in the fork means a conflict on every sync, and each one was a cc-hub bug
independent of the rename.

The result is **zero code difference between the fork and upstream**: only the
values in `identity.json`, the icon and this document differ. Freezing therefore
came down to "stop looking at the remote".

What went back: build.sh's own copy, the `dataDirEnv` literals in tests, the
operational scan disabling itself, the ports in `cli.ts` and `glasses.ts`, the
FOUC script in `index.html`, the display strings, `frontendDevPort`, and making
`identity.json` importable from Node.

**One thing was sent back.** Removing `-p 3456` from `backend/package.json` was
wrong: `isDev = process.argv.some(a => a.includes('--watch'))` is **always
false** (bun does not pass `--watch` into a child's argv). Removing the explicit
port - the only breakwater - **turned dead code into a live path and let dev grab
the production port**. Upstream fixed it with `scripts/dev-backend.sh` and by
deleting the check (4c9864a). The lesson is that the branch's body was reviewed
and the branch itself was not.

### 3. Running both for real (done)

```bash
# the hrdle side
HERDR_SESSION=hrdle  # a separate herdr session (own server, own workspaces, own session.json)
port 5924            # dev on 3457 / 5174 (one along from cchub's 3456 / 5173)
~/.hrdle             # a separate data directory
```

**Several ports did not go through identity.** This is the kind of thing a rename
breaks most quietly:

- `DEFAULT_PORT = isDev ? 3456 : 5923` in `backend/src/cli.ts` — `--help` printed
  5924 from identity while it actually **bound 5923**. A renamed build would go
  after cchub's port, and on a machine with both it dies with EADDRINUSE. It
  never surfaced during testing because `-p` was always explicit
- `PRODUCTION_PORT = 5923` / `DEV_PORT = 3456` in
  `backend/src/commands/glasses.ts` — a `hrdle glasses` note flies to cchub
- `webServer.url` in `frontend/playwright.config.ts` — when it disagrees with
  vite's port the tests do not fail; they wait 120 seconds and report that the
  server did not start

The `identity-operational` scan **does not look at port numbers** (they are
digits, so false positives are easy). For now that layer is found by hand.

**`rm -rf ~/.hrdle` first** (if the contamination above left 20 fake sessions).

**To verify** (worked out on paper, unconfirmed in the field):

- Whether two services resident at once interfere
- Which one hooks reach (what to do about `cchub notify` in
  `~/.claude/settings.json`)
- That opening both UIs at once does not produce #520 (the takeover fight) — with
  the herdr sessions separated it should not, in theory
- How peer discovery sees 5923/5924

### 3.5 Restart verification (checking the supervised setup)

The systemd arrangement was rebuilt on 2026-07-29. **Parts of it can only be
confirmed by rebooting.**

What was built:

```
herdr.service         inactive/enabled   default session (for cchub)
herdr-hrdle.service   inactive/enabled   hrdle session (new)
cchub.service         Wants/After=herdr.service
hrdle.service         Wants/After=herdr-hrdle.service, HERDR_SESSION=hrdle in its EnvironmentFile
```

The dependencies exist because **cchub starting before herdr spawns herdr outside
systemd, and `herdr.service` then fails forever with "already running"**. It did
exactly that for three days from 7/26, failing 114,629 times at two-second
intervals (stopped with `systemctl --user stop herdr`; **not disabled**, so
systemd gets there first next boot).

#### Snapshot before the reboot (2026-07-29 20:28)

```
port 5923 (cchub): 19 sessions (1 working / 8 lost)
port 5924 (hrdle):  2 sessions (Welcome, parallel-check)
workspaces in the default session: hrdle, cchub-work-3, cchub-work-1, cchub-work-2,
                                   wheel-leg-bot, life, linux, pixel-customrom, repos,
                                   lifestyle-app-work-1, general questions
```

#### What to check after the reboot

```bash
# 1. did herdr come up under systemd (both active means yes)
systemctl --user is-active herdr herdr-hrdle cchub hrdle

# 2. has the loop returned (No entries means no)
journalctl --user -u herdr --since '2 minutes ago' | tail -5

# 3. were the sessions restored
curl -sk https://localhost:5923/api/sessions | jq '.sessions | length'   # expect 19
curl -sk https://localhost:5924/api/sessions | jq '.sessions | length'   # see below
```

**The hrdle session probably will not be restored.** There is no `session.json`
in `~/.config/herdr/sessions/hrdle/` (the default session has one). Whether a
named session never writes the restore data, or simply had no reason to yet, is
unconfirmed. **The reboot answers that.** Losing it costs nothing here (the hrdle
side holds only two test sessions), but **after the switch hrdle owns every
workspace, so a failure to restore would be a reason not to switch.**

Recovery if it fails: `systemctl --user start herdr` restores the default session
from `session.json`.

### 3.9 The "only found by running it" layer kept coming

The rename's gaps **were found by neither the tests nor CI; they needed the thing
started and looked at**, right to the end. In order:

| How it was found | What it was |
|---|---|
| Started the server | The startup banner said `CC Hub` |
| Opened a conversation | Images rendered as raw paths (the regex hardcoded `/tmp/cchub-images`) |
| Started it with no arguments | It bound a different port than `--help` printed (`isDev` written out in `cli.ts`) |
| Rebooted | `claude --resume` answered `No conversation found` |
| **Ran `update --check`** | **"To update: cchub update"** |

The last one turned up after the v0.3.0 release, during a real run of the
updater. Typing what it says gives `command not found` — in **the message that
prompts an update, the most visible place a rename can be wrong**.

What they share is that a wrong value throws nothing and the tests stay green.
The scan in `identity-operational.test.ts` targets this layer, but **port numbers
(digits, so false positives are easy) and display strings are still outside it**.

### 4. The switch (promote — done 2026-07-29 21:44)

`HERDR_SESSION=hrdle` was removed from `~/.config/hrdle/env`, `hrdle.service`'s
dependency moved from `herdr-hrdle.service` to `herdr.service`, and both
restarted. cchub is stopped before switching (the other order has both holding
the same workspaces, which is #520).

The handover came out as **an exact match on all 11 real workspaces**. `lost`
going 19 -> 0 is correct: 8 of the 19 were lost entries cached in cchub's
`~/.cc-hub`, and hrdle reads `~/.hrdle`, so it does not carry old lost sessions
in. **Nothing real was missing.**

The port stayed 5924. Leaving 5923 free means enabling cchub is all it takes to
go back. That decision turns `DEFAULT_PORT = 5923` in `peer-discovery.ts` from "a
small migration-period issue" into **a permanent one** (another machine's hrdle
can never be discovered).

### 5. The repository (done)

- `m0a/cc-hub` is **archived** (frozen at v0.2.98, zero open issues and PRs)
- **`m0a/hrdle` is still unclaimed.** Do not take that name; it keeps the rename
  option open
- **`gh issue transfer` could not be used** — GitHub's transfer works **only
  within one owner**. `m0a` (a person) to `hrdle` (an organization) is refused
  with `New repository must have the same owner`. The 8 issues were **migrated by
  copying** (hrdle#3-#10) and the cc-hub ones closed with a link to their new
  home. **Comment history does not carry over**, but cc-hub stays readable, so
  the original URL still works
- The 2 open PRs (#664, the vocabulary prompt for speech recognition, and #496,
  the false pane indicator badge) were **cherry-picked and merged as hrdle#2**,
  moved to the fork rather than merged into a frozen upstream
- The update paths are separate: cchub from `m0a/cc-hub`, hrdle from
  `hrdle/hrdle`

## What is still open

**None of it affects keeping the shop running.** There is no rush.

- **hrdle#3-#10** — the 8 items carried over from cc-hub
- **A list of probe ports** — `peer-discovery.ts`. "The port we go knocking on"
  is a protocol constant rather than `IDENTITY.defaultPort` (our own port), and
  the right shape is **a list of probe ports** with `defaultPort` as one entry.
  Raised in the upstream review
- **A guard for missed substitutions** — have `transformIndexHtml` throw when
  `/%[A-Z_]+%/` survives. Left in place, the FOUC script becomes a SyntaxError
- **A port guard (a scan)** — together with the probe list. Careful: a bare
  `\b3456\b` matches `formatUsd(12.3456)` (the `.` creates a word boundary). Use
  `(?<![\d.])` or require a `:PORT` context. Add `frontend/tests`, `glasses/src`,
  `scripts` and the config files to what is scanned
- **`legacyNames`** — old-name literals surviving a rename (`cchub.service` and
  the like) point at units that do not exist, which makes them real bugs worth
  catching. Shaped after `legacyStoragePrefixes`
- **Verifying #664 on the device** — the vocabulary prompt for speech recognition
  **was only ever verified against synthetic speech**. Its effect on a real
  microphone is still unknown
- **Migrating the metadata in `~/.cc-hub`** — themes and custom titles were not
  carried into `~/.hrdle` (the hrdle side starts fresh). `cp` them by hand if
  needed. **Do not build a fallback in code** (it creates a split brain and
  becomes code that is guaranteed to be dead after the switch)

Done since this list was written: the glasses display names (`phone-ui.ts` and
`verify.html` now come from the `define` path, v0.3.6), and the password
environment variable that `setup` wrote but the server never read (v0.3.7).

## References

- The design discussion itself:
  [m0a/cc-hub#459](https://github.com/m0a/cc-hub/issues/459) (closed as done).
  **Its body is out of date** though: the approach changed three times, and the
  body, comment 1, comment 2 and comment 3 contradict each other. **This
  HANDOFF.md is the current truth**, which is why #459 was not copied to hrdle
- The migrated issues: hrdle#3 (the wire protocol) / #4 (Web Push) / #5 (glasses
  and kimi) / #6 (the takeover fight) / #7-#9 (layout consolidation, UI
  unification, tap targets) / #10 (the glasses relay channel)
