# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Codex and other coding agents should use this file as the single source of repository guidance; `AGENTS.md` only points here.

## Project Overview

Hrdle is a web-based terminal session manager for coding agents — Claude Code, Codex, Grok and Kimi. It runs them in herdr workspaces and provides a web UI for remote access from tablets/mobile devices.

Formerly CC Hub, renamed in #459: the old name said Claude Code, which stopped being the whole story once the other agents arrived. `m0a/cc-hub` is archived at v0.2.98 and this repository carries development forward. The rename lives in `identity.json` — everything composed from it (service units, data directory, scratch paths, hook command, storage keys) follows without a call site changing.

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

## Commands

```bash
# Development (starts both backend and frontend)
bun run dev

# Individual services
bun run dev:backend   # Backend only (port 3457)
bun run dev:frontend  # Frontend only (port 5174)

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
- **HerdrService** (`services/herdr.ts`) - Session-level operations mapping Hrdle sessions onto herdr workspaces: list (with agent detection from `pane.process_info`, native agent session ids from `agent.list`, `blocked` status), create/kill, previews, and `moveSession` — herdr's workspace order **is** the session display order, so a reorder is a `workspace.move` and nothing is stored on the hrdle side
- **HerdrUpdateService** (`services/herdr-update.ts`) - Detects herdr binary-vs-server version skew (`herdr update` swaps the binary but leaves the running server old) by parsing `herdr status --json`, cached 30s and refreshed off the dashboard poll. Reports only — applying (`herdr update` + supervised restart) is an explicit user action via `POST /api/herdr/apply-update`; never the `hrdle update --auto` timer, never `--handoff`. Unreadable status degrades to no warning
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
- **GroqSttUsageService** (`services/groq-stt-usage.ts`) - Groq speech-to-text consumption by the glasses, **recorded rather than aggregated**: Groq has no usage endpoint and reports remaining quota only in `x-ratelimit-*` headers on a transcription response, so a request not written down as it happened is unrecoverable. `routes/glasses.ts` records on the way past (before the status is acted on - a 429 still spends quota - and without awaiting it), into `<dataDir>/groq-stt-usage.json`. Tracks requests (capped per day) and audio seconds (capped per hour, and what the API is priced on) separately, because the two ceilings empty on different clocks. Cost is an estimate at the list price per hour of audio, never a billed figure
- **OpenRouterPricingService / OpenRouterAccountService** (`services/openrouter.ts`) - Pay-as-you-go cost reporting: list prices from the public `/api/v1/models` (no auth, 24h cache) drive *estimated* per-window costs, while `/api/v1/key` + `/api/v1/credits` (keyed, 60s cache, 5min failure backoff) report OpenRouter's *billed* daily/weekly/monthly spend and credit balance. Estimates use rolling windows, OpenRouter's are calendar windows, so the two never match exactly
- **ConversationWatcher** (`services/conversation-watcher.ts`) - Watches Claude Code / Codex `.jsonl` files and emits conversation updates to subscribed WebSocket clients
- **HookStatusService** (`services/hook-status.ts`) - Reports whether the hooks Hrdle still needs are installed (`Stop` for notification text, `PostToolUse`/`AskUserQuestion` for the question's tool name). Indicator transitions come from herdr, not hooks
- **HerdrAgentStatusWatcher** (`services/herdr-agent-status.ts`) - Subscribes to herdr's per-pane `pane.agent_status_changed` (plus pane lifecycle events, which re-subscribe the pane set) and triggers an immediate sessions push. Decides *when* to rebuild the list, never what's in it — a dropped event costs latency, not correctness
- **AuthService** (`services/auth.ts`) - Password-based authentication with session tokens
- **PeerRegistry** (`services/peer-registry.ts`) - Persists peer server metadata to `peers.json` (with mutation locking), records per-peer success/failure state
- **PeerAuth** (`services/peer-auth.ts`) - Proxy login to peer servers (`POST /api/auth/login`), stores JWT tokens for subsequent API/WS calls, marks peers `unauthorized` on 401
- **PeerDiscovery** (`services/peer-discovery.ts`) - Scans the Tailscale tailnet (`tailscale status --json`) and probes each peer's `/health` in parallel to find running Hrdle instances. The probe port was a literal 5923 from before the rename, so for months it found nothing on a tailnet full of installs (#459, fixed in 0.3.28); it composes the port from `IDENTITY.defaultPort` now
- **Discovery** (`services/discovery.ts`) - One plaintext endpoint, `GET /whoami`, on `port + 1`, answering with the server's Tailscale FQDN, product name and version and nothing else. It exists so a phone can be told `91.210.90` instead of `https://beelink-arch.tail4459c9.ts.net:5924` — **plaintext is the requirement, not a shortcut**: the certificate is issued for the FQDN, so reaching the machine by IP or short hostname fails TLS, and `fetch` has no way past a certificate error the way a browser's warning page does. One unverified request buys the name; everything after it is ordinary verified HTTPS, and a tailnet caller's packets are inside WireGuard regardless. Only callers on a private or CGNAT address get an answer. `100.` is the only part of a Tailscale address that can be dropped — the second octet onwards is allocated per node, not per tailnet
- **PeerUrl** (`services/peer-url.ts`) - SSRF guard for peer URLs (#235): only allows Tailscale hosts (`*.ts.net`, CGNAT `100.64.0.0/10`, ULA `fd7a:115c:a1e0::/48`)

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

**Terminal WebSocket** (`/ws/mux`):
- Multiplexed WebSocket — single connection serves all sessions
- Client subscribes/unsubscribes per session via JSON messages
- Client messages (`MuxClientMessage`): `subscribe`, `unsubscribe`, `subscribe-conversation`, `unsubscribe-conversation`, then per-session (`ControlClientMessage`): `input`, `resize`, `split`, `close-pane`, `resize-pane`, `select-pane`, `adjust-pane`, `equalize-panes`, `zoom-pane`, `request-viewport`, `select-tab`, `create-tab`, `close-tab`, `ping`, `client-info`
- Server messages (`MuxServerMessage`): `subscribed`, `unsubscribed`, `sessions-updated`, `conversation-subscribed`, `conversation-unsubscribed`, `initial-conversation`, `conversation-update`, then per-session (`ControlServerMessage`): `layout`, `viewport`, `ready`, `pong`, `error`, `hook-event`
- Server periodically pushes `sessions-updated` (5s interval) with full session list

**Other**:
- `GET /api/dashboard` - Dashboard data (usage limits, statistics, cost estimates, system metrics, usage history, herdr version skew)
- `POST /api/herdr/apply-update` - Apply a pending herdr update (`herdr update` + supervised restart). User-initiated only; restarts every pane PTY
- `POST /api/upload/image` - Upload image file
- `POST /api/notify` - Receive hook events from Claude Code / Codex
- `GET /api/notify/hook-status` - Per-session hook indicator state (lists sessions with missing hook setup)
- `POST /api/auth/login` - Login
- `GET /api/auth/required` - Whether password auth is enabled
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user
- `POST /api/logs` - Frontend log submission / `GET /api/logs` - Read logs / `DELETE /api/logs` - Clear logs

### Frontend Components

**Layout**:
- **DesktopLayout.tsx** - Main layout with herdr control mode integration, pane tree management, keyboard shortcuts. Supports desktop and tablet modes
- **PaneContainer.tsx** - Tree-based pane renderer with `ControlModeContext` for pane operations (split, close, zoom, resize)
- **SessionModal.tsx** - Session picker modal (Ctrl+B) with pane count badges and expandable pane list

**Terminal**:
- **Terminal.tsx** - xterm.js terminal with WebGL rendering, **`scrollback: 0`** (server-side scrollback). `ControlModeConfig` for pane size sync (`proposeDimensions()` instead of `fit()`, `setExactSize()` from the layout) and viewport delivery (`registerOnViewport`, `scrollBy`, `scrollToLive`). Each new viewport is converted to a VT escape sequence (`viewport-render.ts`) and `term.write()`-ed to refresh the screen. Supports font size adjustment, desktop text selection with auto-copy, touch selection mode for mobile/tablet
- **SelectionOverlay.tsx** - Touch-selection overlay rendered above the terminal: draggable start/end handles, copy/cancel controls, computed from xterm `_core` cell metrics
- **viewport-render.ts** (`utils/viewport-render.ts`) - Converts a `PaneViewport` into a VT sequence (`\x1b[?25l` + per-row `\x1b[r;1H\x1b[2K<line>` + cursor restore) that xterm.js can apply with a single `term.write()`

**Session Management**:
- **SessionList.tsx** - Full session list with tabs (Active/History/Dashboard), pane list with focus/close/split actions, pinch-to-zoom support
- **SessionHistory.tsx** - Past session browser with project grouping
- **ConversationViewer.tsx** - The transcript, read-only, laid out after the Claude app: the user's turns as bubbles on the right, the agent's as a full-width column, on a warm neutral surface of its own (`--color-conv-*` in `index.css`, not the session's terminal color). A tool call and its result render as **one** collapsed card - the transcript stores them a message apart (call on the assistant turn, result on the user turn after it), so `buildRows` pairs them by `toolUseId` and drops the result-only message that used to appear as a "System" speaker saying the output of something two screens up. Consecutive turns from one speaker are labelled once. Code is syntax-highlighted through highlight.js (already in the bundle for the file viewer), but **not** with one of its themes - the `hljs-*` classes are re-coloured against the conversation palette under `.cv-code` in `index.css`, because every shipped theme is a different room's lighting and all the dark ones are cold. A fence names its own language; a tool result never does, so it borrows the language of the file the call named - and only when the output has line breaks, since a one-line result is a status message rather than a listing

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
- **ChatView.tsx** - Conversation-style view of the current session, replacing the terminal area when "Chat" mode is selected. **Read-only**: there is no composer, and chat mode no longer raises the soft keyboard. Two places to type into one pane only made it ambiguous which one was listening, and the answer was never the one on screen

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
- **useSessions.ts** - Active sessions state management
- **useSessionHistory.ts** - Session history browsing
- **useDashboard.ts** - Dashboard data fetching
- **useFileViewer.ts** - File viewing state
- **useAuth.ts** - Authentication state management
- **useTheme.ts** - Dark/light theme management
- **useUiScale.ts** - Persists and applies the global UI scale factor
- **useNetworkLatency.ts** - WebSocket latency tracking
- **useLineSelection.ts** - Text line selection utilities
- **useSelectionMode.ts** - Touch-selection state machine for `SelectionOverlay` (start/end cell, drag handles, copy-to-clipboard)
- **useConversationStream.ts** - Subscribes to `/ws/mux` conversation streams (`subscribe-conversation`) and exposes incremental conversation updates. The subscription carries the **pane's** `agentSessionId`, not just the workspace id: a workspace with two agent panes holds two conversations, and resolving by directory alone answered with whichever transcript was written last - a different agent from the one on screen (#80)
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

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Open session modal |
| `Ctrl+Shift+B` | Toggle dashboard panel |
| `Ctrl+D` | Split pane vertically |
| `Shift+D` (in session modal) | Split pane horizontally |
| `Ctrl+W` | Close current pane |
| `Ctrl+Shift+Arrow` | Resize pane |
| `Ctrl+Shift+=` | Equalize pane sizes |
| `Ctrl/Cmd+=` or `+` | Increase font size |
| `Ctrl/Cmd+-` | Decrease font size |
| `Ctrl/Cmd+0` | Reset font size to default (14px) |
| `Ctrl/Cmd+C` (with selection) | Copy selected text |
| `Ctrl/Cmd+V` | Paste from clipboard |

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

`services/stt-prompt.ts` composes the vocabulary-biasing `prompt`. Its order is
**the speaking session's own words, then the Japanese workspace names, then the
glossary, then the ASCII workspace names**, filled up to what fits Whisper's
224-token ceiling (190 characters). That order is the point of the design: as
workspaces multiply, names alone eat the budget and `release` - a word said
several times a day - falls out. There is no separate custom-title store anymore
- renaming a session writes straight to the herdr label - so script is what
tells the two kinds of name apart: a Japanese label is a person's own coinage
said out loud, an ASCII label is directory-ish text that goes last because
Latin-script names were never the ones being misheard. `HRDLE_STT_PROMPT=off` disables it, and any other value replaces
it (for A/B testing; the variable name is composed by `envVar()` from
`binaryName` in `identity.json`).

The first group is per session (#166): `?session=<workspace id>` on the STT
request names who is speaking, and `PUT /api/sessions/:id/stt-prompt` stores a
short phrase against that session in `SessionMetadataService`, beside its theme. The glasses send it from `voiceTarget.sessionId`, which is the
workspace the reply is going to. Its words go **before the glossary but do not
replace it** - the glossary is what is said every day in every session, and a
session that spent the whole budget on its own vocabulary would start mishearing
`リリース` again. A session with no prompt of its own composes exactly as before.

Note that the composed line is what a session prompt joins. Either *override* -
the saved setting or `HRDLE_STT_PROMPT` - still means "send exactly this" and
skips the composition, session words included.

The key, the language and that prompt are also settings, editable from the
glasses app's own web screens (the phone companion UI and the simulator) and
stored by `services/glasses-settings.ts` in `<dataDir>/glasses-settings.json`
(0600, since it can hold a key):

| | Precedence | Notes |
|---|---|---|
| Groq key | setting, then `GROQ_API_KEY` | Write-only through the API - `GET /api/glasses/settings` reports only whether one is set and where it came from |
| Language | `?lang=` on the request, then the setting, then `ja` | `auto` sends no language at all and lets Whisper detect it. The glossary is Japanese, so a prompt of its own is what makes another language work properly |
| Prompt | setting, then `HRDLE_STT_PROMPT`, then composed | The setting wins because it is the one reachable while wearing the glasses; the env var stays for an A/B run that should not outlive the process |

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

`PreToolUse` and `UserPromptSubmit` are no longer needed (since v0.2.2). The
indicator's state transitions come from herdr's `pane.agent_status_changed`, so a
hook only carries what herdr does not have: the notification body and the
question's tool name. Leaving them registered does no harm.

2. Make sure the `hrdle` binary is on PATH (hooks run from the Claude Code /
   Codex process). A hook runs in a **non-interactive shell**, so `.zshrc` is not
   read: a setup that adds `~/bin` or `~/.local/bin` to PATH from `.zshrc` cannot
   resolve the bare name and fails with `command not found` (#538). Write the
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

Written down because it was got wrong three times in one afternoon (2026-07-31),
each time by assuming rather than looking. Anyone about to describe this product
— a README, a store listing, the setup guide — should read this first.

The agents are not the competition. Claude Code, Codex, Grok and Kimi are the
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

Measured on device on 2026-08-01, against an Android 16 phone with the app
holding camera permission at the OS level. The WebView is
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

**The scanner is gone, and so is the code it read.** `qr-scan.ts`,
`qr-decode.ts`, `photo-capture.ts` and `camera-probe.ts` were kept for a while
with no route to them, on the theory that they would work the day the host
implements `onPermissionRequest`. Keeping them cost more than that day is worth:
four modules, a jsQR dependency, two blocks of translated strings and — the
expensive part — a story told across the app, the setup site and the installer
about a code that nothing could read. `hrdle qr` is now `hrdle address` (the old
name still works) and prints two lines of text instead of drawing anything.

They are in the history, deleted together, if the platform ever changes: the
decoder was better than what it replaced (BarcodeDetector first, then jsQR over
the full frame, a centre crop and native resolution — a 150px code in a
4000x3000 photo reads from the crop and fails everything else), and
`camera-probe.ts` is the screen that produced the table above. Recover that
commit before re-testing any of this rather than starting the investigation
over.

### What `app.json` asks for

Two permissions, and the list is derived from the SDK calls rather than from
what the app looks like it might want:

| | Why |
|---|---|
| `network` | Every request to the server, and the guide iframe |
| `g2-microphone` | `audioControl(true, AudioInputSource.Glasses)` in `display.ts` |

`camera` was declared until 0.0.28 and never bought anything. It grants the
SDK's `captureImageFromCamera()`, which **nothing in `glasses/src` calls** — the
routeless scanners reach for `getUserMedia` and `<input capture>`, which are web
APIs the manifest has no say over (the table above). So it asked a user to grant
a camera that could not then be opened. If the host ever implements
`onPermissionRequest` and those files are wired up again, it still will not be
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

It did not always. It used to lay the screen out itself from `screenText()` -
same strings, second implementation of where they go - and every divergence that
cost real debugging time was of that shape: character widths off by one, paging
repeating the previous line on the device only, tofu on the device only, a recap
missing in the simulator only (all four found on 2026-07-27 and 28), a notice
strip 36px from where the device drew it.

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
https://<host>:5924/glasses?player   # screen-mirror recording replay player (#127)
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
  nothing else. Measured on 2026-08-04: a server started with both pointed at a
  scratch directory came up holding all 16 of the user's workspaces
- A socket path is capped by `sun_path` (104 bytes). A scratchpad path is
  already longer than that, which is a hint that the socket does not belong
  there

Two more things a test on the default server gets wrong, both found the same
day:

- **`pane.split` ignores the `pane_id` it is given and splits the focused
  pane** — which is the user's, not the test's. Drive a test pane through
  `hrdle send` / `hrdle peek` with an explicit `<peer>:<session>:<paneId>`
  target, which does route where it says
- **The dev server shares hrdle's own data directory** with production, so
  `SessionMetadataService` hands it the user's remembered sessions and they
  appear in `GET /api/sessions` with `panes: null`. Harmless to read, but do
  not mistake them for the test's own, and do not write session metadata from a
  test run
