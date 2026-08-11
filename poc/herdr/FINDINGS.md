# PoC: can herdr replace tmux as the backend?

Tested 2026-07-14 / herdr v0.7.3 (protocol 16) / Arch Linux

## Conclusion (implemented — herdr is the backend)

**It works. Verified in dev against a real Claude Code session** (TUI drawing,
the input box's cursor, a Japanese prompt round trip, the hook indicator, the
ccSessionId link, splits, scrollback and closing). The one remaining constraint
is the 1000-line API cap on deep scrollback, which waits on herdr adding
something (offset support on `pane.read`, or a looser cap).

### The architecture the implementation settled on (v2)

A `herdr terminal session control` runs per pane, everything through one stream:
- Input: `{"type":"terminal.input","bytes":"<base64>"}` — **raw pass-through**
  (the `pane.send_input` RPC drops newlines and ESC inside text, so it is not
  used. Mouse SGR and bracketed paste arrive intact, and the single stdin pipe
  guarantees ordering)
- Resize: `{"type":"terminal.resize","cols":N,"rows":N}` — an absolute size per
  pane (the herdr grid is immutable headless, so the layout is CC Hub's own split
  tree)
- Output: the terminal.frame records on stdout (base64 ANSI) trigger a viewport
  refetch, and **the cursor position and alt-screen state are tracked** from the
  trailing CUP, `?25h/l` and `1049h/l` transitions in each frame (a pane that was
  already in alt before attaching shows no transition, so the initial guess is
  "a non-shell foreground process and zero host scrollback")
- Agent detection: a full scan of `pane.process_info`'s foreground_processes
  (the first is the group leader = claude, the rest are its MCP server children)

## Reproducing the test environment

```bash
# install (a single binary from GitHub releases)
gh release download v0.7.3 --repo ogulcancelik/herdr --pattern 'herdr-linux-x86_64'
install -m755 herdr-linux-x86_64 ~/.local/bin/herdr

# start the headless server (no TUI needed)
herdr server &        # socket: ~/.config/herdr/herdr.sock
herdr status server

# a pane to test against
herdr workspace create --cwd ~     # -> w1 / w1:t1 / w1:p1
bun run poc/herdr/poc-client.ts w1:p1
```

## Results

| What CC Hub used tmux for | The herdr equivalent | Result |
|---|---|---|
| `-CC` control mode (`%output` push) | `herdr terminal session observe <target>` -> NDJSON `terminal.frame` (base64 ANSI bytes, a `full` flag distinguishing a full redraw from a diff, `--cols/--rows` accepted) | OK, measured. The format goes straight into xterm.js through `term.write()` |
| `capture-pane -e` (a viewport with ANSI) | `pane.read {source:"visible"/"recent", format:"ansi"}` | OK. SGR is preserved (normalized to the 256-color form: `\e[31m` -> `\e[38;5;1m`) |
| Scrollback paging at an arbitrary offset | `pane.read {source:"recent", lines: offset+rows}` then slice the tail | Caveat: **a hard 1000-line cap** (lines=50000 still returns 1001). Only offset+rows <= 1000 works |
| How much scrollback is kept | `[advanced] scrollback_limit_bytes` (10MB by default, measured at 14,441 lines) | It is kept, but the API cannot reach it (see the cap above) |
| `send-keys -H` (UTF-8-safe input) | `pane.send_text` / `pane.send_keys` (JSON, so byte-splitting disappears structurally) | OK. Japanese and emoji round-trip, measured |
| Parsing the layout string (`TmuxLayoutParser`) | `pane.layout` -> structured JSON (rect / splits / ratio / zoomed) | The parser stops being necessary at all |
| Octal decoding (`TmuxOctalDecoder`) | Not needed (observe is base64, read is UTF-8 JSON) | The whole service can go |
| split / close / focus / resize / zoom / respawn | `pane.split/close/focus/resize/zoom` + `agent.start` | Available over both the CLI and the socket |
| Client size sync (`setClientSize`) | `terminal session control/observe --cols N --rows N` | The size can be given while observing |
| copy-mode selection | Nothing equivalent | Not available. CC Hub's SelectionOverlay (selection in the frontend) covers it |
| The cursor position (`PaneCursor`) | `pane.read` **does not return** cursor information; observe frames contain CUP | Caveat: a read-based viewport loses the cursor. Piping observe straight through is fine |
| Hook-based agent state | Subscribing to `pane.agent_status_changed` (working/blocked/done/idle detected natively) plus `agent.list` | Could replace most of the custom indicator machinery |
| Recovery after a restart (last-known-sessions) | `[experimental] pane_history` + `[session] resume_agents_on_restore` (resuming the agent's native session) | herdr is the more capable of the two |

## Notes on the socket API (measured)

- The protocol is **NDJSON over a Unix socket** (`~/.config/herdr/herdr.sock`)
- **One request per connection.** The server disconnects after replying (only
  `events.subscribe` holds the connection open and streams pushes)
- `pane.read`'s response is nested under `result.read.text`
- Reading 1000 lines takes about 8ms; responses are fast
- `herdr terminal session observe` runs as a CLI subprocess whose stdout NDJSON
  is read (the same shape as the tmux -CC subprocess; it is not exposed as a
  socket API method)

## Proposed architecture (if we migrate)

```
Browser <--WS (/ws/mux)--> Hono Server <--NDJSON socket + observe subprocess--> herdr server <--PTY--> Claude Code
```

- `TmuxControlSession` -> `HerdrControlSession` (reads the observe subprocess's
  NDJSON; no octal decoding)
- `PaneViewport` composition -> assembled from `pane.get` (scroll) and
  `pane.read` (ansi); see `captureViewport` in poc-client.ts
- `TmuxLayoutParser` / `TmuxOctalDecoder` -> deleted
- HookStatusService -> folded gradually into a `pane.agent_status_changed`
  subscription

## Blockers and how to handle them

1. **The 1000-line cap on pane.read** (the important one)
   - File a feature request upstream for an offset parameter or a configurable
     cap (herdr is developed full time and releases often, so this is plausible)
   - Alternative: accumulate observe frames server-side and keep our own history
     (close to reimplementing a terminal emulator - heavy, not recommended)
   - For now: limit the web UI's scrollback to 1000 lines (enough in practice
     most of the time)
2. **The cursor position**: lost in read-based composition. Worth considering
   together with a rendering change that pipes observe frames straight through
   (shrinking viewport-render.ts's role)
3. **Protocol stability**: v0.7.x / protocol 16. Before 1.0, pin the version and
   check the protocol through `herdr status server` at startup

## Test logs

- The PoC client: `poc/herdr/poc-client.ts` (every path exercised from Bun,
  exit 0)
- Raw data: read-*.txt / observe.ndjson / herdr-schema.json in the scratchpad
