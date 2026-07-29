# Hrdle

[日本語](README.ja.md) | English

A web-based terminal manager for coding agent sessions. Run Claude Code, Codex, Grok and Kimi on a server and drive them from your tablet or smartphone.

> **Formerly CC Hub.** [`m0a/cc-hub`](https://github.com/m0a/cc-hub) is archived at v0.2.98 and development continues here — the name said Claude Code, and this had long since stopped being only that. Existing installs keep working: that repository stays readable, so its releases and `install.sh` remain available and `cchub update` still resolves. Hrdle installs alongside rather than over it (separate binary, service, port and herdr session), so both can run on one machine.

## Features

- **Multi-session Management** - Run and switch between multiple agent sessions (Claude Code, Codex, Grok, Kimi)
- **Multi-pane Terminals** - Split panes horizontally/vertically with real-time layout sync across all clients (herdr-backed panes, Hrdle-managed layout)
- **Pane Operations** - Zoom, resize, focus, close panes via keyboard shortcuts or session modal UI
- **Team Agent Display** - Shows agent names and colors in pane list and mobile tab bar
- **Session Color Themes** - Assign colors to sessions for visual distinction
- **Desktop Support** - Text selection with auto-copy, font size adjustment (Ctrl+=/-)
- **Tablet-optimized UI** - Split layout, floating keyboard, pinch-to-zoom
- **Mobile Support** - Tap/long-press for custom keyboard, pane tab bar for multi-pane switching, momentum scrolling
- **File Viewer** - Syntax-highlighted code, image, Markdown and HTML preview
- **Change Tracking** - View file diffs from Claude Code edits and git changes (toggle between Claude/Git mode)
- **Browser Back Navigation** - Navigate back through FileViewer states with browser back gesture
- **Tailscale Integration** - Secure HTTPS via Tailscale certificates
- **Password Authentication** - Access control with `-P` option
- **Auto-update** - Automatic updates from GitHub Releases
- **Service Integration** - systemd (Linux) and launchd (macOS) with auto-restart
- **Dashboard** - Usage limits, daily statistics, cost estimates, system metrics, network latency
- **Session History** - Browse and resume past Claude Code sessions with full-text search
- **Conversation Viewer** - Markdown rendering, image display, system summary distinction
- **Prompt Search** - Search across prompt history from all sessions
- **Session Indicators** - See at a glance which sessions are working, waiting on you, or done — detected from the pane itself, no hooks required
- **Hook Notifications** - Browser push notifications for Claude Code events (response complete, user input needed)
- **Codex Support** - Run Codex CLI sessions alongside Claude Code (conversation view, usage tracking)
- **Chat View** - Conversation-style view of the current session as an alternative to the terminal
- **Peer Servers** - Connect multiple Hrdle servers over Tailscale (auto-discovery, aggregated sessions/history/dashboard)
- **Remote Pane Control** - `hrdle send` / `hrdle peek` to drive panes on local or peer servers from the CLI
- **Smart Glasses** - Read sessions and answer questions on EVEN Realities G2 (see below)
- **i18n** - English and Japanese UI with automatic language detection
- **Onboarding Walkthrough** - Spotlight-style guide for first-time users

## Smart Glasses (EVEN Realities G2)

A companion app for the G2 (`glasses/`, built with the EvenHub SDK) turns the glasses
into a read-and-answer surface for your sessions — useful when the agent needs a decision
and you are not at a screen.

- **Read and answer** — session list with status indicators, conversation view, and a
  choice mode that answers `AskUserQuestion` prompts without touching a keyboard
- **Notifications go to the lenses, not the browser** — while the app is connected, hook
  events become 90-second relay items on the G2 display. If the glasses are absent or the
  session cannot be resolved, the browser notification fires as before, so nothing is lost
- **Voice input** — the G2 SDK emits raw PCM, so transcription happens server-side via
  `POST /api/glasses/stt` (Groq `whisper-large-v3-turbo`). **The audio and the API key
  never leave your host**
- **Agent-written notes** — `hrdle glasses "<text>"` lets an agent put one line in front of
  you, with optional choices to answer. The session is resolved from the working directory,
  so agents rarely need to name it
- **Simulator** — the same app builds for the browser and is served at `/glasses`, so you
  can try it without hardware

Build and distribution live in [`glasses/README.md`](glasses/README.md). The packaged
`out.ehpk` is uploaded to EVEN Hub.

## Installation

### One-line Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/hrdle/hrdle/main/install.sh | bash
```

### Manual Installation

1. Download the appropriate binary from [Releases](https://github.com/hrdle/hrdle/releases/latest)
   - Linux x64: `hrdle-linux-x64`
   - macOS ARM64: `hrdle-macos-arm64`

2. Make executable and place in PATH

```bash
chmod +x hrdle-linux-x64
mv hrdle-linux-x64 ~/bin/hrdle
```

3. Add to PATH (if not already configured)

```bash
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

## Requirements

| Dependency | Required | Installation |
|------------|----------|--------------|
| [Tailscale](https://tailscale.com/) | Yes | Linux: https://tailscale.com/download / macOS: `brew install tailscale` |
| [herdr](https://herdr.dev/) | Yes | `curl -fsSL https://herdr.dev/install.sh \| sh` / `brew install herdr` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Yes | `npm install -g @anthropic-ai/claude-code` |

## Quick Start

```bash
# 1. Allow Tailscale certificate generation (first time only)
sudo tailscale set --operator=$USER

# 2. Start Hrdle
hrdle
# Or with password
hrdle -P mypassword

# 3. Access in browser
#    https://<your-hostname>:5924
```

### Register as Service

```bash
hrdle setup -P mypassword
```

This enables:
- Auto-start on system boot (systemd on Linux, launchd on macOS)
- Auto-restart on crash
- Auto-update via `hrdle update`

## Commands

```bash
# Start server
hrdle                        # Start on port 5924
hrdle -p 8080                # Specify port
hrdle -P mypassword          # Start with password

# Register service (auto-restart, auto-update)
hrdle setup -P mypassword
hrdle uninstall              # Remove service registration

# Update
hrdle update                 # Update to latest
hrdle update --check         # Check for updates only
hrdle update --auto          # Auto-update mode (for timer)

# Hook notification (used by Claude Code hooks)
hrdle notify                 # Send hook event (reads JSON from stdin)

# Status
hrdle status

# Remote pane control (target: <peer>:<session>:<paneId>)
hrdle send <target> [text]   # Send input to a pane on a local or peer server
hrdle peek <target>          # Snapshot a pane's current viewport

# Debugging
hrdle debug <sub>            # Bun inspector on the running service
                             # sub: enable | disable | profile | status
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port` | Port number | 5924 |
| `-H, --host` | Bind address | 0.0.0.0 |
| `-P, --password` | Auth password | none |
| `-h, --help` | Show help | - |
| `-v, --version` | Show version | - |

**`hrdle send` options** — `<target>` is `<peer>:<session>:<paneId>` where peer is `local`, a peer id, or a nickname:

| Option | Description |
|--------|-------------|
| `--stdin` | Read payload from stdin instead of the argument |
| `--newline` | Append `\r` to the payload (acts like pressing Enter once) |
| `--submit` | Wrap payload in bracketed paste markers + Enter (Claude Code / Codex TUI submit, works at any length) |
| `--base64` | Treat payload as base64 (binary-safe) |
| `--wait` | After sending, snapshot the pane viewport with detected state (idle / processing / permission_prompt / ask_user_question) |
| `--wait-ms <n>` | Delay before snapshot when `--wait` is set (default 800) |
| `--lines <n>` | Trailing rows to include in the viewport (default 20, also for `hrdle peek`) |

**`hrdle debug` options**: `--seconds <n>` (for `profile`: enable for N seconds then auto-disable).

### Tailscale Configuration

First-time setup requires allowing certificate generation:

```bash
sudo tailscale set --operator=$USER
```

> **macOS**: Install via `brew install tailscale`, not the App Store version. The App Store version lacks CLI commands needed for certificate generation.

### herdr Backend

Hrdle runs every session as a [herdr](https://herdr.dev/) workspace. `hrdle setup` provisions everything: a supervised `herdr server` (systemd on Linux, launchd on macOS), `~/.config/herdr/config.toml` with `resume_agents_on_restore = true` (agent conversations survive server restarts), and the Claude/Codex integration hooks (native session identity).

To update herdr later: `herdr update`, then restart the supervised server (`systemctl --user restart herdr`). The update replaces the binary but leaves the running server on the old version, so the restart is what actually applies it — Hrdle notices that gap and shows a warning on the dashboard, with a button that does both steps for you. Restarting re-creates every pane: agent conversations come back automatically, but commands running in a pane do not, so it waits for you to press it.

Do **not** use `herdr update --handoff` under systemd/launchd — the handed-off server escapes supervision.

## Usage

1. Open Hrdle in browser
2. Create a Claude Code session with "New Session"
3. Operate Claude Code in the terminal
4. Open file viewer with the file icon

### Keyboard Shortcuts

Hrdle streams pane frames from herdr and owns the split layout server-side. All connected clients see the same pane layout.

**Pane & Session Operations**:
| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Toggle session modal |
| `Ctrl+Shift+B` | Toggle dashboard panel |
| `Ctrl+D` | Split pane vertically (right) |
| `Ctrl+Shift+D` | Split pane horizontally (bottom) |
| `Ctrl+W` | Close pane |
| `Ctrl+Shift+Arrow` | Resize active pane |
| `Ctrl+Shift+=` | Equalize pane sizes |
| `Ctrl+Arrow` | Navigate between panes |
| `Ctrl+1-9` | Switch to session by number |

**Font Size & Clipboard (Desktop)**:
| Shortcut | Action |
|----------|--------|
| `Ctrl+=` or `Ctrl++` | Increase font size |
| `Ctrl+-` | Decrease font size |
| `Ctrl+0` | Reset font size to default |
| `Ctrl+C` (with selection) | Copy selected text |
| `Ctrl+V` | Paste from clipboard |

**Session Modal** (`Ctrl+B`): Shows session list with pane count badges. Expand to see individual panes with focus/close/split actions.

### Session Color Themes

Assign colors to sessions for visual distinction:

1. **Long-press** a session in the session list
2. Color selection menu appears
3. Choose from 9 colors (red, orange, amber, green, teal, blue, indigo, purple, pink) + none
4. Terminal background changes to selected color

### Tablet Mode

Automatically switches to tablet layout when screen width >= 640px and height >= 500px:
- Left: Terminal with split pane support (pinch-to-zoom supported)
- Session modal (`Ctrl+B`) for session switching
- Floating keyboard (draggable, minimizable)

**Pinch Zoom**: Pinch with two fingers on the terminal to zoom. UI controls are not affected by zoom.

### Keyboard Features

**Mobile (Smartphone)**:
- **Tap** or **long-press** terminal to show custom keyboard
- OS standard keyboard does not appear
- Scroll to dismiss keyboard

**Floating Keyboard (Tablet)**:
- Drag header to move position
- Minimize button for compact view
- Position saved separately for Japanese and keyboard modes

**Key Operations**:
- **Long-press** - Symbol input on number keys (1->!, 2->@, etc.)
- **JA** - Switch to Japanese input mode (uses OS standard IME)
- **ABC** - Return to keyboard mode

### Dashboard

View the following in the "Dashboard" tab:

- **Usage Limits** - 5-hour/7-day cycle usage rate, time until reset
- **Limit Prediction** - Estimated time to reach limit at current pace
- **Daily Statistics** - Message and session count graphs
- **Model Usage** - Opus/Sonnet token usage comparison
- **Cost Estimate** - Estimated API costs
- **System Metrics** - CPU, memory, swap usage with history graphs
- **Network Latency** - WebSocket round-trip latency

### Session History

Browse past Claude Code sessions in the "History" tab:

- Grouped by project
- View conversation content (Markdown supported)
- Resume sessions (continues with `claude -r`)
- Full-text search across all user messages

### Hook Notifications

Receive browser push notifications when Claude Code completes a response or needs input. Add `hrdle notify` to your Claude Code hooks:

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

Add this to `~/.claude/settings.json`. The Hrdle server must be running. Allow browser notification permissions on first access.

Hooks run in a **non-interactive** shell, which never sources `.zshrc`/`.bashrc`. If your PATH additions live there (a `~/bin` or `~/.local/bin` install), the bare name won't resolve and the hook dies with `command not found`. Use the absolute path in that case — `which hrdle` gives it, and Hrdle's own "set up hooks" button already writes the resolved path:

```json
{ "type": "command", "command": "/home/you/bin/hrdle notify" }
```

Session indicators (working / waiting / done) need no hooks at all — herdr reports agent status itself. These two hooks only carry what herdr can't see: the notification text and the name of the tool that asked a question.

## Development Setup

For development or building from source, [Bun](https://bun.sh/) 1.0+ is required.

```bash
# Install dependencies
bun install

# Start development server
bun run dev
```

Open http://localhost:5174 in browser (development mode).

### Build from Source

```bash
# Build as single binary
bun run build:binary
./dist/hrdle
```

### Development Commands

```bash
bun run dev:frontend    # Frontend only
bun run dev:backend     # Backend only
bun run test            # Run all tests
bun run test:e2e        # E2E tests
bun run lint            # Lint all packages
```

## Tech Stack

- **Backend**: Bun, Hono, WebSocket
- **Frontend**: React 19, Vite, Tailwind CSS v4, xterm.js, react-i18next
- **Terminal**: [herdr](https://herdr.dev/) socket API + per-pane control streams

## Architecture

An interactive overview of backend services, API routes, frontend components, hooks, WebSocket protocol, shared types and the major data flows lives in [`architecture.html`](architecture.html) (data: [`architecture.json`](architecture.json)).

- Render in your browser via [raw.githack](https://raw.githack.com/hrdle/hrdle/main/architecture.html) — JSON is embedded, no external fetch required.
- Edit `architecture.json` and run `python3 scripts/build-architecture-html.py` to refresh the embed.

## License

MIT
