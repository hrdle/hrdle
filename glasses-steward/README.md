# Hrdle Steward (glasses)

The steward's screens, on EVEN G2. A second app beside `glasses/`, not a
replacement for it: the existing `Hrdle` app stays untouched and installable
while this one is tried out.

Design: [#383](https://github.com/hrdle/hrdle/issues/383) (§グラスアプリ) and
[#459](https://github.com/hrdle/hrdle/issues/459).

## What is different about it

Everything on these screens was written by the steward, for the glasses. The
other app scrapes a terminal and decides for itself what deserves a panel; this
one lays out sentences that arrived complete. That is why it is a third of the
size, and why whole categories of code are absent: no choice-key walk, no
`present` judgement, no blocked detection, no recap fallback.

Six screens:

| | |
|---|---|
| `overview` | every session, one line each, in the server's order. Root |
| `session` | that session's history as the steward wrote it, newest first |
| `ask` | a question, in one of three answering modes |
| `report` | what is stuck, and nothing else |
| `voice` | record, transcribe, confirm - from any of four entry points |
| `direct` | one pane's own conversation, one step down inside a session |

`direct` is the one screen the steward does not write, and it is still not the
terminal: a pane's output is escape sequences and a redrawing spinner, and seven
lines of that is unreadable. It shows the same information in the format the
other glasses app arrived at - `$` for the wearer's turn, one reserved line per
tool call saying what the call was about, Markdown unwrapped - carried over in
`conversation.ts`. What the pane paints is used only as the signal that the
transcript has moved.

## Running it

```bash
bun run --filter glasses-steward dev      # simulator on :8392
bun run --filter glasses-steward test
bun run --filter glasses-steward build    # the ehpk bundle
bun run --filter glasses-steward pack     # -> out.ehpk
```

The simulator is also served by the backend at `/glasses-steward`, and
`?hub=<url>` points it at another server. **The microphone is real**: it records
and posts to the server's transcription endpoint exactly as the glasses do, so
the whole voice path can be exercised without hardware.

The simulator is part of the implementation, not a bonus. It runs the same
`GlassesController` and the same `updateDisplay()` the device does - the panel
it draws comes from the containers `display.ts` produced, not from a second
layout of the same strings. Check here, release, then check on the device.

## The two-apps period

Both apps can be installed at once, and they do not share a channel:

- `Hrdle` subscribes to `subscribe-glasses-relay` (v1: blocked detection,
  scraped choices, an agent's own `hrdle glasses` note)
- `Hrdle Steward` subscribes to `subscribe-steward` and nothing else

So a hook notification reaches the old app and a steward `ask` reaches this one.
Where they can collide is a question the steward asks about a pane that v1 has
also detected as blocked: both would be on screen, in two apps. Deciding what
counts as "the glasses are present" while two apps can claim it is open - see
#459.

## The address

Read from the host's store under the same key the other app writes
(`<storagePrefix>url`). Whether the host keeps one store per package is not
something this side can see, and the shared key answers both cases: if it is
shared, an address already set up over there is simply here; if it is not, the
phone screen asks for one once.

That screen is deliberately not the other app's setup wizard - seven screens
about installing a server, to somebody who has been reading their steward's
messages on a phone all week. It is one field, `resolve-host.ts`, and a check
that the server on the other end has a steward switched on.
