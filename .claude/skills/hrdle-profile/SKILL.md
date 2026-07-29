---
name: hrdle-profile
description: Turn the Bun inspector on temporarily for the production Hrdle service and take a CPU profile or heap snapshot. Triggers on "CPU is high", "take a profile", "flame chart", "inspect mode", "heap snapshot", "find the hotspot at JS function level", "CPUが高い", "プロファイル取って". Zero overhead when idle - the inspector is opened only when needed and closed afterwards.
---

# hrdle-profile

## Requirements

`hrdle.service` running under systemd-user. Linux only (macOS launchd is not
supported). `hrdle --version` v0.1.127 or newer.

## The commands

```bash
hrdle debug profile --seconds N   # open the inspector for N seconds, then disable it
hrdle debug enable                # leave it open (must be disabled by hand)
hrdle debug disable               # back to normal mode
hrdle debug status                # current state
```

## Default flow — entirely from this session (recommended)

The bundled `scripts/profile.ts` speaks CDP over the WebSocket directly and
produces a `.cpuprofile`. **Chrome and DevTools are not needed; this stays inside
the Claude session.**

```bash
# from inside the Hrdle project:
bun .claude/skills/hrdle-profile/scripts/profile.ts profile --seconds 30 --out /tmp/p.json
```

What it does:
1. `hrdle debug enable` starts the inspector
2. Reads the WS URL out of the journal
3. Over the WebSocket: `ScriptProfiler.startTracking`, sleep `--seconds N`,
   `ScriptProfiler.stopTracking`
4. Writes the samples from `trackingComplete` to `--out` as JSON
5. `hrdle debug disable` restores normal mode (guarded by `try/finally`)

Analysis:

```bash
# overall top (self time + total time)
bun .claude/skills/hrdle-profile/scripts/profile.ts analyze /tmp/p.json

# leaf breakdown of stacks containing a given function
bun .claude/skills/hrdle-profile/scripts/profile.ts drill /tmp/p.json buildSessionsList
```

**Put real load on it while sampling** (curl `/api/dashboard` or `/api/sessions`
in a loop, or drive the real UI). Sampling an idle server surfaces nothing.

## Through local Chrome (optional)

If you want to open the `.cpuprofile` in Chrome DevTools or VS Code's
Performance / CPU profiler:

1. Run `hrdle debug profile --seconds 60`
2. Take `https://debug.bun.sh/#<IP>:9229/<token>` from the journal
3. In local Chrome's `chrome://inspect`, add `<TAILSCALE_IP>:9229` under
   Configure, then inspect the hrdle remote target
4. Performance tab, Record, reproduce the activity, Stop, right-click to save the
   `.cpuprofile`
5. It disables itself after 60s

> **Not through agent-browser**: mixed content between HTTPS debug.bun.sh and
> `ws://`, plus the WebSocket constraints around it, leave the Timeline's event
> list empty. From this side, always use the `scripts/profile.ts` route above.

## Leaving it open

Only when the investigation is interactive:

```bash
hrdle debug enable
# ... investigate ...
hrdle debug disable    # always restore it by hand
```

If `hrdle debug status` still says the inspector is enabled, it was forgotten.
Restore it.

## Checking the connection without a UI

To confirm the inspector is alive:

```bash
curl -s http://localhost:9229/json/version
# {"Protocol-Version":"1.3","Browser":"Bun","User-Agent":"Bun/...","WebKit-Version":"...","Bun-Version":"..."}
```

A response means the inspector is healthy.

## What you can get

- **CPU profile** (.cpuprofile): execution time sampled with JS function names,
  files and line numbers - down to which function inside `buildSessionsList` is
  slow
- **Heap snapshot**: memory grouped by object, for leak hunting
- **Sources**: breakpoints and stepping through the running TS/JS (not something
  to do in production as a rule)

## Notes

- Switching into inspector mode **restarts the service through systemctl**.
  WebSocket clients disconnect and reconnect automatically, but requests in
  flight are lost. Avoid it while someone is working
- The inspector port (9229) listens on `0.0.0.0`. That is fine if it is only
  reachable over the tailnet; if any port forwarding exists, be careful while it
  is enabled
- Ctrl-C during `profile.ts profile ...` or `hrdle debug profile` can leave the
  drop-in behind. After an interrupt, run `hrdle debug disable` by hand
- Mechanically, the mode is the presence of
  `~/.config/systemd/user/hrdle.service.d/99-inspect.conf`. Editing it directly
  works, but the CLI is safer
- A profile taken while idle tends to come back with `stackTraces: []`. **Always
  generate load with curl or the real UI while sampling**
- Do NOT call `Inspector.enable`, `Debugger.enable` or `Runtime.enable` inside
  `scripts/profile.ts`. They put JSC into a debugger-attached state that stops
  `ScriptProfiler` sampling. Calling `ScriptProfiler.startTracking` directly is
  enough

## References

- Implementation: `backend/src/commands/debug.ts`
- Added in: v0.1.127 (see the CHANGELOG)
- Bun docs: https://bun.sh/docs/runtime/debugger
