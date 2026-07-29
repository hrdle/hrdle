# Hrdle Glasses

The Hrdle client for the EVEN Realities G2 smart glasses (built on the EvenHub
SDK, `com.hrdle.glasses`). It connects to a Hrdle server and puts the session
list, the conversation and the answer to a question on the glasses' display,
with a companion UI on the phone.

"Glasses" is only here to tell this apart from the server inside the repository.
Every name that faces outward — `name` in `app.json`, what the screen says, the
app's name on EVEN Hub — is the same `Hrdle`.

## What it does

- Three modes: the session list (with status indicators), the conversation view
  and choice (answering an AskUserQuestion)
- Subscribes to `sessions-updated` over the `/ws/mux` WebSocket and receives
  terminal output (ANSI and non-ASCII are stripped before display)
- Fills in the rest over REST (`/api/sessions`, `/api/dashboard`, conversation
  fetches)
- The server URL lives in localStorage (`hrdle-url`). The key is composed from
  `storagePrefix` in `identity.json`, and older prefixes are consulted only when
  reading (`src/storage.ts`)

## Layout

- `src/main.ts` — app state, mode transitions, paging
- `src/display.ts` — drawing on the G2 display. Measured on the device: a
  576x288 drawing area, and a body of 7 rows at 52 half-width characters per row
  (CJK wraps at roughly 1.86x the width)
- `src/ws-client.ts` — the `/ws/mux` client
- `src/api.ts` — the REST client
- `src/phone-ui.ts` — the companion UI on the phone
- `src/types.ts` — types and formatting helpers
- `src/storage.ts` — how localStorage keys are spelled, and reading older ones

## Building and shipping

```bash
bun run build       # for the device (--mode device) -> dist, the ehpk's contents
bun run build:web   # for a browser (base=/glasses/) -> dist-web, served by Hrdle
bun run pack        # evenhub pack -> out.ehpk
bun run typecheck   # tsgo --noEmit
```

Upload the resulting `out.ehpk` to EVEN Hub to ship it (the `/glasses-upload`
skill automates build through upload). The version is managed by `version` in
`app.json`.

There are two builds because the ehpk needs root-relative paths while the
server-hosted copy lives under `/glasses/`. The background photo in `public/` is
not needed on the device either, so `--mode device` excludes it (`publicDir` in
`vite.config.ts`).

## Browser simulator

Shows the screen without the device. With Hrdle running it opens at `/glasses`.

```
https://<host>:5924/glasses
https://<host>:5924/glasses?bg=<image URL>   # replace the background
```

It goes through the same `screenText()` the device does and draws onto a 576x288
canvas quantized to 16 levels, so wrapping, the line limit and the sense of
resolution all match the device. "Copy screen" takes the whole thing as framed
text.

The default background is `public/scene-meeting.jpg`. Source:
[Unsplash](https://unsplash.com/photos/a-group-of-people-sitting-around-a-conference-room-LJ8vdm37J7Y)
(by Walls.io, Unsplash License — commercial use allowed, no attribution
required), cropped to 1152x576 for the display's aspect ratio. If it cannot be
loaded, a room drawn in CSS takes its place.

## Note: types are duplicated from shared/types.ts by hand

This workspace does not import `shared/types.ts`; it keeps a copy of the types it
needs in `src/types.ts`. When the backend changes the WebSocket protocol
(`MuxServerMessage`, `ControlServerMessage` and friends), `src/ws-client.ts` and
`src/types.ts` have to follow, and the ehpk has to be rebuilt and promoted to
Beta on EVEN Hub.
