# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Codex and other coding agents should use this file as the single source of repository guidance; `AGENTS.md` only points here.

## Project Overview

CC Hub is a web-based terminal session manager for Claude Code. It runs Claude Code instances in herdr workspaces and provides a web UI for remote access from tablets/mobile devices.

## Commands

```bash
# Development (starts both backend and frontend)
bun run dev

# Individual services
bun run dev:backend   # Backend only (port 3456)
bun run dev:frontend  # Frontend only (port 5173)

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
- **HerdrControlSession** (`services/herdr-control.ts`) - One instance per CC Hub session (= one herdr workspace). Owns the pane split tree, tracks the focused pane, spawns lazy per-pane controllers (WS subscribe / first input only — read-only REST never takes over a pane), scans frames for cursor position and alt-screen state, client lifecycle with 30s grace period. **Renders a single tab**: a herdr workspace is `workspace > tab > pane`, so it filters to the active tab (`workspace.get`'s `active_tab_id`), follows tab switches via `tab.*` events (`switchActiveTab` re-hydrates the tree), and never merges tabs into one flat chain. `selectTab`/`createTab`/`closeTab` drive the tab set. Also `captureViewportHerdr`: viewport composition from `pane.read` (visible at offset 0, `recent` slice for scrollback, capped at herdr's 1000-line read limit)
- **HerdrLayout** (`services/herdr-layout.ts`) - CC Hub-owned split tree (herdr's own grid can't be resized headlessly): split/close/zoom/ratio adjust/absolute pane sizing, rendered to tmux-convention `TmuxLayoutNode` rects for the frontend
- **HerdrService** (`services/herdr.ts`) - Session-level operations mapping CC Hub sessions onto herdr workspaces: list (with agent detection from `pane.process_info`, native agent session ids from `agent.list`, `blocked` status), create/kill, previews, and `moveSession` — herdr's workspace order **is** the session display order, so a reorder is a `workspace.move` and nothing is stored on the cchub side
- **HerdrUpdateService** (`services/herdr-update.ts`) - Detects herdr binary-vs-server version skew (`herdr update` swaps the binary but leaves the running server old) by parsing `herdr status --json`, cached 30s and refreshed off the dashboard poll. Reports only — applying (`herdr update` + supervised restart) is an explicit user action via `POST /api/herdr/apply-update`; never the `cchub update --auto` timer, never `--handoff`. Unreadable status degrades to no warning
- **PaneState** (`services/pane-state.ts`) - Backend-agnostic `stripAnsi` / `detectPaneState` heuristics for peer-dialog tooling (`cchub send --wait`, `cchub peek`)
- **ClaudeCodeService** (`services/claude-code.ts`) - Monitors Claude Code state from `.jsonl` files; active-session matching uses only herdr's native agent session id
- **SessionHistoryService** (`services/session-history.ts`) - Reads past Claude Code session history and conversations
- **SessionMetadataService** (`services/session-metadata.ts`) - Persists session metadata (theme, title, last known sessions for recovery after reboot). Deliberately *not* session order — that lives in herdr
- **SessionsService** (`services/sessions.ts`) - Session CRUD operations with file-based persistence
- **PromptHistoryService** (`services/prompt-history.ts`) - Searches prompt history across sessions
- **FileService** (`services/file-service.ts`) - Secure file operations with path traversal prevention
- **FileChangeTracker** (`services/file-change-tracker.ts`) - Parses Claude Code `.jsonl` logs to track file changes
- **AnthropicUsageService** (`services/anthropic-usage.ts`) - Fetches usage limits from Anthropic API with 60s cache, 5min backoff on 429, in-flight request coalescing
- **AnthropicModels** (`services/anthropic-models.ts`) - Static metadata for Anthropic models (context size, pricing) used by cost/usage calculations
- **StatsService** (`services/stats-service.ts`) - Reads cached statistics from `~/.claude/stats-cache.json`
- **UsageHistoryService** (`services/usage-history.ts`) - Records usage snapshots to `/tmp/cchub-usage-history.json` with 30s throttling
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
- **OpenRouterPricingService / OpenRouterAccountService** (`services/openrouter.ts`) - Pay-as-you-go cost reporting: list prices from the public `/api/v1/models` (no auth, 24h cache) drive *estimated* per-window costs, while `/api/v1/key` + `/api/v1/credits` (keyed, 60s cache, 5min failure backoff) report OpenRouter's *billed* daily/weekly/monthly spend and credit balance. Estimates use rolling windows, OpenRouter's are calendar windows, so the two never match exactly
- **ConversationWatcher** (`services/conversation-watcher.ts`) - Watches Claude Code / Codex `.jsonl` files and emits conversation updates to subscribed WebSocket clients
- **HookStatusService** (`services/hook-status.ts`) - Reports whether the hooks CC Hub still needs are installed (`Stop` for notification text, `PostToolUse`/`AskUserQuestion` for the question's tool name). Indicator transitions come from herdr, not hooks
- **HerdrAgentStatusWatcher** (`services/herdr-agent-status.ts`) - Subscribes to herdr's per-pane `pane.agent_status_changed` (plus pane lifecycle events, which re-subscribe the pane set) and triggers an immediate sessions push. Decides *when* to rebuild the list, never what's in it — a dropped event costs latency, not correctness
- **AuthService** (`services/auth.ts`) - Password-based authentication with session tokens
- **PeerRegistry** (`services/peer-registry.ts`) - Persists peer server metadata to `peers.json` (with mutation locking), records per-peer success/failure state
- **PeerAuth** (`services/peer-auth.ts`) - Proxy login to peer servers (`POST /api/auth/login`), stores JWT tokens for subsequent API/WS calls, marks peers `unauthorized` on 401
- **PeerDiscovery** (`services/peer-discovery.ts`) - Scans the Tailscale tailnet (`tailscale status --json`) and probes each peer's `:5923/health` in parallel to find running CC Hub instances
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
- `POST /:id/panes/input` - Send input to a pane over REST (used by `cchub send` / peers)
- `GET /:id/panes/:paneId/viewport` - Capture a pane viewport over REST (used by `cchub peek` / `--wait`)
- `POST /:id/tabs/select` - Switch the workspace's active tab (`{ tabId }`)
- `POST /:id/tabs/create` - Create and switch to a new tab
- `POST /:id/tabs/close` - Close a tab and all its panes (`{ tabId }`)
- `POST /:id/prompt` - Send a prompt to the session's agent
- `PUT /:id/theme` - Set session color theme
- `PUT /:id/title` - Set session custom title
- `POST /:id/move` - Move a session to `{ index }` in the display order (writes straight through to herdr's workspace order — cchub stores no order of its own)
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
- `GET /discover` - Discover CC Hub instances on the Tailscale tailnet
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
- **ConversationViewer.tsx** - Markdown-rendered conversation display with image support

**History V2** (`components/history/`, opt-in via `cchub-history-v2` localStorage flag):
- **SessionHistoryV2.tsx** - Flat searchable history list with facet filtering
- **HistoryRowV2.tsx** - Single history row item
- **HistoryFacetSidebar.tsx** / **HistoryFacetDrawer.tsx** - Facet filters (desktop sidebar / mobile drawer)
- **HistoryActiveChips.tsx** - Active filter chips
- **VirtualizedHistoryList.tsx** - Virtualized scrolling for large histories

**Peers**:
- **PeerManager.tsx** - Peer server management UI (register, verify, discover, reorder, remove)
- **dashboard/PeerServerCard.tsx** - Per-peer server info card with system metrics

**Chat** (`components/chat/`):
- **ChatView.tsx** - Conversation-style view of the current session, replacing the terminal area when "Chat" mode is selected
- **ChatComposer.tsx** - Multi-line message composer used by ChatView

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
- **useInputEcho.ts** - Echoes characters typed into the InputBar back into the conversation/chat view while the terminal is hidden
- **useConversationStream.ts** - Subscribes to `/ws/mux` conversation streams (`subscribe-conversation`) and exposes incremental conversation updates
- **useAgentConversation.ts** - Unified conversation hook: Claude streams over the WebSocket, thread agents (Codex/Grok) poll over HTTP — chosen from the shared `AGENT_PROVIDERS` registry
- **useThreadConversation.ts** - Polling conversation loader for thread-based agents (`?agent=codex|grok`)
- **usePeers.ts** - Peer list CRUD and state management (`/api/peers`)
- **usePeerConnection.ts** - Resolves connection info (HTTP/WS URLs, auth) for the active peer
- **usePeerSessionsWatcher.ts** - Persistent `/ws/mux` WebSocket per remote peer so `sessions-updated` pushes arrive without polling
- **usePeerServerMetrics.ts** - Fetches a peer's dashboard metrics for `PeerServerCard`
- **useHistoryActions.ts** - History operations (resume, delete, metadata updates)
- **useFlatHistoryItems.ts** - Flattens project-grouped history into a filterable list for History V2
- **useHistoryV2Flag.ts** - History V2 opt-in flag (`cchub-history-v2` localStorage)
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
- **Layout**: CC Hub owns the split tree (`herdr-layout.ts`) because the herdr grid can't be resized headlessly; pane PTYs are sized individually via each pane's control stream, and layout updates go to all connected clients
- **Size management**: Client sends container size, the split tree computes pane rects, xterm.js uses `setExactSize()` from layout. `setClientSize` absorbs ±1-row mobile noise so viewports don't re-emit on minor resize
- **Viewport protocol**: Client sends `request-viewport { paneId, offset }`. Server replies (and live-mode subscribers also receive unsolicited pushes on frame arrival) with `viewport { paneId, cols, rows, lines, cursor, modes, historySize, offset, atTail }`. `offset=0` = live edge (pane.read visible); `offset>0` = `recent` slice N rows above — capped at herdr's 1000-line read limit
- **Initial viewport**: Sent immediately on `subscribe` so mobile doesn't show a gray canvas while waiting for the first resize round-trip
- **Cursor / alt-screen**: Scanned from control-stream frames (trailing CUP + `?25h/l`, `1049h/l` transitions; initial alt state guessed from a non-shell foreground process with zero host scrollback)
- **Lazy controllers**: Read-only REST access (`cchub peek`, viewport snapshots, previews) is pure RPC and never takes over a pane; control streams spawn on WS subscribe or first input
- **Scroll to live**: Tapping the terminal or showing the soft keyboard forces the client back to `offset=0`
- **Input**: Raw bytes (base64) over the pane's control stream — mouse SGR, bracketed paste, and escape sequences pass through intact; ordering guaranteed by the single stdin pipe

## CLI Commands

```bash
# Server
cchub                    # Start server (port 5923)
cchub -p 8080           # Custom port
cchub -P password       # With password auth

# Management
cchub setup -P pass     # Register systemd/launchd service
cchub uninstall         # Remove service registration
cchub update            # Update from GitHub Releases
cchub update --check    # Check only (no update)
cchub update --auto     # Auto-update mode (for timer)
cchub status            # Show service status

# Hook notification
cchub notify            # Send hook event (reads JSON from stdin)

# Remote pane control (target: <peer>:<session>:<paneId>, peer = 'local' | peer id | nickname)
cchub send local:dev:%1 "ls"        # Send text to a pane
cchub send local:dev:%1 --submit "fix the bug"  # Bracketed-paste + Enter (Claude/Codex TUI submit)
cchub send local:dev:%1 --stdin     # Read payload from stdin (--base64 for binary-safe)
cchub send local:dev:%1 --wait "y"  # Send, then snapshot viewport with detected state
                                    # (--wait-ms <n> delay, --lines <n> rows)
cchub peek local:dev:%1             # Snapshot a pane viewport (--lines <n>, default 20)

# Debugging (Bun inspector on the running service)
cchub debug status      # Show inspector state
cchub debug enable      # Enable inspector (port 9229)
cchub debug disable     # Disable inspector
cchub debug profile --seconds 30   # Enable for N seconds then auto-disable

# Help
cchub --help
cchub --version
```

### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port` | Port number | 5923 |
| `-H, --host` | Bind address | 0.0.0.0 |
| `-P, --password` | Auth password | none |

### Requirements

- Tailscale must be running (used for HTTPS certificates)
- Run `sudo tailscale set --operator=$USER` once to allow cert generation
- macOS: Install Tailscale via `brew install tailscale` (App Store version lacks CLI)
- herdr must be installed (`curl -fsSL https://herdr.dev/install.sh | sh` or `brew install herdr`); cchub auto-starts `herdr server` if it isn't running, but a supervised setup (systemd user unit with `Restart=always` + `~/.config/herdr/config.toml` with `resume_agents_on_restore = true`) is strongly recommended so agent sessions survive server restarts
- For native session identity/restore, install the herdr integrations once: `herdr integration install claude` / `codex` / `kimi` (`cchub setup` installs all initialized ones)

## Claude Code / Codex / Grok / Kimi Hook通知連携

Claude Code・Codex・Grok Build・Kimi Code のhookイベント（応答完了、ユーザー入力待ち等）をCC Hub経由でブラウザのOS通知として受け取れる。

Grok Build は `~/.claude/settings.json` の hooks を互換レイヤでデフォルト読み込みするため、Claude 用の `cchub notify` 設定がそのまま発火する（追加設定不要）。ただし stdin JSON は camelCase 独自形式（`hookEventName: "stop"`, `sessionId`, `transcriptPath`）なので、`/api/notify` 側で Claude 形式に正規化している（`routes/notify.ts` の `normalizeHookBody`）。

Kimi Code は `~/.kimi-code/config.toml` の `[[hooks]]` に設定する（例: `event = "Stop"`, `command = "cchub notify"`）。stdin JSON は Claude 互換の snake_case（`hook_event_name`, `session_id`, ...）なので正規化は不要。

### 仕組み

```
Hook → cchub notify (stdin JSON) → POST /api/notify → WebSocket broadcast → ブラウザ Notification API
                                                    ↘ グラス起動中は relay info アイテム → G2 画面
```

グラスアプリ（`subscribe-glasses-relay` の購読者）が居る間は、通知はブラウザではなく G2 に出す。`/api/notify` が hook の `session_id`（agent セッションid）または `cwd` から herdr の workspace/pane を解決し（`resolveHookTarget`）、90 秒 TTL の `info` リレーアイテムを作る（`postHookRelay`）。実際にアイテムが載ったときだけ `hook-event` に `deliveredToGlasses: true` を付け、フロント側はこのフラグが立っている時だけ `fireHookNotification` を呼ばない。グラスが居ない・セッションが解決できない・レート制限に当たった場合はフラグが立たず従来どおりブラウザ通知が出る（通知が消えるより二重に出るほうがマシ）。インジケータ更新はフラグに関係なく常に走る。

herdr が `blocked` を報告して waiting アイテムがある間は、hook 由来の info は作らない（同じ状況を二重に言うだけなので）。逆に hook が先に届いていた場合、waiting 成立時に hook 由来の info（`source: 'auto'`）は消される。エージェント自身の `cchub glasses` メモ（`source: 'agent'`）は無関係なので残る。

### セットアップ手順

1. Claude Code は `~/.claude/settings.json` の `hooks` に `cchub notify` を追加する。Codex は `~/.codex/hooks.json` に追加する（`config.toml` と併用するとCodexが警告するため、`cchub setup` が既存のCC Hub hookをJSONへ移行する）:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "cchub notify" }] }],
    "PostToolUse": [{
      "matcher": "AskUserQuestion",
      "hooks": [{ "type": "command", "command": "cchub notify" }]
    }]
  }
}
```

`PreToolUse` / `UserPromptSubmit` はもう不要（v0.2.2〜）。インジケータの状態遷移は herdr の `pane.agent_status_changed` から取るようになったため、hook は herdr が持たない情報（通知本文・質問のツール名）だけを運ぶ。既に登録済みでも害はない。

2. `cchub` バイナリにPATHが通っていることを確認（hookはClaude Code / Codex のプロセスから実行される）

3. CC Hubサーバーがデフォルトポート（5923）で起動していること。カスタムポートの場合は `cchub notify -p <port>` を指定

4. ブラウザで初回アクセス時に通知権限を許可する

### 対応イベント

| hookイベント | 通知メッセージ |
|-------------|-------------|
| `Stop` | Claudeの応答が完了しました |
| `PostToolUse` (AskUserQuestion) | Claudeがユーザー入力を待っています |
| `SubagentStop` | サブエージェントが完了しました |
| `TaskCompleted` | タスクが完了しました |
| その他 | Hook: {イベント名} |

### 注意事項

- `cchub notify` はstdinからClaude Code / Codex のhook JSON入力を読み取る
- `/api/notify` エンドポイントは認証不要（ローカルhookから呼ばれるため）
- 既存のhookスクリプト（smart-notify.py等）と併用可能（同じイベントに複数hook登録）
- 複数のWebSocket接続がある場合でもデバウンスにより通知は1回のみ
- グラスは接続している1台のCC Hubの通知しか表示しないので、`deliveredToGlasses` はイベントを起こしたサーバーだけが立てる。peer の通知は peer 側にグラスが繋がっていない限り従来どおりブラウザに出る

## Internationalization (i18n)

CC Hub supports English and Japanese. Language is automatically detected.

### Frontend (Web UI)

Uses `react-i18next` with browser language detection:
- Translation files: `frontend/src/i18n/locales/{en,ja}.json`
- Language switcher in UI (EN/JA button)
- Preference saved to `localStorage` (`cchub-language`)

### Backend (CLI)

Uses custom i18n module with embedded translations:
- Module: `backend/src/i18n/index.ts`
- Language detected from environment variables: `LANG`, `LC_ALL`, `LC_MESSAGES`
- Japanese locale (`ja_*`) → Japanese, otherwise English

## Type Sharing

Types are defined in `shared/types.ts` with Zod schemas for validation. Import from `../../../shared/types` in both backend and frontend.

Key types: `ControlClientMessage`, `ControlServerMessage` (per-session terminal I/O), `MuxClientMessage`, `MuxServerMessage` (multiplexed WebSocket protocol), `PaneViewport` / `PaneCursor` / `PaneModes` (viewport frames), `SessionResponse`, `PaneInfo`, `TabInfo` (a workspace's tabs; `SessionResponse.tabs`/`activeTabId`, only when >1 tab), `TmuxLayoutNode`.

## Linting

Uses [Biome](https://biomejs.dev/) for linting. Configuration in `biome.json` at project root.

- a11y rules (`useButtonType`, `noSvgWithoutTitle`, etc.) set to `"warn"` — not blocking CI
- Biome 2.x config format: `{ "level": "warn" }` (NOT just `"warn"`)
- Run `bun run lint` to check all packages

## Debugging

### Remote Logging

Frontend `console.log/warn/error/info` calls are automatically sent to the backend via `/api/logs`. Logs are written to `/tmp/cc-hub-browser.log`.

This enables debugging on mobile/tablet devices without access to browser DevTools. Use `tail -f /tmp/cc-hub-browser.log` to monitor frontend logs in real-time (also exposed via `GET /api/logs`).

### herdr Server State

If all terminals show "Connecting..." / "Session exited", check the herdr server first:

```bash
herdr status server                 # running? protocol version?
systemctl --user status herdr      # if supervised via systemd
```

cchub auto-starts `herdr server` at boot when the socket (`~/.config/herdr/herdr.sock`, or `$HERDR_SOCKET_PATH`) is unreachable. herdr's own log lives at `~/.config/herdr/herdr-server.log`. Sessions (workspaces) live in the herdr server process — restarting cchub never kills them; restarting herdr restores workspaces from `session.json` and, with `resume_agents_on_restore`, resumes agent conversations natively.
