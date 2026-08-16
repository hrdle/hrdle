# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Codex and other coding agents should use this file as the single source of repository guidance; `AGENTS.md` only points here.

## Project Overview

Hrdle is a web-based terminal session manager for coding agents — Claude Code, Codex, Grok, Kimi and OpenCode. It runs them in herdr workspaces and provides a web UI for remote access from tablets/mobile devices.

The product identity lives in `identity.json` — everything composed from it (service units, data directory, scratch paths, hook command, storage keys) follows without a call site changing.

## Language and Style Rules

**Write in English, no emoji.** These are hard rules, not preferences.

English is required for:

- Code comments (including JSDoc/TSDoc and inline notes)
- Log and console output: `console.log` / `console.warn` / `console.error`, backend logger calls, CLI stdout and stderr
- Test names (`describe` / `it` / `test` titles)
- `CHANGELOG.md`
- Commit messages, PR titles and PR bodies
- UI strings written directly in components (strings that do not go through i18n)

Japanese stays only where it is data, not prose written by us:

- `frontend/src/i18n/locales/ja.json` and the `ja` table in `backend/src/i18n/index.ts` — these *are* the Japanese product surface. Add new user-facing text as an i18n key with both locales rather than hardcoding either language
- Test fixtures whose Japanese is the thing under test (CJK line wrapping, full-width punctuation, the G2 display formatter)

No emoji in comments, log output, CLI output, `CHANGELOG.md` or commit messages. Status is carried by the words themselves (`error:`, `warning:`, `done`), not by a glyph. Two exceptions, both functional rather than decorative:

- `glasses/src/metrics.ts` — the emoji-to-G2-symbol substitution table; the emoji are input data the firmware cannot render
- Emoji used as a control's own label where it is the affordance (the file-picker key in `frontend/src/components/Keyboard.tsx`)

## Code Comments

**A comment carries non-obvious WHY and nothing else.** Write only what cannot be
recovered from the code itself: a hidden constraint, the reason a workaround is
there, behavior that will surprise whoever reads it next.

Do not write:

- **WHAT** — what the code plainly does (`// get the user id`), or a paraphrase
  of a function or variable name
- **Change history** — "added X", "the old implementation did Y", "renamed from
  Z". `git log` is where that lives, and it stays correct without anyone
  maintaining it
- **Task or issue references** — `(#538)`, `(UZU-1234)`. The tracker is where
  that lives

**Length is not confidence.** A passage you are unsure of does not become surer
for being explained at more length, and the padding reads as certainty to the
next person. Say "this part is unverified" in the PR description or in the reply
to whoever asked, where someone deciding whether to trust it will actually look.

Docs and `README.md` follow the same rule: a snapshot of the current
specification. Not issue references, not how it came to be, not migration
history.

## Migration Code Expires After a Week

Code that exists only to carry an old shape forward — a legacy storage key, a
previous file format, a renamed command's alias, a config the setup used to
write somewhere else — **lives for one week and is then deleted**. A week is
long enough for every install and every browser to have come through; past that
the compatibility path is dead weight that still has to be read, tested and
reasoned about by everyone who touches the code around it.

So a migration is written to be removed:

- Keep it in as few places as possible, and prefer one function with one caller
  over a fallback threaded through every read
- Deleting it must be a deletion, not an untangling
- When it goes, its tests and its config keys go with it

Judge the week from when the migration landed, not from when the old shape was
last seen in the wild.

**The mechanism is not the migration.** `migrateDataFileName` in
`utils/storage.ts` carries a data file across a rename of the thing that owns
it, and it stays — it is a utility like `atomicWriteFile`, and renaming a
service is a thing that keeps happening. What expires is each *call*: one line
plus one `LEGACY_*` constant, carrying its own delete-by date at the call site.
`services/stt-usage.ts` is the worked example.

## Commands

```bash
# Development (starts both backend and frontend)
bun run dev

# Individual services
bun run dev:backend   # Backend only (port 3457)
bun run dev:frontend  # Frontend only (port 5174)

# Steward work: isolated herdr server + data directory + the gate on.
# All three, or a thing that drives every workspace drives the user's own.
bun run dev:steward
bash scripts/dev-steward.sh --env    # to eval in a shell running herdr commands
bash scripts/dev-steward.sh --stop   # stop its herdr server

# Testing and linting
bun run test          # Run all tests
bun run test:e2e      # E2E tests (frontend only)
bun run lint          # Lint all packages

# Build
bun run build         # Build all packages
bun run build:binary  # Build single executable

# Stop dev servers
bun run stop
```

## Architecture

### Monorepo Structure

```
backend/     # Hono API server (Bun runtime)
frontend/    # React SPA (Vite + Tailwind v4)
shared/      # Shared types and Zod schemas (types.ts)
glasses/     # EVEN G2 smart glasses app (EvenHub SDK, built to out.ehpk)
```

### Backend Services

- **HerdrClient** (`services/herdr-client.ts`) - Low-level herdr socket API client: NDJSON RPC over `~/.config/herdr/herdr.sock` (one connection per request; `events.subscribe` held open), streaming-safe UTF-8 line reader, pane id mapping (`%N ↔ wK:pN`), and `PaneController` — a persistent `herdr terminal session control` subprocess per pane carrying raw PTY input (base64, no sanitization), absolute PTY resizes, and `terminal.frame` output records
- **HerdrControlSession** (`services/herdr-control.ts`) - One instance per Hrdle session (= one herdr workspace). Owns the pane split tree, tracks the focused pane, spawns lazy per-pane controllers (WS subscribe / first input only — read-only REST never takes over a pane), scans frames for cursor position and alt-screen state, client lifecycle with 30s grace period. **Renders a single tab**: a herdr workspace is `workspace > tab > pane`, so it filters to the active tab (`workspace.get`'s `active_tab_id`), follows tab switches via `tab.*` events (`switchActiveTab` re-hydrates the tree), and never merges tabs into one flat chain. `selectTab`/`createTab`/`closeTab` drive the tab set. Also `captureViewportHerdr`: viewport composition from `pane.read` (visible at offset 0, `recent` slice for scrollback, capped at herdr's 1000-line read limit)
- **HerdrLayout** (`services/herdr-layout.ts`) - Hrdle-owned split tree (herdr's own grid can't be resized headlessly): split/close/zoom/ratio adjust/absolute pane sizing, rendered to tmux-convention `TmuxLayoutNode` rects for the frontend
- **HerdrService** (`services/herdr.ts`) - Session-level operations mapping Hrdle sessions onto herdr workspaces: list (with agent detection from `pane.process_info`, native agent session ids from `agent.list`, `blocked` status), create/kill, previews, and `moveSession` — herdr's workspace order **is** the session display order, so a reorder is a `workspace.move` and nothing is stored on the hrdle side. **A session's id is herdr's `workspace_id` (`w5Q`), never its label**: the label is text a person edits, and the workspace-naming convention has every agent rewrite it twice per task, so addressing by it makes a session's address change mid-conversation — spoken replies 404 against a name that has just been rewritten, and the next thing said goes to a different session. A label is still *accepted* (it is what `hrdle send local:dev:%1` types, and what an already-installed ehpk still holds), but an ambiguous one resolves to nothing rather than to whichever workspace sorts first, and the delivery paths say so instead of answering 404. `session-id-migration.ts` moves settings keyed by a label onto the workspace id at startup, and only when exactly one live workspace carries that name
- **HerdrUpdateService** (`services/herdr-update.ts`) - Detects herdr binary-vs-server version skew (`herdr update` swaps the binary but leaves the running server old) by parsing `herdr status --json`, cached 30s and refreshed off the dashboard poll. Reports only — applying (`herdr update` + supervised restart; for a Homebrew-managed binary `brew upgrade herdr` *before* the bounce instead, because `herdr update` refuses brew installs with exit 1) is an explicit user action via `POST /api/herdr/apply-update`; never the `hrdle update --auto` timer, never `--handoff`. A failed self-update no longer strands the stopped server — the supervisor is restored on the old version. Unreadable status degrades to no warning
- **PaneState** (`services/pane-state.ts`) - Backend-agnostic `stripAnsi` / `detectPaneState` heuristics for peer-dialog tooling (`hrdle send --wait`, `hrdle peek`)
- **ClaudeCodeService** (`services/claude-code.ts`) - Monitors Claude Code state from `.jsonl` files; active-session matching uses only herdr's native agent session id
- **SessionHistoryService** (`services/session-history.ts`) - Reads past Claude Code session history and conversations
- **SessionMetadataService** (`services/session-metadata.ts`) - Persists session metadata (theme, STT vocabulary, last known sessions for recovery after reboot). Deliberately *not* session order or title — both live in herdr (order = workspace order, title = workspace label)
- **SessionsService** (`services/sessions.ts`) - Session CRUD operations with file-based persistence
- **PromptHistoryService** (`services/prompt-history.ts`) - Searches prompt history across sessions
- **FileService** (`services/file-service.ts`) - Secure file operations with path traversal prevention
- **FileChangeTracker** (`services/file-change-tracker.ts`) - Parses Claude Code `.jsonl` logs to track file changes
- **AnthropicUsageService** (`services/anthropic-usage.ts`) - Fetches usage limits from Anthropic API with 60s cache, 5min backoff on 429, in-flight request coalescing
- **AnthropicModels** (`services/anthropic-models.ts`) - Static metadata for Anthropic models (context size, pricing) used by cost/usage calculations
- **StatsService** (`services/stats-service.ts`) - Reads cached statistics from `~/.claude/stats-cache.json`
- **UsageHistoryService** (`services/usage-history.ts`) - Records usage snapshots to `/tmp/hrdle-usage-history.json` with 30s throttling
- **SystemMetricsService** (`services/system-metrics.ts`) - Collects CPU, memory, swap, and load metrics with history tracking (60 snapshots max)
- **SessionMetricsService** (`services/session-metrics.ts`) - Per-session token / cost metrics aggregated from `.jsonl` logs
- **CodexService** (`services/codex.ts`) - Codex CLI integration: spawns/attaches Codex sessions, watches state files
- **CodexConversationService** (`services/codex-conversation.ts`) - Reads Codex conversation transcripts and exposes them to the UI
- **CodexUsageService** (`services/codex-usage.ts`) - Tracks Codex token usage and rate-limit state
- **CodexHistoryService** (`services/codex-history.ts`) - Reads Codex rollout transcripts (`~/.codex/sessions`) and merges them into project history alongside Claude Code sessions
- **AgentProviders** (`services/agent-providers.ts`) - Common `AgentThreadService` / `AgentHistoryProvider` interfaces for thread-based agents (Codex, Grok, ...). Routes iterate provider maps in `routes/sessions.ts` instead of hardcoding an agent; adding an agent = one `AGENT_PROVIDERS` registry entry in `shared/types.ts` + implementations of these interfaces
- **GrokService / GrokSessionStore** (`services/grok.ts`) - Grok Build (xAI) integration: scans `~/.grok/sessions/<URL-encoded cwd>/<uuid>/` (`summary.json` metadata, `prompt_history.jsonl` first prompts, `updates.jsonl` `turn_completed` token usage), resolves the latest thread per working directory
- **GrokHistoryService** (`services/grok-history.ts`) - Grok session history + conversation reader: parses `chat_history.jsonl` (user records with `prompt_index`, assistant `tool_calls`, `tool_result`) into Claude-shaped conversation turns
- **GrokUsageService** (`services/grok-usage.ts`) - Aggregates Grok token consumption (24h/7d windows, per-model, plan badge) from `turn_completed` records for the dashboard's Grok tab. xAI exposes no rate-limit windows locally, so totals are all it can show
- **KimiService / KimiSessionStore** (`services/kimi.ts`) - Kimi Code integration: scans `~/.kimi-code/sessions/wd_<name>_<hash>/session_<uuid>/` (`state.json` metadata, main `agents/main/wire.jsonl` first prompt + `usage.record` token usage + last text part as the recap substitute shown on workspace cards), resolves exact threads by native session id
- **KimiHistoryService** (`services/kimi-history.ts`) - Kimi session history + conversation reader: parses `wire.jsonl` (`turn.prompt`, `content.part` text, `tool.call`, `tool.result` loop events) into Claude-shaped conversation turns
- **KimiUsageService** (`services/kimi-usage.ts`) - Aggregates Kimi token consumption (24h/7d windows, per-model) from `usage.record` records across all agent wires (`agents/main` + sub-agents) for the dashboard's Kimi tab. Kimi exposes no rate-limit windows or plan data locally, so totals are all it can show. Also prices each window/model in USD when the model resolves to OpenRouter — cost is omitted (never zeroed) for unpriceable models
- **KimiConfigService** (`services/kimi-config.ts`) - Parses `~/.kimi-code/config.toml` (via `Bun.TOML`) to map a `usage.record` model alias (`k3`) to its provider-side id (`moonshotai/kimi-k3`) and to supply the OpenRouter API key. Only OpenRouter-backed aliases are priceable
- **OpenCodeService / OpenCodeSessionStore** (`services/opencode.ts`) - OpenCode (sst/opencode) integration, and the **only provider that reads a database instead of files**: 1.18 keeps sessions, messages and their parts as rows in `~/.local/share/opencode/opencode.db` (WAL) — there is no `storage/` tree. Opened readonly per query, following the `codex.ts` precedent. Two things about that store are traps: the `project` table's `global` row is a catch-all whose `worktree` mutates as other directories are visited (so `session.directory` is the only stable cwd), and `session_input.prompt` looks like the first prompt but the table is never written at all in 1.18.13 — zero rows across sessions of both kinds, interactive TUI included — so the first user `text` part is used instead. Subagent sessions carry a `parent_id` and are excluded — they are turns of their parent, not sessions anyone opened
- **OpenCodeHistoryService** (`services/opencode-history.ts`) - OpenCode session history + conversation reader. A `tool` part holds the call **and** its result in one row (`state.input` / `state.output`), which the parser splits back across an assistant/user turn boundary because that is the shape `ConversationViewer` pairs by `toolUseId`; `reasoning`, `step-start` and `step-finish` parts are dropped
- **OpenCodeUsageService** (`services/opencode-usage.ts`) - Aggregates OpenCode token consumption (24h/7d windows, per-model) from assistant message rows for the dashboard's OpenCode tab. Like Grok and Kimi it has no rate-limit windows to show, but unlike them **the cost is not our estimate**: OpenCode computes and stores a per-turn `cost`, so the figure is its own. Absent (never zeroed) when no turn in the window carried one; a genuine 0 is what free models report
- **SttUsageService** (`services/stt-usage.ts`) - speech-to-text consumption by the glasses, **recorded rather than aggregated**: Groq has no usage endpoint and reports remaining quota only in `x-ratelimit-*` headers on a transcription response, so a request not written down as it happened is unrecoverable. `routes/glasses.ts` records on the way past (before the status is acted on - a 429 still spends quota - and without awaiting it), into `<dataDir>/stt-usage.json`. Tracks requests (capped per day) and audio seconds (capped per hour, and what the API is priced on) separately, because the two ceilings empty on different clocks. Cost is an estimate at the list price per hour of audio, never a billed figure. Named for the job rather than for Groq now that speech can be sent anywhere, but **only the billed target actually reaches the tally**: the record calls sit under `target.billed`, so a wearer using a custom endpoint exclusively sees an empty card
- **SttRequestResolver** (`services/stt-request.ts`) - The one place that decides what a transcription carries: `resolveSttRequest({ sessionId, lang })` returns the model, the language, the vocabulary prompt, each value's source and how the prompt was composed. `routes/glasses.ts` calls it once for `/stt` and serves it verbatim from `/stt-preview`, so the settings screen, the simulator and the terminal all read the object the transcription itself uses. Composition stays in `stt-prompt.ts`; the key stays out of the return value, because it is write-only
- **OpenRouterPricingService / OpenRouterAccountService** (`services/openrouter.ts`) - Pay-as-you-go cost reporting: list prices from the public `/api/v1/models` (no auth, 24h cache) drive *estimated* per-window costs, while `/api/v1/key` + `/api/v1/credits` (keyed, 60s cache, 5min failure backoff) report OpenRouter's *billed* daily/weekly/monthly spend and credit balance. Estimates use rolling windows, OpenRouter's are calendar windows, so the two never match exactly
- **ConversationWatcher** (`services/conversation-watcher.ts`) - Watches Claude Code / Codex `.jsonl` files and emits conversation updates to subscribed WebSocket clients
- **StewardStore** (`services/steward-store.ts`) - What the resident steward agent writes for a person to read (#383): its own thread, one overview line per session, and a per-session history of turns. **Written ahead of being read** - a wearer opening the overview must not wait for an agent to start thinking, so the screens read this store and never learn whether the steward is alive. On disk (`SessionMetadataService`'s pattern: `<dataDir>` JSON + mutation lock + atomicWrite) because the thread is promised to outlive the steward and the server restarts every release. Three files, because a line moves on every state change while a thread item only moves when a person is addressed. Turns upsert by id so the steward writes differences rather than rebuilding history; caps and `pruneToSessions` keep it bounded
- **StewardRuntime** (`services/steward-runtime.ts`) - Starts the steward, keeps it up, wakes it. It runs in **its own herdr session** (`steward`, or `<name>-steward` when hrdle runs against a named server), which is what makes it invisible to itself: it watches the default server's `agent list` and is not on it. Nothing here uses `herdrRpc` — this process resolves one socket and it is the wrong one. **A Claude Code session does not run on its own** (turns end; a bash poll loop accumulates context every tick), so the loop lives here, on two signals: a pane changing state, and a person writing into the steward thread — which moves no pane, so the first cannot see it. Measured on herdr 0.8.0: a prompt sent while an agent is working is **queued** until that turn ends, but **dropped when the pane shows a modal** (text sits unsubmitted in the input field), so the observer must never be in a position to be asked for permission. Writes `<dataDir>/steward/target.json` (watched socket, this server's port) because herdr exports `HERDR_SOCKET_PATH` into every pane, and a bare `herdr agent list` inside the observer's pane returns only the observer
- **StewardConfig** (`services/steward-config.ts`) - The gate (`HRDLE_STEWARD`, off by default) and the observer / worker models (default Sonnet, separately settable so a worker's long write-up can go somewhere heavier without slowing the observer). Gated on the server rather than in localStorage: hiding a mode in the client leaves its endpoints serving. **CLAUDE.md's one-week migration expiry does not apply** - this is a switch keeping an immature feature off screens, and it is deleted once the feature has reached everyone
- **HookStatusService** (`services/hook-status.ts`) - Reports whether the hooks Hrdle still needs are installed (`Stop` for notification text, `PostToolUse`/`AskUserQuestion` for the question's tool name). Indicator transitions come from herdr, not hooks
- **HerdrAgentStatusWatcher** (`services/herdr-agent-status.ts`) - Subscribes to herdr's per-pane `pane.agent_status_changed` (plus pane lifecycle events, which re-subscribe the pane set) and triggers an immediate sessions push. Decides *when* to rebuild the list, never what's in it — a dropped event costs latency, not correctness
- **AuthService** (`services/auth.ts`) - Password-based authentication with session tokens
- **PeerRegistry** (`services/peer-registry.ts`) - Persists peer server metadata to `peers.json` (with mutation locking), records per-peer success/failure state
- **PeerAuth** (`services/peer-auth.ts`) - Proxy login to peer servers (`POST /api/auth/login`), stores JWT tokens for subsequent API/WS calls, marks peers `unauthorized` on 401
- **PeerDiscovery** (`services/peer-discovery.ts`) - Scans the Tailscale tailnet (`tailscale status --json`) and probes each peer's `/health` in parallel to find running Hrdle instances. The probe port comes from `IDENTITY.defaultPort`. A literal there stops matching the moment the identity changes, and the failure is silent: a tailnet full of installs discovers nothing
- **Discovery** (`services/discovery.ts`) - One plaintext endpoint, `GET /whoami`, on `port + 1`, answering with the server's Tailscale FQDN, product name and version and nothing else. It exists so a phone can be told `91.210.90` instead of `https://beelink-arch.tail4459c9.ts.net:5924` — **plaintext is the requirement, not a shortcut**: the certificate is issued for the FQDN, so reaching the machine by IP or short hostname fails TLS, and `fetch` has no way past a certificate error the way a browser's warning page does. One unverified request buys the name; everything after it is ordinary verified HTTPS, and a tailnet caller's packets are inside WireGuard regardless. Only callers on a private or CGNAT address get an answer. `100.` is the only part of a Tailscale address that can be dropped — the second octet onwards is allocated per node, not per tailnet
- **PeerUrl** (`services/peer-url.ts`) - SSRF guard for peer URLs: only allows Tailscale hosts (`*.ts.net`, CGNAT `100.64.0.0/10`, ULA `fd7a:115c:a1e0::/48`)

### Key API Routes

**Sessions** (`/api/sessions`):
- `GET /` - List all sessions with Claude Code state and pane info
- `POST /` - Create new Claude Code session
- `GET /:id` - Get session details
- `DELETE /:id` - Close session
- `POST /:id/resume` - Resume Claude Code session with `claude -r`
- `POST /:id/panes/focus` - Focus a pane (`{ paneId }`)
- `POST /:id/panes/close` - Close a pane (`{ paneId }`, rejects last pane)
- `POST /:id/panes/split` - Split a pane (`{ paneId, direction: 'h'|'v' }`)
- `POST /:id/panes/input` - Send input to a pane over REST (used by `hrdle send` / peers)
- `GET /:id/panes/:paneId/viewport` - Capture a pane viewport over REST (used by `hrdle peek` / `--wait`)
- `POST /:id/tabs/select` - Switch the workspace's active tab (`{ tabId }`)
- `POST /:id/tabs/create` - Create and switch to a new tab
- `POST /:id/tabs/close` - Close a tab and all its panes (`{ tabId }`)
- `POST /:id/prompt` - Send a prompt to the session's agent
- `PUT /:id/theme` - Set session color theme
- `PUT /:id/title` - Rename the session's herdr workspace (the label is the name *and* the public session id, so the response carries the new `id`)
- `PUT /:id/stt-prompt` - Set the words this session's speech is made of (leads its STT vocabulary bias)
- `POST /:id/move` - Move a session to `{ index }` in the display order (writes straight through to herdr's workspace order — hrdle stores no order of its own)
- `GET /prompts/search` - Search prompt history

**Session History** (`/api/sessions/history`):
- `GET /` - Get past Claude Code session history
- `GET /projects` - List projects with sessions
- `GET /projects/:dirName` - Get sessions for a project
- `GET /search` - Search sessions across all projects
- `GET /search/stream` - Stream search results (SSE)
- `GET /:sessionId/conversation` - Get conversation for a session
- `POST /resume` - Resume session from history
- `POST /metadata` - Update session metadata

**Files** (`/api/files`):
- `GET /list` - Directory listing
- `GET /read` - File content (with size limits, images/media return metadata only)
- `GET /raw` - Stream file inline for `<img>`/`<video>`/`<audio>` (Range request / 206 supported)
- `GET /download` - Download file as attachment (streamed via `Bun.file()`)
- `POST /upload` - Upload file(s) via multipart/form-data (streamed via `Bun.write()`)
- `GET /browse` - Browse directory tree
- `GET /changes/:sessionWorkingDir` - Claude Code changes from `.jsonl`
- `GET /git-changes/:workingDir` - Git-tracked changed files (`git status --porcelain`)
- `GET /git-diff/:workingDir?path=...` - Unified diff for a specific file (`git diff`)
- `GET /images/:filename` - Serve conversation images
- `GET /language` - Detect file language
- `POST /mkdir` - Create directory

**Peers** (`/api/peers`) — multi-server federation over Tailscale:
- `GET /` - List registered peers
- `GET /discover` - Discover Hrdle instances on the Tailscale tailnet
- `POST /` - Register a peer / `DELETE /:id` - Remove a peer
- `POST /:id/verify` - Re-verify connectivity and auth for a peer
- `PUT /order` - Set peer display order
- `GET /sessions` - Aggregate active sessions across all peers
- `GET /history/projects` - Aggregate project history across peers
- `GET /history/:peerId/projects/:dirName` - Sessions for a peer's project
- `GET /history/:peerId/:sessionId/conversation` - Conversation from a peer session
- `POST /history/:peerId/resume` - Resume a session on a peer
- `GET /:peerId/files/browse`, `POST /:peerId/files/mkdir`, `POST /:peerId/upload/image`, `GET /:peerId/dashboard` - Proxied peer operations

**Steward** (`/api/steward`) — behind `HRDLE_STEWARD`; every route below 404s when it is off:
- `GET /enabled` - **Answers either way.** The CLI asks it to tell "switched off" apart from "server too old", which a 404 cannot say
- `GET /` - Snapshot: the thread and every session's overview line
- `POST /thread` - The steward writes (`kind: notify | ask | report`). An `ask` gets the thread item's own id back as its `ask_id`
- `POST /thread/reply` - A person answers (`askId` + `answer`, where `dismissed` is one of the answers) or simply says something (`text`)
- `sessionId` on either says **which session the entry is about**, and an entry that carries one is mirrored into that session's turns under the same id. Without the field the steward wrote the workspace id into the text (`"w4H: ..."`), which spends the page budget on it and links to nothing; and an answer that lived only in the thread left the screen the question was asked from showing nothing. A `report` carries none - it crosses sessions by definition
- `PUT /sessions/:id/line` - The overview row for one session
- `GET`/`POST /sessions/:id/turns` - That session's glasses-side history; POST upserts by turn id
- `GET /screen` - What the glasses are showing right now (the mirror's last frame, or null)
- `PUT /settings` - Which model each half runs (read back through `/enabled`)

**Terminal WebSocket** (`/ws/mux`):
- Multiplexed WebSocket — single connection serves all sessions
- Client subscribes/unsubscribes per session via JSON messages
- Client messages (`MuxClientMessage`): `subscribe`, `unsubscribe`, `subscribe-conversation`, `unsubscribe-conversation`, then per-session (`ControlClientMessage`): `input`, `resize`, `split`, `close-pane`, `resize-pane`, `select-pane`, `adjust-pane`, `equalize-panes`, `zoom-pane`, `request-viewport`, `select-tab`, `create-tab`, `close-tab`, `ping`, `client-info`
- Server messages (`MuxServerMessage`): `subscribed`, `unsubscribed`, `sessions-updated`, `conversation-subscribed`, `conversation-unsubscribed`, `initial-conversation`, `conversation-update`, then per-session (`ControlServerMessage`): `layout`, `viewport`, `ready`, `pong`, `error`, `hook-event`
- Server periodically pushes `sessions-updated` (5s interval) with full session list
- `subscribe-steward` / `unsubscribe-steward` carry no sessionId: one subscription covers the thread and every session's line and turns, because the overview needs all of them at once. The **snapshot on subscribe carries the thread and the lines only** — turns arrive as live `steward-turns` pushes, or from `GET /api/steward/sessions/:id/turns` when a client opens one

**Other**:
- `GET /api/dashboard` - Dashboard data (usage limits, statistics, cost estimates, system metrics, usage history, herdr version skew)
- `POST /api/herdr/apply-update` - Apply a pending herdr update (`herdr update` + supervised restart). User-initiated only; restarts every pane PTY
- `POST /api/upload/image` - Upload image file
- `POST /api/glasses/stt` - Transcribe glasses audio through Groq
- `GET /api/glasses/stt-preview?session=&lang=` - What a transcription from that session would carry (model, language, prompt, each value's source, how the prompt was composed). The same object `/stt` resolves; never the API key
- `GET /api/glasses/settings` / `PUT /api/glasses/settings` - The voice-input settings the glasses app's own screens edit (key write-only)
- `POST /api/notify` - Receive hook events from Claude Code / Codex
- `GET /api/notify/hook-status` - Per-session hook indicator state (lists sessions with missing hook setup)
- `POST /api/auth/login` - Login
- `GET /api/auth/required` - Whether password auth is enabled
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user
- `POST /api/logs` - Frontend log submission / `GET /api/logs` - Read logs / `DELETE /api/logs` - Clear logs

### Frontend Components

**Layout**:
- **DesktopLayout.tsx** - The layout, for all three screens. `variant` (`desktop` / `tablet` / `mobile`) is what differs; herdr control mode, the pane tree and the keyboard shortcuts are shared. The phone's differences are the ones a phone actually has: no header (its bar is at the bottom, drawn by `TerminalComponent` so the soft keyboard cannot push it off), one pane at a time chosen from a tab bar, a full-screen dashboard rather than a side panel, and no remembered pane tree - its tree is whichever session the app says is active. **One pane at a time is a server zoom, not a narrowed render**: the resize this client sends is the whole window's, so a split would divide it again and the PTY would be half the screen
- **PaneContainer.tsx** - Tree-based pane renderer with `ControlModeContext` for pane operations (split, close, zoom, resize)
- **SessionModal.tsx** - Session picker modal (Ctrl+B) with pane count badges and expandable pane list

**Terminal**:
- **Terminal.tsx** - xterm.js terminal with WebGL rendering, **`scrollback: 0`** (server-side scrollback). `ControlModeConfig` for pane size sync (`proposeDimensions()` instead of `fit()`, `setExactSize()` from the layout) and viewport delivery (`registerOnViewport`, `scrollBy`, `scrollToLive`). Each new viewport is converted to a VT escape sequence (`viewport-render.ts`) and `term.write()`-ed to refresh the screen. Supports font size adjustment, desktop text selection with auto-copy, touch selection mode for mobile/tablet
- **SelectionOverlay.tsx** - Touch-selection overlay rendered above the terminal: draggable start/end handles, copy/cancel controls, computed from xterm `_core` cell metrics
- **viewport-render.ts** (`utils/viewport-render.ts`) - Converts a `PaneViewport` into a VT sequence (`\x1b[?25l` + per-row `\x1b[r;1H\x1b[2K<line>` + cursor restore) that xterm.js can apply with a single `term.write()`
- **terminal-links.ts** (`utils/terminal-links.ts`) - URLs visible in a viewport, rejoined across the rows they were wrapped over, shown as a copy/open chip in the corner of the pane. **A pane's own copy key cannot reach the browser's clipboard**, which is why this exists: `c to copy` on Claude Code's login screen writes `ESC ] 52 ; c ; <base64> ST` and nothing else once the host has no `DISPLAY` — and herdr's renderer consumes that sequence, so it appears neither in the control stream's frames nor anywhere in `herdr api schema --json` (measured on herdr 0.7.5; asked for upstream in herdrdev/herdr#1459). The `registerOscHandler(52, ...)` in `Terminal.tsx` is therefore dormant, deliberately kept for the day that lands. Rejoining is a heuristic and has to be: `recent_unwrapped` returns the same pieces as `visible`, because Claude Code's TUI hard-wraps its own output and leaves no wrap flag to consult. So the only join made is at the boundary itself — a URL ending the last column of a row that is *full*, continued by the leading URL-character run below. Both halves matter, and so does stripping the `\r` every row arrives with: with it left on, a full 160-column row measures 161, stops looking full, and every wrapped URL silently truncates

**Session Management**:
- **WorkspaceList.tsx** - Full session list with tabs (Active/History/Dashboard), pane list with focus/close/split actions, drag-to-reorder, the create-session modal (name, directory, agent, machine), pinch-to-zoom support
- **SessionHistory.tsx** - Past session browser with project grouping
- **ConversationViewer.tsx** - The transcript, read-only, laid out after the Claude app: the user's turns as bubbles on the right, the agent's as a full-width column, on a warm neutral surface of its own (`--color-conv-*` in `index.css`, not the session's terminal color). A tool call and its result render as **one** collapsed card - the transcript stores them a message apart (call on the assistant turn, result on the user turn after it), so `buildRows` pairs them by `toolUseId` and drops the result-only message, which otherwise appears as a "System" speaker saying the output of something two screens up. Consecutive turns from one speaker are labelled once. Code is syntax-highlighted through highlight.js (already in the bundle for the file viewer), but **not** with one of its themes - the `hljs-*` classes are re-coloured against the conversation palette under `.cv-code` in `index.css`, because every shipped theme is a different room's lighting and all the dark ones are cold. A fence names its own language; a tool result never does, so it borrows the language of the file the call named - and only when the output has line breaks, since a one-line result is a status message rather than a listing

**History V2** (`components/history/`, on by default; `hrdle-history-v2: "false"` opts back into the legacy list). Shares the conversation's palette (`--color-conv-*`): browsing past sessions and reading one are the same act, and a cold list opening onto a warm transcript announced a seam that isn't there.
- **SessionHistoryV2.tsx** - Flat searchable history list with facet filtering
- **HistoryRowV2.tsx** - One row: the recap leads (or the prompt, dimmer, when there is no recap), then one muted line of `project · agent · branch · when`. Message count and duration are deliberately not on it - a list is for finding which conversation this was, and both were noise at that job
- **HistoryFacetSidebar.tsx** / **HistoryFacetDrawer.tsx** - Facet filters (desktop sidebar / mobile drawer)
- **HistoryActiveChips.tsx** - Active filter chips
- **VirtualizedHistoryList.tsx** - Virtualized scrolling for large histories

**Peers**:
- **PeerManager.tsx** - Peer server management UI (register, verify, discover, reorder, remove)
- **dashboard/PeerServerCard.tsx** - Per-peer server info card with system metrics

**Chat** (`components/chat/`):
- **ChatView.tsx** - Conversation-style view of the current session, replacing the terminal area when "Chat" mode is selected. Reading the agent's transcript, it is **read-only**: two places to type into one pane make it ambiguous which one is listening, and it is never the one on screen. In steward mode it is the steward's summary instead, and then it *does* have a composer - because that one is not a second way into the pane, it addresses the steward about this session. The pane's own input bar is locked shut while it is up (`lockInputHidden`), which is the same rule, not an exception to it

**Keyboard / Input**:
- **InputBar.tsx** - Persistent input bar above the terminal with prompt history, slash-command picker, image upload, sendable to the focused pane
- **FloatingKeyboard.tsx** - Draggable floating keyboard for tablets, minimizable, saves position per input mode
- **Keyboard.tsx** - Virtual keyboard for mobile with long-press for symbols

**Files** (`components/files/`):
- **FileViewer.tsx** - Container with file browser and content viewer, Claude/Git change toggle, browser history navigation, file upload/download, video/audio playback
- **FileBrowser.tsx** - Directory tree navigation
- **FileContentView.tsx** - Routes file content to the right viewer (code/image/markdown/html/media)
- **ChangesView.tsx** - Claude Code / Git change list with per-file diff navigation
- **CodeViewer.tsx** - Syntax highlighted code display
- **DiffViewer.tsx** - Side-by-side diff view for file changes
- **ImageViewer.tsx** - Image preview with zoom (uses `/files/raw` streaming for large images)
- **MarkdownViewer.tsx** - Markdown rendering
- **HtmlViewer.tsx** - HTML file rendering via iframe
- **PromptComposer.tsx** - Prompt text composition interface

**Dashboard** (`components/dashboard/`):
- **Dashboard.tsx** - Main dashboard container
- **DashboardPanel.tsx** - Dashboard side panel wrapper (Ctrl+Shift+B)
- **UsageLimits.tsx** - 5-hour/7-day usage cycle display with progress bars
- **DailyUsageChart.tsx** - Message and session count bar charts
- **ModelUsageChart.tsx** - Opus/Sonnet token usage comparison
- **HourlyHeatmap.tsx** - Activity heatmap by hour
- **UsageChart.tsx** - Usage history line chart with real-time snapshots
- **NetworkLatency.tsx** - WebSocket latency display
- **ServerInfo.tsx** - Server information and system details

**Other**:
- **LoginForm.tsx** - Password authentication form
- **Onboarding.tsx** - Spotlight-style walkthrough for new users

### Frontend Hooks

- **useMultiplexedTerminal.ts** - WebSocket connection to `/ws/mux` for multiplexed terminal I/O. Handles auto-reconnect, keepalive pings, session subscribe/unsubscribe, base64 I/O encoding, viewport dispatch (`onPaneViewport` callback). Returns `sendInput`, `resize`, `splitPane`, `closePane`, `selectPane`, `zoomPane`, `adjustPane`, `equalizePanes`, `requestViewport`, `sendClientInfo`
- **useWorkspaces.ts** - Active sessions state management
- **useSessionHistory.ts** - Session history browsing
- **useDashboard.ts** - Dashboard data fetching
- **useFileViewer.ts** - File viewing state
- **useAuth.ts** - Authentication state management
- **useTheme.ts** - Dark/light theme management
- **useRemoteControlMode.ts** - Whether the desktop renders the terminal itself. **Default: it does not.** On a desktop the terminal is already on screen in herdr, and a second copy of it painted over a WebSocket is the slowest thing here for the least it buys; what the desktop is for is the part herdr has no answer to — the session list, history, the dashboard, starting a session. Everything except the live render still works in this mode (focus, split/close via REST, tabs, prompts, Files, Dashboard, Chat), so it is a narrower desktop rather than a read-only one. Tablets and phones have no local herdr, so the gate is `variant === 'desktop' && flag` in `DesktopLayout`, and the toggle stays for a desktop browser away from the herdr host. Stored under `hrdle-desktop-terminal`, written only by a deliberate toggle — the previous key was written on mount, so it held an explicit value nobody had chosen and the default could not be changed
- **useUiScale.ts** - Persists and applies the global UI scale factor
- **useNetworkLatency.ts** - WebSocket latency tracking
- **useLineSelection.ts** - Text line selection utilities
- **useSelectionMode.ts** - Touch-selection state machine for `SelectionOverlay` (start/end cell, drag handles, copy-to-clipboard)
- **useConversationStream.ts** - Subscribes to `/ws/mux` conversation streams (`subscribe-conversation`) and exposes incremental conversation updates. The subscription carries the **pane's** `agentSessionId`, not just the workspace id: a workspace with two agent panes holds two conversations, and resolving by directory alone answers with whichever transcript was written last - a different agent from the one on screen
- **useAgentConversation.ts** - Unified conversation hook: Claude streams over the WebSocket, thread agents (Codex/Grok) poll over HTTP — chosen from the shared `AGENT_PROVIDERS` registry
- **useThreadConversation.ts** - Polling conversation loader for thread-based agents (`?agent=codex|grok`)
- **usePeers.ts** - Peer list CRUD and state management (`/api/peers`)
- **usePeerConnection.ts** - Resolves connection info (HTTP/WS URLs, auth) for the active peer
- **usePeerSessionsWatcher.ts** - Persistent `/ws/mux` WebSocket per remote peer so `sessions-updated` pushes arrive without polling
- **usePeerServerMetrics.ts** - Fetches a peer's dashboard metrics for `PeerServerCard`
- **useHistoryActions.ts** - History operations (resume, delete, metadata updates)
- **useFlatHistoryItems.ts** - Flattens project-grouped history into a filterable list for History V2
- **useHistoryV2Flag.ts** - History V2 opt-in flag (`hrdle-history-v2` localStorage)
- **useViewHistory.ts** - File viewer back/forward navigation history (browser/file/changes/diff view modes)
- **useViewerSettings.ts** - File viewer preferences (word wrap, font size) persisted to localStorage
- **useAuthBlobUrl.ts** - Fetches protected resources with auth headers and exposes them as blob URLs
- **usePinchZoom.ts** - Pinch-to-zoom gesture handling for touch devices
- **useScrollRatio.ts** - Tracks scroll position ratio of a scrollable element

### Keyboard Shortcuts (Desktop)

**Every chord here is listed in `isAppShortcut` (`utils/terminal-filters.ts`),
and adding one to this table without adding it there does not give you a
shortcut.** xterm.js consumes a key it has a binding for and calls
`stopPropagation()`, so the window listener that runs the shortcut never sees
it — the pane gets the control byte instead. Whether xterm binds a chord also
depends on the pane's mode, so trying it once is not evidence: `Ctrl+Shift+Arrow`
reached the window from a Claude Code pane and was swallowed by a plain zsh one.

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Open session modal |
| `Ctrl+Shift+B` | Toggle dashboard panel |
| `Ctrl+Shift+E` | Split pane vertically (new pane on the right) |
| `Ctrl+Shift+D` | Split pane horizontally (new pane below) |
| `Ctrl+Shift+X` | Close current pane |
| `Alt+Arrow` | Move focus between panes |
| `Ctrl+Shift+Arrow` | Resize pane |
| `Ctrl+Shift+=` | Equalize pane sizes |
| `Ctrl/Cmd+1`..`9` | Switch session |
| `Ctrl/Cmd+=` or `+` | Increase font size |
| `Ctrl/Cmd+-` | Decrease font size |
| `Ctrl/Cmd+0` | Reset font size to default (14px) |
| `Ctrl/Cmd+C` (with selection) | Copy selected text |
| `Ctrl/Cmd+V` | Paste from clipboard |

**`Ctrl+D`, `Ctrl+W` and `Ctrl+Arrow` belong to the pane**, and the app's
versions of those live on the Shift'd chords above. They are EOF, delete-word
and word motion in every shell, and the browser has no other way to send them —
taking them means a REPL cannot be exited from a phone. `Ctrl+D` used to split
a pane and instead exited the shell, closing the pane and, when it was the last
one, the whole workspace.

`Ctrl+Shift+W` is not available for anything: the browser keeps it for closing
its own window and a page cannot preventDefault it. Same for `Ctrl+W` and
`Ctrl+T`.

### Terminal Communication

```
Browser <--WebSocket (/ws/mux, JSON)--> Hono Server <--NDJSON socket + per-pane control streams--> herdr server <--PTY--> Claude Code
```

The backend upgrades HTTP to WebSocket at `/ws/mux`. A single multiplexed connection manages multiple session subscriptions. Each subscription creates a `HerdrControlSession` (one per herdr workspace) that talks to the herdr server over its socket API and holds one `PaneController` (persistent `herdr terminal session control` subprocess) per pane for raw input, PTY sizing, and `terminal.frame` output events. Terminal I/O is multiplexed per-pane and per-session using `MuxClientMessage` / `MuxServerMessage` types in `shared/types.ts`.

The frontend is **render-only**: xterm.js has `scrollback: 0`, and history is held by herdr. The server periodically and on-demand sends `PaneViewport` frames (a snapshot of `rows` lines at a given scrollback offset, plus cursor/mode metadata) which the client applies via `viewportToVTSequence()` + `term.write()`.

Key behaviors:
- **Session push**: Server pushes `sessions-updated` every 5s with full session list (replaces polling)
- **Layout**: Hrdle owns the split tree (`herdr-layout.ts`) because the herdr grid can't be resized headlessly; pane PTYs are sized individually via each pane's control stream, and layout updates go to all connected clients
- **Size management**: Client sends container size, the split tree computes pane rects, xterm.js uses `setExactSize()` from layout. `setClientSize` absorbs ±1-row mobile noise so viewports don't re-emit on minor resize
- **Viewport protocol**: Client sends `request-viewport { paneId, offset }`. Server replies (and live-mode subscribers also receive unsolicited pushes on frame arrival) with `viewport { paneId, cols, rows, lines, cursor, modes, historySize, offset, atTail }`. `offset=0` = live edge (pane.read visible); `offset>0` = `recent` slice N rows above — capped at herdr's 1000-line read limit
- **Initial viewport**: Sent immediately on `subscribe` so mobile doesn't show a gray canvas while waiting for the first resize round-trip
- **Cursor / alt-screen**: Scanned from control-stream frames (trailing CUP + `?25h/l`, `1049h/l` transitions; initial alt state guessed from a non-shell foreground process with zero host scrollback)
- **Lazy controllers**: Read-only REST access (`hrdle peek`, viewport snapshots, previews) is pure RPC and never takes over a pane; control streams spawn on WS subscribe or first input
- **Scroll to live**: Tapping the terminal or showing the soft keyboard forces the client back to `offset=0`
- **Input**: Raw bytes (base64) over the pane's control stream — mouse SGR, bracketed paste, and escape sequences pass through intact; ordering guaranteed by the single stdin pipe

## CLI Commands

```bash
# Server
hrdle                    # Start server (port 5924)
hrdle -p 8080           # Custom port
hrdle -P password       # With password auth

# Management
hrdle setup -P pass     # Register systemd/launchd service
hrdle uninstall         # Remove service registration
hrdle update            # Update from GitHub Releases
hrdle update --check    # Check only (no update)
hrdle update --auto     # Auto-update mode (for timer)
hrdle status            # Show service status

# Hook notification
hrdle notify            # Send hook event (reads JSON from stdin)

# Remote pane control (target: <peer>:<session>:<paneId>, peer = 'local' | peer id | nickname)
hrdle send local:dev:%1 "ls"        # Send text to a pane
hrdle send local:dev:%1 --submit "fix the bug"  # Bracketed-paste + Enter (Claude/Codex TUI submit)
hrdle send local:dev:%1 --stdin     # Read payload from stdin (--base64 for binary-safe)
hrdle send local:dev:%1 --wait "y"  # Send, then snapshot viewport with detected state
                                    # (--wait-ms <n> delay, --lines <n> rows)
hrdle peek local:dev:%1             # Snapshot a pane viewport (--lines <n>, default 20)

# Speech vocabulary for the session this runs in (session auto-resolved: cwd, then
# /proc ancestry - same as `hrdle glasses`; --session <id> to name one)
hrdle stt-prompt "音声認識、語彙バイアス"   # Add words this session is about
hrdle stt-prompt --replace "音声認識"       # Replace the whole list
hrdle stt-prompt                           # Print what is set, and what is
                                           # actually sent (model, language,
                                           # prompt, how it was composed)
hrdle stt-prompt --clear                   # Back to the glossary alone
hrdle stt-prompt --no-glossary             # This workspace speaks none of this
                                           # product's words: drop the glossary
                                           # and take the whole budget
hrdle stt-prompt --glossary                # Take it again

# How the steward reaches its owner (#383). Every verb prints JSON, so it can
# read back what it wrote. Requires HRDLE_STEWARD=1 on the server.
hrdle steward notify "ビルドが通りました" --detail "3 files changed"
hrdle steward notify "テストが通りました" --session w5Q   # そのセッションの画面にも出る
hrdle steward ask "デプロイしますか" --choices "はい,いいえ" --step 1/2   # -> ask_id
hrdle steward report "3 セッションが止まっています" --file rows.txt      # 1 行 1 row
hrdle steward line w5Q "レビュー待ち 12分"   # the overview row for one session
hrdle steward turns w5Q --file turns.json   # append/amend that session's history
hrdle steward screen                        # what the glasses show right now

# The only way the steward touches a session. Runs against the *watched* herdr
# server (not its own), refuses anything that is not an agent pane, and
# journals every action. The three verbs are the boundary: answering a
# permission prompt, reaching a shell pane and killing an agent are absent by
# construction, and adding one decides what the steward is allowed to be.
# Panes are addressed by pane id (w5Q:p1). `herdr agent list` only carries a
# `name` for agents started through `herdr agent start` - 16 of 17 rows on a
# real server have none - so name addressing reached nothing a person runs. A
# workspace id works when it holds one agent and is refused when it holds
# several, rather than meaning whichever listed first.
hrdle steward-do watch                      # every agent, with state_change_seq
hrdle steward-do read <pane>                # what is on that pane
hrdle steward-do say <pane> "<text>"        # a further instruction
hrdle steward-do clear <pane>               # /clear (not reversible)
hrdle steward-do stop <pane>                # ESC
hrdle steward-do journal [n]                # what it has done

# Debugging (Bun inspector on the running service)
hrdle debug status      # Show inspector state
hrdle debug enable      # Enable inspector (port 9229)
hrdle debug disable     # Disable inspector
hrdle debug profile --seconds 30   # Enable for N seconds then auto-disable

# Help
hrdle --help
hrdle --version
```

### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port` | Port number | 5924 |
| `-H, --host` | Bind address | 0.0.0.0 |
| `-P, --password` | Auth password | none |

### Requirements

- Tailscale must be running (used for HTTPS certificates)
- Run `sudo tailscale set --operator=$USER` once to allow cert generation
- macOS: Install Tailscale via `brew install tailscale` (App Store version lacks CLI)
- herdr must be installed (`curl -fsSL https://herdr.dev/install.sh | sh` or `brew install herdr`); hrdle auto-starts `herdr server` if it isn't running, but a supervised setup (systemd user unit with `Restart=always` + `~/.config/herdr/config.toml` with `resume_agents_on_restore = true`) is strongly recommended so agent sessions survive server restarts
- For native session identity/restore, install the herdr integrations once: `herdr integration install claude` / `codex` / `kimi` (`hrdle setup` installs all initialized ones)

## Hook notifications from Claude Code / Codex / Grok / Kimi

Hook events from Claude Code, Codex, Grok Build and Kimi Code (a response
finished, an agent is waiting for input, and so on) reach the browser as OS
notifications through Hrdle.

Grok Build reads `~/.claude/settings.json`'s hooks by default through a
compatibility layer, so the `hrdle notify` entry written for Claude fires as it
is, with nothing extra to configure. Its stdin JSON is its own camelCase shape
though (`hookEventName: "stop"`, `sessionId`, `transcriptPath`), so `/api/notify`
normalizes it to Claude's (`normalizeHookBody` in `routes/notify.ts`).

Kimi Code is configured under `[[hooks]]` in `~/.kimi-code/config.toml` (for
example `event = "Stop"`, `command = "hrdle notify"`). Its stdin JSON is
Claude-compatible snake_case (`hook_event_name`, `session_id`, ...), so no
normalization is needed.

### How it works

```
Hook -> hrdle notify (stdin JSON) -> POST /api/notify -> WebSocket broadcast -> browser Notification API
                                                      \-> while the glasses are up: a relay info item -> the G2 screen
```

While the glasses app is present (a subscriber of `subscribe-glasses-relay`), a
notification goes to the G2 rather than the browser. `/api/notify` resolves the
herdr workspace/pane from the hook's `session_id` (the agent session id) or its
`cwd` (`resolveHookTarget`) and creates an `info` relay item with a 90-second TTL
(`postHookRelay`). `hook-event` carries `deliveredToGlasses: true` only when an
item actually landed, and the frontend skips `fireHookNotification` only when
that flag is set. With no glasses, an unresolvable session or a rate limit, the
flag stays down and the browser notification goes out as before (a duplicate
notification beats a lost one). Indicator updates always run regardless of the
flag.

While herdr reports `blocked` and a waiting item exists, no hook-derived info is
created (it would only say the same thing twice). Conversely, if a hook arrived
first, the hook-derived info (`source: 'auto'`) is removed once the waiting item
appears. An agent's own `hrdle glasses` note (`source: 'agent'`) is unrelated and
stays.

### Speech to text on the glasses

The G2's SDK only hands over raw PCM, so transcription happens on the server at
`POST /api/glasses/stt` (`routes/glasses.ts`) through Groq
`whisper-large-v3-turbo`. `GROQ_API_KEY` never leaves this host.

**One function resolves what is sent, and one endpoint reports it.**
`services/stt-request.ts`'s `resolveSttRequest({ sessionId, lang })` returns the
whole request - model, language, prompt, each value's source, and for the prompt
which group produced which term and where the budget cut - and
`GET /api/glasses/stt-preview?session=&lang=` serves exactly that object. The
route calls it once and packs the result into the `FormData`; it decides
nothing. Split across several functions with a precedence rule each, "what is
this session sending" can only be answered by reading all of them, and the
answer comes out confidently wrong. The Groq key is deliberately **not** in
there: it is write-only, and a preview carrying it would be the way it came back
out.

`services/stt-prompt.ts` composes the vocabulary-biasing `prompt`. Its order is
**the speaking session's own words, then the glossary**, filled up to what fits
Whisper's 224-token ceiling (190 characters) - and the session may take **no
more than half of it**, so the glossary is there whatever else is set.

**A new workspace takes a copy of the glossary and stops sharing it.** From
creation its vocabulary is one list it owns, so terms it will never say can be
deleted - which a shared layer cannot offer. Workspaces that already existed
keep taking the shared glossary at composition time; **one of them can decline
it wholesale** (`hrdle stt-prompt --no-glossary`, stored beside its theme), and
then its own words take the whole 190. The glossary is the words *this product* is made of, so a workspace about
cooking or bookkeeping cannot spend the half held for it: measured on the
health-and-cooking workspace, 18 of its own terms filled 90 of the 95 it was
allowed while 96 characters went to nineteen development terms that are never
spoken there. The half-budget reservation exists to stop one group filling the
line; a workspace sharing with nothing has no second group to protect, so the
reservation lifts with the glossary.

A term added to the glossary on new evidence therefore reaches **new**
workspaces only. That is the trade the copy is for: the curation loop is worth
less than a workspace being able to prune, and a workspace that wants the
current list can take it with `--replace`.

**Writes add rather than replace** (`--replace` to swap the list). A vocabulary
is a list that grows, and a caller that meant to add one word and replaced the
list instead loses the rest with nothing in a transcription to show it. Nothing
is truncated to fit either: an add that would overflow 190 characters writes
nothing and says what it would have been, because a list cut down invisibly is
the failure this area keeps producing.
`HRDLE_STT_PROMPT=off` disables the bias entirely, and any other value replaces
the whole line (for A/B testing; the variable name is composed by `envVar()`
from `binaryName` in `identity.json`). A switch on the settings screen
(`sttBias`) disables it too, which is the same decision made by someone wearing
the glasses rather than someone with a shell.

There is no third group between the two, and adding one has no job to do: a word
that gets said belongs in the glossary, and a word about to be said is the
session's to write. A `glasses-settings.json` may still carry a free-text
vocabulary field of that shape - an `off` in it reads as the `sttBias` switch's
"disabled", and any other words in it are dropped.

The first group is per session: `?session=<workspace id>` on the STT
request names who is speaking, and `PUT /api/sessions/:id/stt-prompt` stores a
short phrase against that session in `SessionMetadataService`, beside its theme.
The glasses send it from `voiceTarget.sessionId`, which is the workspace the
reply is going to. **The agent in the session can write it itself** - `hrdle
stt-prompt "音声認識、ハルシネーション"` resolves which session it is running in
the same way `hrdle glasses` does (`commands/session-target.ts`) - which is the
point: what is about to be said is known in the session, and not anywhere else.

**Workspace names are not in the prompt, and do not put them back.** A label
looks like a coinage nothing else can supply (「2脚ロボ開発」), but it is not a
name: the naming convention appends a status suffix (`— 作業中`, `— 完了済`) and
agents write the reason for an interruption into parentheses, so a label is a
sentence written for a person reading a list. Thirteen of them spend 189 of the
190 characters, which leaves `タブ` as the only glossary term that fits while
`リリース`, `コミット`, `リベース` and `ペイン` - the words actually reported as
misheard - are all pushed out. The half-the-budget cap is what stops the
session's own group doing the same.

The key, the language, the model and that switch are settings, editable from the
glasses app's own web screens (the phone companion UI and the simulator) and
stored by `services/glasses-settings.ts` in `<dataDir>/glasses-settings.json`
(0600, since it can hold a key):

| | Precedence | Notes |
|---|---|---|
| Groq key | setting, then `GROQ_API_KEY` | Write-only through the API - `GET /api/glasses/settings` reports only whether one is set and where it came from. **Sent to Groq and to nothing else**: a custom endpoint has its own `sttEndpointKey`, because a key belongs to one destination and a URL somebody typed must not receive this one |
| Language | `?lang=` on the request, then the setting, then `ja` | `auto` sends no language at all and lets Whisper detect it. The glossary is Japanese, so a prompt of its own is what makes another language work properly |
| Model | setting, then `whisper-large-v3-turbo` | A closed set (`STT_MODELS` in `shared/types.ts`) - an unknown model is a 400 on every utterance and the wearer sees only "STT provider error" |
| Vocabulary bias | `HRDLE_STT_PROMPT=off` or the `sttBias` switch turns it off; `HRDLE_STT_PROMPT` set to anything else replaces the line; otherwise composed | The env var replaces and the switch disables, and nothing a screen saves does either: a field reachable from the device must not be able to silently disable everything else. The env var can switch the bias off but the screen cannot switch *that* back on, and says so |

**`GET /api/glasses/settings` reports what is stored, never what would be
sent.** It has no session, so it never could, and a field on it that looks like
the sent prompt only buys a per-session bug that does not exist.
`/stt-preview` is the endpoint that answers, and `hrdle stt-prompt` with no
arguments prints the same object in the terminal.

**Every transcription is written into the screen recording, with what produced
it.** `recordSttRequest` (`glasses-screen-recorder.ts`) appends an `stt` line -
model, language, the prompt as sent and where it came from, the session, the
audio length, the text, and the raw text when `stt-corrections` changed it -
just before the `[confirm]` frame that shows the result. This is the whole of
the measurement: the audio is not stored, so a model or a prompt can only be
judged by reading transcripts back, and until this a transcript did not say
which model wrote it. Comparing `whisper-large-v3` against turbo therefore
rested on remembering when the setting was last changed, which is not a
measurement. The line is off with the recording (`HRDLE_GLASSES_RECORD`), and
it is a fifth shape in `RecordedGlassesLine` - the replay player decides what
to paint by ruling the event shapes out, so a new one must be named in
`isFrame` or it gets painted as nonsense.

The settings screen ships in the ehpk, so **the phone companion UI only gains it
after `/glasses-upload`**. The simulator the server serves at `/glasses` updates
with the server itself.

Note that **silence and very short clips produce hallucinations** (a stock
sign-off phrase, typically). The prompt does not remove them, so a length and
volume floor is needed separately.

### Setup

1. For Claude Code, add `hrdle notify` to `hooks` in `~/.claude/settings.json`.
   For Codex, add it to `~/.codex/hooks.json` (Codex warns when it is configured
   in `config.toml` as well, so `hrdle setup` migrates an existing Hrdle hook
   into the JSON):

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "hrdle notify" }] }],
    "PostToolUse": [{
      "matcher": "AskUserQuestion",
      "hooks": [{ "type": "command", "command": "hrdle notify" }]
    }]
  }
}
```

`PreToolUse` and `UserPromptSubmit` are not needed. The
indicator's state transitions come from herdr's `pane.agent_status_changed`, so a
hook only carries what herdr does not have: the notification body and the
question's tool name. Leaving them registered does no harm.

2. Make sure the `hrdle` binary is on PATH (hooks run from the Claude Code /
   Codex process). A hook runs in a **non-interactive shell**, so `.zshrc` is not
   read: a setup that adds `~/bin` or `~/.local/bin` to PATH from `.zshrc` cannot
   resolve the bare name and fails with `command not found`. Write the
   absolute path there instead (`/home/you/bin/hrdle notify`). Where hrdle writes
   the command itself (`migrateCodexHooksToJson`, the hook setup prompt in the
   UI), it uses the resolved path from `resolveNotifyCommand()`
   (`services/notify-command.ts`).

3. The Hrdle server must be running on the default port (5924). For a custom
   port, pass `hrdle notify -p <port>`.

4. Allow notification permission in the browser on first visit.

### Events

| Hook event | Notification |
|-------------|-------------|
| `Stop` | Response complete |
| `PostToolUse` (AskUserQuestion) | Waiting for your input |
| `SubagentStop` | Subagent finished |
| `TaskCompleted` | Task complete |
| anything else | Hook: {event name} |

### Notes

- `hrdle notify` reads the Claude Code / Codex hook JSON from stdin
- `/api/notify` is unauthenticated (local hooks call into it)
- It coexists with existing hook scripts (several hooks can be registered for one
  event)
- Several WebSocket connections still produce one notification, thanks to the
  debounce
- The glasses only show notifications from the one Hrdle they are connected to,
  so `deliveredToGlasses` is set only by the server where the event happened. A
  peer's notification appears in the browser as before unless glasses are
  connected to that peer

## Internationalization (i18n)

Hrdle supports English and Japanese. Language is automatically detected.

### Frontend (Web UI)

Uses `react-i18next` with browser language detection:
- Translation files: `frontend/src/i18n/locales/{en,ja}.json`
- Language switcher in UI (EN/JA button)
- Preference saved to `localStorage` (`hrdle-language`)

### Backend (CLI)

Uses custom i18n module with embedded translations:
- Module: `backend/src/i18n/index.ts`
- Language detected from environment variables: `LANG`, `LC_ALL`, `LC_MESSAGES`
- Japanese locale (`ja_*`) → Japanese, otherwise English

### Glasses app

`glasses/src/i18n.ts` — a lookup, a language and a way to change it, rather than
react-i18next (nothing there is React and the ehpk pays for every kilobyte).
Language comes from a saved choice, then `navigator.languages`, then English.

It carries only what could not move to hrdle-setup: the voice-input settings
panel, which the browser simulator also renders, and the errors from reading a QR
code, which happens on the device because the camera does. The tests assert both
tables carry the same keys — `t()` falls back to English, so a missing key does
not break a screen, it produces one sentence in the wrong language, which is
exactly the kind of thing nobody notices.

**What the G2 itself draws stays English.** Japanese is full-width, so the line
widths in `metrics.ts` and the seven-line clamp would all have to be re-reckoned;
that is its own piece of work rather than a translation.

## Type Sharing

Types are defined in `shared/types.ts` with Zod schemas for validation. Import from `../../../shared/types` in both backend and frontend.

Key types: `ControlClientMessage`, `ControlServerMessage` (per-session terminal I/O), `MuxClientMessage`, `MuxServerMessage` (multiplexed WebSocket protocol), `PaneViewport` / `PaneCursor` / `PaneModes` (viewport frames), `SessionResponse`, `PaneInfo`, `TabInfo` (a workspace's tabs; `SessionResponse.tabs`/`activeTabId`, only when >1 tab), `TmuxLayoutNode`.

## What Hrdle is next to

Written down because it is easy to get wrong by assuming rather than looking.
Anyone about to describe this product
— a README, a store listing, the setup guide — should read this first.

The agents are not the competition. Claude Code, Codex, Grok, Kimi and OpenCode are the
things being run. The competition is:

| | What it is | Where it wins |
|---|---|---|
| **Even Terminal** (`@evenrealities/even-terminal`, "Terminal Mode") | Even Realities' own. Spawns **one** agent, renders it to the G2, turns R1 gestures into keystrokes. QR pairing, Tailscale recommended. macOS/Linux/Windows | One agent on your glasses. One `npm install -g`, no herdr. Made by the people who made the glasses. Its own readme: "a renderer + input bridge, not a runtime" |
| **cmux** (cmux.com) | Native macOS terminal for running agents in parallel: tabs, split panes, embedded browser, socket API — **and an iPhone app that mirrors the terminals** | Sitting at a Mac, watching several agents. Also does remote (SSH, attach to tmux) |
| **herdr on its own** | Everything Hrdle knows about sessions | Any terminal. No extra layer to install |

So three things that read like differentiators are **not**:

- *"Sessions are yours to control"* — that is herdr's, and a Hrdle session **is**
  a herdr pane
- *"See your agents on your glasses"* — Even ship that themselves
- *"Reach it from your phone"* — cmux has an iPhone app

What is left, and is true: **you need never open a computer again.** Not to watch
a session — to *start* one. `even-terminal` spawns its agent in the directory it
was launched from, so the work begins at that keyboard; cmux is a window onto the
Mac you are at. Both watch work begun at a desk. Hrdle starts it without one: a
new session from the phone (name, directory, agent, machine — the create modal in
`WorkspaceList.tsx`), spoken instructions, answers from the glasses. Several
sessions, across several machines.

Voice is the main input, not an extra. The ring wins only when the agent has
already narrowed the answer to two — which makes a Groq key part of setup rather
than an optional afterthought.

## Where the setup wizard lives

**Not in this repository.** It is [hrdle/hrdle-setup](https://github.com/hrdle/hrdle-setup),
served from Cloudflare Workers, and the glasses app frames it in an iframe.
Do not "fix the wording" in `glasses/src` — there is none there to fix.

**A push to that repository's `main` is the deploy** — Cloudflare builds and
publishes it, and there is nothing to run afterwards. Its `bun run deploy` is
the other path, for a change that must not be on `main` first, and it needs a
`CLOUDFLARE_API_TOKEN` the automatic build does not. Said here because the
change that reaches for it is usually one made *here*: a server response the
guide's mirrored settings panel reads, where the merge over there looks like
half a job and is not.

`phone-ui.ts` is a frame plus answers to three postMessage requests, and the
boundary is not a preference:

- **The store.** `startGlassesMode` reads the server address from the *host's*
  store when the app starts on the G2. Another origin's `localStorage` does not
  exist as far as the glasses are concerned
- **The camera.** The QR scan is `captureImageFromCamera`
- **Every request to the server.** The guide was going to call the API directly —
  the server does answer `Access-Control-Allow-Origin: *`. **Private Network
  Access stops it**: the guide is public-origin, a tailnet address is inside
  CGNAT space, and Chrome refuses that crossing whatever CORS says. Measured:
  from `hrdle-setup.*.workers.dev`, `api.github.com` returns 200 and a `.ts.net`
  host fails to reach the network at all

There is no offline copy of the guide, deliberately: the setup it describes ends
in reaching a server over a tailnet, so a phone with no internet cannot finish it
anyway, and a second copy of seven screens is a second copy to keep correct.

The two repositories' `i18n.ts` files carry the same keys and sentences on
purpose. Change one, change the other. `hrdle-setup/src/identity.ts` mirrors
`identity.json` for the same reason `install.sh` does — it cannot read the file.

## The icon

`frontend/public/favicon.svg` is the source of truth for its geometry, and its
own comment says what it is: *a scanner mid-sweep. 11 segments / lamp at 0.33
(left of center) / band folded by S*0.028*. A Knight Industries nose. The still
mark is one frame of something moving, which is why an animated version sweeps
rather than pulses.

Port those numbers; do not redraw it by eye. `glasses/src/brand.ts` computes
every lamp from that geometry and was checked against the source — all seven red
lamps and all three white cores agree to within 0.007 units of 512. Each lamp
carries its source opacity as an SVG presentation attribute so a stopped
animation falls back to the artwork as drawn rather than to something flat.

## Rules for working on the glasses app (`glasses/`)

### What the phone app's WebView will not do

Measured on device, against an Android 16 phone with the app holding camera
permission at the OS level. The WebView is
**flutter_inappwebview** (it announces itself in `globalThis`), and it refuses
web content three ways:

| Asked for | What happens |
|---|---|
| `getUserMedia` | `NotAllowedError` while `permissions.query` still reads `prompt` — denied *without being asked*, which is what an unimplemented `onPermissionRequest` looks like |
| `<input type=file capture>` | `click()` returns, nothing opens, and 15s later the page has not even been backgrounded. No `change`, no `cancel`. `onShowFileChooser` unimplemented |
| `clipboard.readText()` | `NotAllowedError: Read permission denied` |

All three are the host app's unimplemented callbacks. Nothing on this side fixes
them, and `camera` in `app.json` does not help: it grants the SDK's
`captureImageFromCamera()`, not the WebView. Reinstalling the plugin changed
nothing, which is what ruled out "the permission was never granted".

So **the setup screen asks for a short address instead of scanning anything**
(`resolve-host.ts` → `services/discovery.ts`). What the WebView does do is
accept typing, so the job was making the typing short: nine characters rather
than forty-three.

**There is no QR scanner, and writing one back is not the fix.** Code with no
route to it costs more than the day the host might implement
`onPermissionRequest` is worth: modules, a jsQR dependency, blocks of translated
strings and — the expensive part — a story told across the app, the setup site
and the installer about a code that nothing can read. `hrdle address` prints two
lines of text instead of drawing anything (`hrdle qr` is accepted as an alias).

A decoder (BarcodeDetector first, then jsQR over the full frame, a centre crop
and native resolution — a 150px code in a 4000x3000 photo reads from the crop
and fails everything else) and `camera-probe.ts`, the screen that produced the
table above, are in the git history. If the platform ever changes, recover that
commit before re-testing any of this rather than starting the investigation
over.

### What `app.json` asks for

Two permissions, and the list is derived from the SDK calls rather than from
what the app looks like it might want:

| | Why |
|---|---|
| `network` | Every request to the server, and the guide iframe |
| `g2-microphone` | `audioControl(true, AudioInputSource.Glasses)` in `display.ts` |

**`camera` is not one of them, and declaring it buys nothing.** It grants the
SDK's `captureImageFromCamera()`, which **nothing in `glasses/src` calls** — web
content reaching for `getUserMedia` or `<input capture>` is reaching for web
APIs the manifest has no say over (the table above). Declaring it asks a user to
grant a camera that cannot then be opened. If the host ever implements
`onPermissionRequest` and a scanner is wired up again, it still will not be
needed; `captureImageFromCamera()` would be.

The valid names are fixed by the packer, not by us —
`["g2-microphone", "phone-microphone", "album", "location", "network", "camera"]`
in `evenhub-cli`'s schema, each with a `desc` of 1 to 300 characters. `desc` is
shown to the user when the permission is asked for, so it is prose for an
audience that is not us: same rule as the changelog.

### The simulator

**The simulator is part of the implementation, not a bonus. Fixing only the
device does not count as done.**

The browser simulator in `src/debug-ui.ts` goes through the same
`GlassesController` **and the same `updateDisplay()`** the device does: it
supplies a bridge that records containers rather than sending them to a host,
and the canvas paints what that bridge holds. So the rebuild-vs-upgrade
decision, the skip-if-unchanged record, which container id a string is addressed
to, and every container's geometry are decided once, in `display.ts`, for both.

A second implementation of where those strings go - the simulator laying the
screen out itself from `screenText()` - is what produces the divergences that
cost real debugging time: character widths off by one, paging repeating the
previous line on the device only, tofu on the device only, a recap missing in
the simulator only, a notice strip 36px from where the device drew it.

What is still **not** shared is the glyphs themselves: this window draws with a
browser font at the firmware's own advances, so a character the panel has no
glyph for can still appear here. `stripUnrenderable()` catches those it can
measure. So the order remains **check on the simulator, release, check on the
device**, and the simulator alone is never the finish line.

While implementing:

- When you add a platform capability, **implement it on both the device
  (`main.ts`) and the simulator (`debug-ui.ts`)**. The shared surface is
  `GlassesPlatform` in `controller.ts`. Doing one side is how you manufacture a
  symptom that only reproduces on the device
- Wording belongs in `screenText()` and layout in the `build*()` container
  definitions, both in `display.ts`. Written straight into a renderer, they
  appear on one side only - and a position recomputed in `debug-ui.ts` is a copy
  of one in `display.ts` that will drift without either side noticing
- To show a symbol, add a substitute to `SUBSTITUTES` in `metrics.ts` (preserving
  the meaning, as a check mark becomes a circle). Anything without one is dropped
  by `stripUnrenderable()`, which also runs in the simulator
- localStorage goes through `storage.ts` (keys derive from `storagePrefix` in
  `identity.json`, and older keys are consulted only when reading). The product
  name, port and repository come through `define` in `vite.config.ts` - no
  literals in `glasses/src`

The simulator:

```
https://<host>:5924/glasses          # served by production
https://<host>:5924/glasses?player   # screen-mirror recording replay player
bun run --filter glasses dev         # vite dev -> :8391
```

The replay player is its own page on purpose — its first version lived in the
simulator's side panel, a whole screen away from the panel it was driving. It
shares the simulator's canvas painter (`panel-paint.ts`), so a replayed frame
wraps and clamps exactly as the wearer saw it.

`?hub=<url>` points at another server and `?bg=<image URL>` replaces the
background. **The microphone is real** - it calls `getUserMedia` and hits
`/api/glasses/stt` (Groq) for real, so verifying speech recognition needs no
glasses. Typing into the "STT result" field short-circuits the transcription.

There are three ways to capture the screen and **they show different things**, so
pick deliberately rather than settling for one:

| How | What it tells you |
|---|---|
| **"Copy screen"** (framed text) | Wrapping, line count, clipped characters. Diffable, pasteable into an issue, cheap |
| **`agent-browser screenshot "#lens" <path>`** | Reflections, how it sits against the background, real legibility. **Text cannot answer this in principle** |
| **The "Save PNG" button** | **For submitting to the EVEN Hub store**. A transparent PNG with no background (576x288) |

The second exists because the G2 is a see-through display. Green text over a
bright wall or a screen becomes unreadable, and text-only capture can only ever
tell you it was drawn.

The third has a different purpose. **The EVEN Hub store listing brings its own
background**: choosing an Environment (Home / Office / Store / Cafe) composites
our drawing onto a photo of that room. A submitted image must therefore be the
drawing and nothing else, which rules out `screenshot "#lens"` - it bakes in the
simulator's background. `#g2-canvas` is already 576x288 with a transparent
background and lit pixels in green across 16 alpha levels, so the button saves
rather than converts. The file name carries the mode
(`hrdle-glasses-conversation-....png`).

To use the microphone headlessly, substitute `getUserMedia` (without it
`startMicCapture` fails and the screen jumps straight to "(nothing was
recognized)"):

```js
navigator.mediaDevices.getUserMedia = async () => {
  const ctx = new AudioContext(); const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator(); osc.connect(dest); osc.start(); return dest.stream;
};
```

A change confined to the server (`backend/`) needs no ehpk rebuild - STT and
relay behavior live there. Building and uploading to EVEN Hub is the
`/glasses-upload` skill.

### Put the behavior on the server, not in the app

An app change costs a build and a store review, so **anything that could differ
between agents, or change when one of them redraws something, belongs on the
server and travels on the item**. The app is left with the parts only it can
know - what is on its screen, what the wearer just did, whether someone is
mid-utterance.

This has been paid for more than once. `present` moved the "does this deserve
the screen" rule out of the app after a question sat behind a banner for ten
minutes. `choiceKeys` moved "which key answers this row" out after grok turned
out to write its own, and now carries the arrow walk that reaches claude's
multi-select text field. `choiceFieldRows` says which rows are a field rather
than letting the app infer it from a label's shape.

When a fix seems to need app logic, look for the version of it that is a field
on `GlassesRelayItem` and a reader on this side. Reach for an ehpk rebuild only
for what is genuinely about the screen or the gesture - and when one is
unavoidable, spend it on making the *next* one unnecessary.

## Linting

Uses [Biome](https://biomejs.dev/) for linting. Configuration in `biome.json` at project root.

- a11y rules (`useButtonType`, `noSvgWithoutTitle`, etc.) set to `"warn"` — not blocking CI
- Biome 2.x config format: `{ "level": "warn" }` (NOT just `"warn"`)
- Run `bun run lint` to check all packages

## Debugging

### Remote Logging

Frontend `console.log/warn/error/info` calls are automatically sent to the backend via `/api/logs`. Logs are written to `/tmp/hrdle-browser.log`.

This enables debugging on mobile/tablet devices without access to browser DevTools. Use `tail -f /tmp/hrdle-browser.log` to monitor frontend logs in real-time (also exposed via `GET /api/logs`).

### herdr Server State

If all terminals show "Connecting..." / "Session exited", check the herdr server first:

```bash
herdr status server                 # running? protocol version?
systemctl --user status herdr      # if supervised via systemd
```

hrdle auto-starts `herdr server` at boot when the socket (`~/.config/herdr/herdr.sock`, or `$HERDR_SOCKET_PATH`) is unreachable. herdr's own log lives at `~/.config/herdr/herdr-server.log`. Sessions (workspaces) live in the herdr server process — restarting hrdle never kills them; restarting herdr restores workspaces from `session.json` and, with `resume_agents_on_restore`, resumes agent conversations natively.

### Never test against the default herdr server

The default server is the one the user is working in. Their sessions are on it,
and one of them is usually the session doing the testing. **A dev server started
for a test gets its own named herdr session:**

```bash
herdr --session <name> server &                       # own dir, own session.json, own socket
export HERDR_SOCKET_PATH=~/.config/herdr/sessions/<name>/herdr.sock
herdr workspace create --cwd <dir> --label "<test>" --no-focus
(cd backend && HERDR_SOCKET_PATH=$HERDR_SOCKET_PATH bun run src/index.ts -p 3457)
herdr --session <name> server stop                    # and close its workspaces when done
```

`--session <name>` is the only thing that isolates state. It gives
`~/.config/herdr/sessions/<name>/` — its own socket **and its own
`session.json`**. Everything else that looks like it would:

- **`HERDR_SOCKET_PATH` alone does not.** It moves the socket; the state
  directory still follows `$HOME`, so a second server restores the *user's*
  workspaces and two processes then own one `session.json`
- **`HERDR_CONFIG_PATH` does not either** — it overrides `config.toml` and
  nothing else. Measured: a server started with both pointed at a scratch
  directory comes up holding every one of the user's workspaces
- A socket path is capped by `sun_path` (104 bytes). A scratchpad path is
  already longer than that, which is a hint that the socket does not belong
  there

Two more things a test on the default server gets wrong:

- **`pane.split` ignores the `pane_id` it is given and splits the focused
  pane** — which is the user's, not the test's. Drive a test pane through
  `hrdle send` / `hrdle peek` with an explicit `<peer>:<session>:<paneId>`
  target, which does route where it says
- **The dev server shares hrdle's own data directory** with production, so
  `SessionMetadataService` hands it the user's remembered sessions and they
  appear in `GET /api/sessions` with `panes: null`. Harmless to read, but do
  not mistake them for the test's own, and do not write session metadata from a
  test run

### A test server started by hand loses its agents' transcripts

Claude Code sets `CLAUDE_CODE_CHILD_SESSION=1` on its children, so an hrdle
started from an agent's shell propagates the marker down to the agents in its
own panes:

```
me (Claude Code)  CLAUDE_CODE_CHILD_SESSION=1
      | starting hrdle by hand from here
hrdle -> herdr(hrdle) -> pane -> claude
                                  \- judged a "child session" -> transcript saving OFF
```

The pane says `Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
marker`, and nothing else does. The conversation works normally, so the damage
surfaces only when a restart tries to restore it and
`claude --resume <id>` answers `No conversation found with session ID`:
`resume_agents_on_restore` does its job against a log that was never written.

Started through the systemd unit the environment is clean, so **test through the
service** when the thing under test is session restore. Unset the marker
otherwise.

### Run `bun install` in a new worktree

The working directories are `git worktree`s sharing one `.git`, and
`node_modules` is not shared. Without it `hono` fails to resolve and a pile of
backend tests fail in a way indistinguishable from real damage.

### Tests must take the data directory from `IDENTITY`

Tests that escape their writes to a temp directory do it by setting the data
directory env var, and a literal there (`process.env.HRDLE_DATA_DIR = tempDir`)
silently stops matching if the identity changes — the line then sets nothing and
the test writes into the **real** data directory. That shows up as
contamination, not as failure, so a green suite hides it. Go through
`IDENTITY.dataDirEnv`.
