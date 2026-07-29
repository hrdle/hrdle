---
name: hrdle-test
description: Run Hrdle's browser tests - start the dev environment and verify the UI through agent-browser. Triggers on "/hrdle-test", "test it in a browser", "テストして", "ブラウザテスト".
---

# Hrdle Browser Test

Automated browser testing of Hrdle's terminal features (the herdr backend).

## Prerequisites

- The dev environment is running (ports 3457 and 5174)
- agent-browser is available

## Test Workflow

### 1. Prepare the environment

```bash
# check the ports
fuser 3457/tcp 2>/dev/null && echo "Backend OK" || echo "Backend NOT running"
fuser 5174/tcp 2>/dev/null && echo "Frontend OK" || echo "Frontend NOT running"

# if nothing is running
cd /home/m0a/repos/hrdle-work-1
fuser -k -9 3457/tcp 2>/dev/null; fuser -k -9 5174/tcp 2>/dev/null
sleep 1 && nohup bun run dev > /tmp/hrdle-dev.log 2>&1 &
sleep 4
```

### 2. Open the browser (onboarding skipped automatically)

```bash
agent-browser close 2>/dev/null
agent-browser --ignore-https-errors open "https://localhost:3457?skipOnboarding=true"
agent-browser wait 4000
```

The `?skipOnboarding=true` query parameter skips onboarding.

> The certificate is issued for the Tailscale hostname, so `localhost` fails with
> `ERR_CERT_COMMON_NAME_INVALID` unless `--ignore-https-errors` is passed. If it
> still refuses, open `https://<tailscale-hostname>:3457` instead.

### 4. What to test

#### 4-1. The terminal renders
```bash
agent-browser screenshot
# confirm both panes are visible
```

#### 4-2. Keyboard input
```bash
agent-browser snapshot -i
# click the terminal area (get the ref dynamically — find the terminal/xterm element in the snapshot)
agent-browser click @eXX   # Terminal canvas (ref varies per session)
agent-browser type @eXX "echo test"
agent-browser press Enter
agent-browser wait 2000
agent-browser screenshot
```

#### 4-3. Splitting a pane (Ctrl+D)
```bash
curl -sk "https://localhost:3457/api/sessions/<session>/panes/%251/viewport?lines=1" | jq '{rows, cols}'   # pane PTY size
agent-browser press Control+d  # split
sleep 2
curl -sk "https://localhost:3457/api/sessions/<session>/panes/%251/viewport?lines=1" | jq '{rows, cols}'   # pane PTY size
agent-browser screenshot
```

#### 4-4. Pane resize shortcuts
```bash
echo "=== Before ===" && curl -sk "https://localhost:3457/api/sessions/<session>/panes/%251/viewport?lines=1" | jq '{rows, cols}'

# Ctrl+Shift+Right: widen by 5 columns
agent-browser press Control+Shift+ArrowRight
sleep 1
echo "=== After Right ===" && curl -sk "https://localhost:3457/api/sessions/<session>/panes/%251/viewport?lines=1" | jq '{rows, cols}'

# Ctrl+Shift+Left: narrow by 5 columns
agent-browser press Control+Shift+ArrowLeft
sleep 1

# Ctrl+Shift+=: equalize
agent-browser press Control+Shift+Equal
sleep 1
echo "=== After equalize ===" && curl -sk "https://localhost:3457/api/sessions/<session>/panes/%251/viewport?lines=1" | jq '{rows, cols}'
```

**Note**: `Ctrl+Alt+Arrow` does not work in a headless browser; `Ctrl+Shift+Arrow`
does. To test through a JS dispatch:
```bash
agent-browser eval "window.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', ctrlKey: true, shiftKey: true, bubbles: true})); 'ok'"
```

#### 4-5. Drag resize

**Important**: the divider's position moves with the pane sizes, so look it up
every time.

```bash
# find the divider's center dynamically
CENTER_X=$(agent-browser eval "(() => { const divs = document.querySelectorAll('[style*=\"position: relative\"]'); for (const d of divs) { if (d.className.includes('cursor-col-resize')) { const r = d.getBoundingClientRect(); return Math.round(r.left + r.width / 2); } } return -1; })()" | tr -d '"')

# drag it 150px to the left
agent-browser mouse move $CENTER_X 360 --steps 5
sleep 0.5
agent-browser mouse down
sleep 0.5
agent-browser mouse move $((CENTER_X - 150)) 360 --steps 20
sleep 0.3
agent-browser mouse up

# confirm the size changed (through rows/cols on the viewport REST call)
sleep 3
curl -sk "https://localhost:3457/api/sessions/<session>/panes/%251/viewport?lines=1" | jq '{rows, cols}'
```

#### 4-6. Check for a resize loop
```bash
# wait five seconds and count the resize log lines
sleep 5
tail -100 /tmp/hrdle-dev.log | grep -c '\[Resize\]'
# two or three is fine; ten or more means an infinite loop
```

#### 4-7. The size survives a reload
```bash
echo "=== Before reload ===" && curl -sk "https://localhost:3457/api/sessions/<session>/panes/%251/viewport?lines=1" | jq '{rows, cols}'
agent-browser open https://localhost:3457
agent-browser wait 5000
echo "=== After reload ===" && curl -sk "https://localhost:3457/api/sessions/<session>/panes/%251/viewport?lines=1" | jq '{rows, cols}'
# the size should be identical
```

### 5. Clean up
```bash
agent-browser close
```

## Shortcuts Reference

| Shortcut | Action |
|----------|--------|
| Ctrl+D | Split vertically (new pane on the right) |
| Ctrl+Shift+D | Split horizontally (new pane below) |
| Ctrl+W | Close the pane |
| Ctrl+Arrow | Move pane focus |
| Ctrl+Shift+Arrow | Resize the pane (±5/±3) |
| Ctrl+Shift+= | Equalize panes |
| Ctrl+B | Toggle the session list |
| Ctrl+C | Copy |
| Ctrl+V | Paste |
| Ctrl+1-9 | Switch session |

## Log Locations

- Dev server log: `/tmp/hrdle-dev.log`
- Frontend log (remote): `tail -f logs/frontend.log` (from the hrdle-work-1 dir)
- Resize events: `grep '\[Resize\]' /tmp/hrdle-dev.log`
