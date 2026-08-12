# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- **The text row of a multi-select opens the microphone.** It never had. The
  test for "this row takes text" sat after the multi-select branch had already
  returned, so on a multi-select a tap ticked a box and stopped there. Recorded
  off the glasses on 2026-08-12: `Type something` tapped, ticked, tapped again,
  unticked, and no dictation either time
- **`Chat about this` is no longer a dead row.** Tapped, the panel did not move
  at all - but the digit had reached the pane, which took the question down and
  opened a prompt. The wearer was left looking at a picker for a question that
  no longer existed, with the only way to say anything now off screen. Same
  cause as above, and the worse half of it: the first failure wasted a tap, this
  one lost the question
- **`Type something` is filled rather than ticked.** On a multi-select it is not
  a checkbox that opens a field once submitted - it *is* the field, and the pane
  fills it from what is typed while its cursor is on that row. Its digit only
  ticks the box, and submitting it that way was measured against Claude Code
  2.1.228 returning an answer with nothing in it: the question came back
  answered and empty. The app now walks the pane's cursor to the row and types
  the transcript in where it stands, with no Enter after it - Enter on a picker
  row toggles it - and stays on the picker afterwards, since the other boxes are
  still tickable and the send row still has to be pressed
  - The walk is worked out server-side and travels as that row's `choiceKeys`
    entry, so the app sends what it is handed and holds no rule about which
    rows are reached how. Which rows are a field travels the same way
    (`choiceFieldRows`) rather than being inferred from the shape of a label
  - Needs one glasses ehpk rebuild, and is meant to be the last for this: what
    the app gained is three branches with no agent's name in them, and the next
    picker that is drawn differently is a reader and a key, both on the server

## [0.3.110] - 2026-08-12

### Fixed
- **A multi-select question reaches the glasses.** None ever had. A
  multi-select adds a `Submit` tab beside the question's own, and a strip with
  two tabs is drawn with the keys that move between them
  (`←  ☐ 機能選択  ✔ Submit  →`) - which the chip pattern, anchored at the
  glyph, did not recognise as the opening bracket of the picker. A claude pane
  that cannot be read raises nothing at all, so the wearer got no options, no
  question and no notice that anything was being asked
- **Every row of a multi-select keeps its description.** They sit at the row's
  own left edge, under the checkbox, rather than indented past the label the
  way a single-pick list draws them, so only the cursor's row kept its own
- The `Submit` button under the last row is no longer read as that row's
  description (`Type something — Submit`)

## [0.3.109] - 2026-08-12

### Changed
- **What every pane reader needs is in one place** (`pane-readers/shared.ts`).
  Each agent's frame stays its own - that is the design - but the things a
  reader has to *know* were being learned separately: four copies of "which row
  opens a text field", three of how a terminal breaks a line, two lists of the
  glyph a cursor is drawn with. opencode's wording had to be added to three of
  the four the day it was found, and the fourth was caught by a failing test
  rather than by anyone remembering it was there

### Added
- **Grok Build's picker can be answered from the glasses.** It agrees with
  nobody about how to draw a row - `1 (○) そのまま残す`, no full stop and no
  bracket, with the description to the *right* of the label rather than under
  it - so the general rule matched not one line of it and a wearer got the
  question with nothing to answer it with. It has a reader of its own now,
  keyed on the frame grok draws around the prompt
- **A choice can carry the key it answers to** (`choiceKeys`). Every other agent
  numbers its rows, so the key is the position; grok writes its own, and its
  free-text row answers to `z` - counting would have sent it a `4` it has no
  option for. Absent, the position is still what goes
  - Needs glasses v0.0.70

## [0.3.108] - 2026-08-12

### Fixed
- **The screen recording never carried the build that drew a frame.** The app
  has sent its version on every frame since the field was added; the server's
  own schema did not list it, and zod strips what a schema does not name -
  silently - so every one of them was deleted before the frame was recorded.
  Found on 2026-08-12, when a recording could not answer whether the app on a
  face had been updated, which is the question the field exists for
  - Third regression of this exact shape (`pane-demands`, `zoom-pane.zoomed`
    were the others): a sender doing its job and a schema quietly throwing the
    work away. Adding a field to the TypeScript interface is half the work, and
    the half that compiles

## [0.3.107] - 2026-08-12

### Changed
- **The row that opens a text field is answered by speaking.** Every agent draws
  one - claude's `Type something.`, kimi's `Other` and its `Reject with
  feedback`, opencode's `Type your own answer` - and every one of them was
  dropped before the item was built, on the reasoning that the ring has no
  keyboard. The glasses have a microphone. The row a wearer wants when none of
  the options fit was the one always taken away from them
  - They travel with the item now, marked (`choiceFreeText`). Picking one sends
    the key that opens the pane's own field and goes straight to dictation -
    fewer gestures than any other way of saying something to a pane
  - Needs glasses v0.0.69
- OpenCode asks questions, which is worth writing down: it has no
  `AskUserQuestion` tool, so nothing here expected one, and its picker had never
  been captured. The general read handles it correctly - numbered rows, their
  descriptions under them, the whole framed with the left rule

## [0.3.106] - 2026-08-12

### Added
- **Kimi's trust prompt can be answered from the glasses.** It numbers nothing
  - `❯ Trust this folder` / `Don't trust`, each with a description under it -
  so every reader before this one found no options and a wearer was shown the
  question with no way to answer it. The rows are reachable all the same, by
  walking kimi's own cursor and pressing Enter, which is the path OpenCode's
  permission row has used since 0.3.64
- kimi has a reader of its own now, covering both the shapes its record knows
  nothing about: the trust prompt and the approval prompt. What is read is the
  layout - a rule around it, the question on top, the options at a deeper indent
  than the prose between - rather than the shape of any one row
- `hrdle glasses` (and `POST /api/glasses/relay`) take `choiceDetails`, so an
  agent posting its own question can say what each option means. Index-aligned
  with `choices`; a mismatched length is refused rather than shifted

## [0.3.105] - 2026-08-12

### Fixed
- **Kimi's approval prompt lost the option the pane was sitting on, and every
  digit after it moved up one.** Its cursor is U+25B6 and the glyph list had
  U+25B8, a different triangle - so `▶ 1. Approve once` failed to match while
  the three rows below it did. A wearer picking `Reject` off the glasses would
  have sent `2`, which is `Approve for this session`: the file written and the
  session approved, by someone who chose to refuse. Measured against a live
  kimi 0.34.0 pane on 2026-08-12
  - The glyphs are one list now, deliberately generous. A glyph no agent uses
    matches no line; a missing one silently rewrites an answer, which is the
    second time that has happened (codex's `›` on 2026-08-07)
  - The same marker in front of a question is dropped from it, so the wearer is
    asked `Write this file?` rather than `▶ Write this file?`

## [0.3.104] - 2026-08-12

### Changed
- **One reader, not two.** The glasses app kept its own reading of the terminal
  buffer, used whenever the server sent no options - and that second reading is
  what actually served a wearer a `grep` listing and a paragraph of prose as
  menus on 2026-08-12. Two readings of one screen is a thing only one of them
  can be right about, and the one on the device could not be told which agent it
  was reading or shown a fixture without a release
  - It is gone, with the buffer it needed and the fields the server sent to feed
    it. Where the server reads no options, the tap opens the microphone: a
    question without its options can still be answered by speaking, and that is
    the honest failure - the wrong options are answered, a missing picker is
    only noticed
  - The server no longer opens an agent's transcript once per waiting pane per
    poll to fill those fields
  - 613 lines and 4.7 KB of the bundle went with it

## [0.3.103] - 2026-08-12

### Changed
- **A pane's question is read the way that pane's agent draws it.** There was
  one reader for all of them: find lines beginning with a number, take the
  longest run, call it a menu. Nothing about a numbered line says whether it is
  an option or a listing, so it could not tell them apart - and on 2026-08-12 it
  offered a wearer two lines of a `grep` (`71` / `const INFO_TTL_MS =
  5 * 60_000;`) and, an hour later, four options Claude had written out in prose
  with nothing being asked
  - Claude's picker draws its own frame - a chip per question above, `Enter to
    select` below - and that frame is what is read now. Prose cannot forge it
    and a listing has neither half. Three separate patches fall out of it: the
    preview panel drawn beside the options, the rows that move between tabs, and
    the full-width question mark are all answered by reading the frame instead
    of the rows
  - **An agent with no reader gets no options** rather than the general rule. A
    guess offered to someone wearing the glasses costs more than a question
    shown without its options: the guess is answered, the omission is only read.
    kimi keeps its record and opencode its colour read; both are readers of
    their own
  - The blast radius is per agent now. Claude's preview panel arriving broke the
    reading of every agent's options at once; it would now break Claude's
- Permission prompts are unchanged, and still identified by their own wording
  rather than by their shape - they are the most frequent thing a wearer answers

## [0.3.102] - 2026-08-12

### Fixed
- **Junk options on the glasses, twice over.** Both reported from the device on
  2026-08-12, and both were this side telling the app something untrue
  - **A busy session was reported as waiting.** `waitingToolName` is read off
    the transcript, where a record mid-turn always stops on some tool, so
    `PendingTool` was reported continuously for a session herdr called
    `working`. Everything downstream reads that field as "is it waiting", so a
    tap on a busy session scraped its pane for options instead of opening the
    microphone - and offered two lines of a grep listing as a menu (`71` /
    `const INFO_TTL_MS = 5 * 60_000;`). It is reported only while herdr says the
    pane is blocked
  - **A question ending in a full-width `？` was not recognised as one.** Only
    the ASCII mark was listed, so a Japanese question read as `unknown`, the
    relay declined to send its options, and the glasses fell back to scraping
    the pane themselves
  - **A preview box drawn beside the options is no longer read as part of
    them.** Claude Code's picker puts a panel to the right of the list, sharing
    rows, so each label carried a wall of box-drawing. Cut at the column
    boundary - two spaces before a border - so a rule drawn tight against a word
    stays with it

## [0.3.101] - 2026-08-12

### Fixed
- **A choice's description is sized to the space it will be drawn in.** The
  width was flat, and the picker's space is not: the option rows take one line
  each and cannot be given up, so what is left over is whatever they leave.
  Measured on the device - a three-option question wasted two of the four lines
  it had, while a five-option one was cut by the app instead. It is computed
  from the number of options now (and from the multi-select's send row, which
  the app adds and the server has to anticipate), and a list with no room left
  is sent without descriptions rather than with ones that cannot be drawn
- Text cut for width says so. It was cut in two places - here, with an ellipsis,
  and on the device by dropping whole lines, which ends a description
  mid-thought while it still looks finished. The width sent is a little short of
  the space so the visible cut is the one that happens

## [0.3.100] - 2026-08-12

### Fixed
- **The choices reached the glasses but could not be read.** A picker row is one
  line and the panel cuts what overruns it, and an option arrived with its
  description glued to its label after a dash - so every row ended in an
  ellipsis a few characters in, and the part that decides between the options
  was the part that never arrived. Reported from the device on 2026-08-12: the
  choices appear, but the information needed to choose does not
  - The label and the description travel apart now (`choiceDetails`), and the
    picker draws the highlighted option's description under the rows. Three
    options take three of the panel's eight lines: it had been drawing three cut
    rows into a screen more than half empty. Moving the ring reads the next one
  - The overlay gains from the same split. A question with three options used to
    show one of them, truncated; all three fit as labels
  - An app older than the field shows the labels alone, which is at least whole

## [0.3.99] - 2026-08-12

### Fixed
- **`hrdle stt-prompt` dropped its words when a flag came first.** The text was
  only read immediately after the command, so `stt-prompt --replace "..."` and
  `stt-prompt --session w2H "..."` printed the current value and exited 0
  without writing - a write command reporting success by showing the thing it
  had not changed. A bare word is now the command's text wherever it sits

## [0.3.98] - 2026-08-12

### Changed
- **A new workspace takes a copy of the glossary and stops sharing it.** From
  creation its vocabulary is one list it owns, so terms it will never say can
  be deleted - which a shared layer cannot offer. Workspaces that already exist
  keep taking the shared glossary at composition time, and `--no-glossary` is
  how one of them opts out wholesale. A term added to the glossary on new
  evidence therefore reaches new workspaces only, which is the trade the copy
  is for
- **`hrdle stt-prompt` adds to the list instead of replacing it**
  (`--replace` swaps it). A vocabulary is a list that grows, and with a seeded
  copy the old behaviour turned one forgetful write into a workspace silently
  losing every glossary term it had - nothing in a transcription shows it, the
  words just stop being recognised. Adding happens inside the metadata lock, so
  two agents adding at once cannot drop each other's word
- An add that would pass 190 characters writes nothing and reports what it
  would have been, rather than truncating to fit

## [0.3.97] - 2026-08-12

### Fixed
- **A question sat behind a two-line banner for ten minutes while its wearer
  read the very session asking it.** Three separate faults, all in the path a
  decision takes to the glasses. Measured on 2026-08-12 against a live blocked
  pane; the screen recording counts what it cost - 426 questions presented on
  08-10, three on 08-11, none at all on 08-12
  - **Which items take the screen is the server's decision now, not the app's.**
    The app decided it from its own mode, and decided it backwards: a new
    question interrupted only the session list, while a completion notice
    interrupted the conversation too. So the thing needing an answer interrupted
    less than the thing reporting one. Every past correction to that rule cost
    an ehpk build and a store review, which is why the wrong one stayed shipped;
    it travels on the item as `present` now, and the app is left with the single
    judgement only it can make - never to take the panel from someone
    mid-utterance or mid-pick
  - **Claude Code 2.1.227 stopped writing `AskUserQuestion` to the transcript
    until the answer comes back**, so the record hrdle reads for the options
    said nothing was being asked. Since 0.3.88 that answer was trusted to mean
    the pane's numbered rows were the agent's own output, and the choices were
    dropped - measured: a picker on screen for ten minutes with nothing appended
    to the `.jsonl` since a minute before the question. A pane the screen says
    is drawing a picker keeps its options. The tabbed-picker rows the record
    used to rule out (`Next`, `Submit answers`, `Cancel`) now rule themselves
    out: a list carrying one has miscounted the options above it
  - **The question was the row the wrap ended on.** A wearer was asked
    `うしますか?` - the tail four characters of a question wrapped over three
    rows. The wrap width was assumed to be 60 columns and the pane's own width
    was what had been in mind; claude's picker draws inside a box and wraps at
    54, so the join never fired. It is measured from the lines themselves, and
    a CJK seam is rejoined without the space a Latin one needs

## [0.3.96] - 2026-08-12

### Added
- **A workspace can decline the shared glossary.** The glossary is the words
  this product is made of, and the composer holds half the 190-character prompt
  for it so that one group cannot fill the line. A workspace whose subject is
  not this product cannot spend that half: measured on the health-and-cooking
  workspace, its own 18 terms filled 90 of the 95 it was allowed - five
  characters short of adding another - while 96 characters went to nineteen
  development terms never spoken there
  - `hrdle stt-prompt --no-glossary` stores the decision against the workspace,
    beside its theme, and the session's words then take the whole 190.
    `--glossary` takes it back
  - The glossary stays shared. It is curated from measured transcripts, and
    that loop only exists while there is one list

### Fixed
- The stored session prompt was capped at 100 characters, below what
  composition would take from it and invisible from the preview. It is the
  whole line now

## [0.3.95] - 2026-08-12

### Fixed
- **A laptop nobody had touched still took the glasses to a workspace finished
  five days earlier.** 0.3.93 told a person picking a device up apart from a
  socket reconnecting by remembering, per device, what that device last said
  about itself - and it kept that memory in the server process, so a restart
  emptied it and every client reconnecting after a deploy looked brand new
  again. Measured on 2026-08-12: ten minutes after the 0.3.94 restart, w4H
  again, the twelfth such switch in two days
  - The page is the only party that knows whether it was opened or merely
    reconnected, so it now says which. A declaration from a page someone just
    opened claims the focus; the same page saying hello again on a new socket
    claims nothing, and neither does a client too old to say which it is - a tab
    open since before this shipped being precisely the one at fault
  - Picking a device up still claims, watched on the live connection rather than
    inferred from one that ended
  - Every claim is now logged with the message that minted it. Three fixes in,
    the screen recording could say a laptop had taken the glasses but never by
    which path, and the two paths are one message apart

## [0.3.94] - 2026-08-11

### Changed
- **Comments carry non-obvious why, and nothing else.** A rule in CLAUDE.md, and
  the codebase brought in line with it: not what the code plainly does, not
  change history, not issue references. Length is not confidence - padding an
  uncertain passage reads as certainty to whoever reads it next, and the place
  to say "this part is unverified" is the PR description. Docs and README follow
  the same rule: a snapshot of the current specification
  - 255 issue references out of comments, JSDoc, JSX comments and test names.
    Cross-project references stay - an upstream bug a workaround depends on is
    the constraint itself, not our tracker
  - Dated incident logs in CLAUDE.md and the skills rewritten as the constraints
    they were evidence for
  - `HANDOFF.md` deleted. It recorded a finished migration; the three
    operational facts in it that were written down nowhere else moved to
    CLAUDE.md's debugging section
- **Migration code expires after a week.** Also a rule in CLAUDE.md. A week is
  long enough for every install and every browser to come through; past that a
  compatibility path is dead weight everyone working around it still has to
  read. So a migration is written to be removed, and removing it is a deletion
  rather than an untangling
- The old product name is gone from the code: 211 occurrences in comments, event
  names, globals, environment variables and test fixtures. Two localStorage keys
  written by hand now go through `storageKey()`, and the hook command shown in
  the UI comes from `identity.json` instead of a literal

### Removed
- Seven expired migrations: the legacy localStorage prefixes and their
  copy-forward, the `{snapshots:[...]}` usage-history format, the `qr` command
  alias, the bare-session-id normalisation and the stored pane-tree upgrade,
  `CCHUB_PASSWORD`, and the Codex `config.toml` hook migration. Writing
  `hooks.json` is not a migration and stays, as `installCodexNotifyHooks`
- Spec Kit. `specs/` was empty, `.specify/feature.json` pointed at a directory
  that never existed, and its constitution recorded decisions about a TUI
  deleted with its implementation. `.specify/` and the ten `speckit-*` skills go
  together - the skills cannot run without the scripts

### Fixed
- The e2e specs seeded the old localStorage keys and relied on the copy-forward
  that is now gone. `bun run test` does not cover them, so this was invisible

## [0.3.93] - 2026-08-11

### Fixed
- **The glasses still left the session being read for one nobody had touched.**
  A resumed subscribe stopped claiming the focus in 0.3.87, and a claim without
  a heartbeat behind it stopped counting in 0.3.88 - but a page declares its own
  device the moment its subscription is confirmed, one message behind that
  subscribe, and on a socket that has no memory of the device it belongs to.
  Every reconnect therefore read as someone picking the device up and re-claimed
  what the subscribe had just declined. Measured on 2026-08-11 with both earlier
  fixes running: nine claims from one desktop between 08:51 and 13:07, eight
  from one phone between 11:52 and 12:10, in bursts a minute apart, each ending
  in a heartbeat lapse and the next reconnect starting another
  - A device's declared visibility is now remembered against its stable device
    id, so hidden -> visible is told apart from a socket saying hello again
  - And a connection that has not been claimed by a person - nobody opened a
    session on it, nobody picked it up - no longer stands in the election at
    all. Being the only screen awake used to be enough to win it, which is what
    carried the wearer to a workspace finished days ago while the phone was in
    a pocket. Nobody qualifying leaves the glasses holding what they were
    showing, and one act on any screen brings that screen straight back

## [0.3.92] - 2026-08-11

### Added
- **A transcription is now recorded with the model and the vocabulary prompt
  that produced it.** The screen recording is the only measurement of speech
  recognition there is - the audio is never stored, so a model can only be
  judged by reading transcripts back - and a transcript did not say which
  model wrote it. Comparing `whisper-large-v3` against turbo rested on
  remembering when the setting was last changed, which is not a measurement
  - The line sits beside the confirm frame that shows the result and carries
    the model, the language, the prompt as sent and where it came from, the
    session, the audio length, and the text. The pre-correction text is kept
    only when `stt-corrections` changed something, which makes "is that table
    still earning its place" answerable from the same file
  - A failed request is recorded too. It spent quota and it still says what
    was asked for
  - It follows the recording's own switch (`HRDLE_GLASSES_RECORD`, off by
    default), because it holds the same speech the frames already do

## [0.3.91] - 2026-08-11

### Fixed
- **Every tap on the virtual keyboard logged an error.** React registers
  `touchstart` as a passive listener, so the `preventDefault()` the key handler
  called was ignored and Chrome logged `Unable to preventDefault inside passive
  event listener invocation.` each time. The keys now carry `touch-action: none`,
  which is what actually stops a finger sliding off a key from scrolling the
  page - the thing the ignored call had been there to do
  - The same dead call is gone from the selection handles and the pane divider.
    Both already had `touch-action: none` in CSS, so only the console noise was
    real there
  - `preventDefault()` on **mouse** down stays: it keeps a key from taking focus
    away from whatever is being typed into. So does the one on `touchend`, which
    is not passive, does work, and is the only thing suppressing the synthesized
    mouse events that would otherwise send every character twice
  - Found on a tablet over the Chrome DevTools Protocol. It never appeared in
    `/tmp/hrdle-browser.log` because Chrome reports it through the Log domain
    rather than as a page `console.error`, so the frontend's own log forwarding
    could not see it

## [0.3.90] - 2026-08-11

### Fixed
- **A peer that is offline is no longer dialled.** The peers poll already
  reports `status: "offline"` alongside `errorMessage: "unreachable: ..."`, but
  the session watcher opened a WebSocket to every peer regardless. Each attempt
  cost a full TCP timeout - around 30s over Tailscale - and the backoff caps at
  60s, so a peer that had been down for hours kept a CONNECTING socket alive
  most of the time and logged `[control-mode] Error: WebSocket connection error`
  every time one expired. Found by attaching to a tablet's Chrome over CDP: it
  was still dialling a Mac whose `lastSeenAt` was twelve hours old. The watcher
  now skips peers reported `offline` and reopens as soon as the 5s poll says one
  is back. `unauthorized` and `unknown` still connect - the first is refused
  immediately rather than timing out, and the second is what a fresh poll looks
  like

## [0.3.89] - 2026-08-10

### Changed
- **A phone shows both usage cycles side by side too.** 0.3.85 put the 5-hour
  and 7-day charts in one row from 32rem of card width up, which a phone in
  portrait never reaches - and it is the width where the row is worth the most,
  since the card there costs most of a screen. The threshold is 20rem now, in
  rem so that raising the UI scale moves it with the text

### Fixed
- **The chart's axis labels no longer shrink with the column.** Text in an SVG
  scales with its viewBox, so the 300-wide box drawn into a half-width phone
  column rendered `100% / 50% / 0%` and the `now / reset` pair at around 4px -
  present, unreadable. The box now follows the width the chart was actually
  given, up to the 300 it always had, so the labels land near the size they
  were drawn at. Nothing at 300px or wider changes, which is every layout that
  existed before the two cycles could share a row

## [0.3.88] - 2026-08-10

### Fixed
- **The glasses no longer follow a laptop that is asleep.** A client's `visible`
  flag is its own word for "a person is looking at this", and a closed lid keeps
  saying it: the restored tab stays foregrounded and the claim stands until the
  socket is reaped, which is a 60s timeout checked every 30s. Measured on
  2026-08-10 from the screen recording: a Mac woke for a few seconds, its
  restored tab claimed a workspace finished days earlier, and 51 seconds later -
  13 seconds after the wearer last touched the glasses - the G2 left the
  conversation being read for it. The same claim landed 17 times that day and 53
  times on 2026-08-08, at 00:08 and 01:19 among them, from a lid that was shut
  throughout. A claim now needs a ping within 25s behind it; clients ping every
  10s, so a screen someone is at keeps its place and the next ping restores one
  that lapsed
- **A multi-question AskUserQuestion no longer collapses the glasses picker**
  (#267). The waiting item's choices now come from the agent's own record for
  Claude and kimi panes: the options as the call wrote them, in the pane's own
  numbering, with a checkbox on multi-select rows. A call carrying several
  questions is matched to the tab the pane is showing by its painted question
  text; when the pane names no tab, the question travels without options rather
  than with someone else's. Previously the screen scrape was the only source,
  and on a tabbed call it served the description block, the `Next` row and
  finally `Submit answers` / `Cancel` as answers - the recorded incident
  submitted two of three questions and skipped the multi-select entirely
- **A Claude pane that is asking nothing can no longer produce a picker.** With
  the record saying no question is open and no permission prompt on screen,
  numbered rows in the pane are Claude's own output - a code listing, a
  markdown list, the wearer's queued message - and were still served as
  choices (`4` / `DANDORI_TOKEN: string`, observed the same day). Permission
  prompts keep the scrape: no record carries them
- **A recorded multi-select opened as a single pick on the glasses-local
  path.** The record's options carried no checkbox, which is the mark
  `looksMultiSelect` reads, so one digit closed the picker mid-selection

## [0.3.87] - 2026-08-10

### Added
- **The dashboard says which versions this machine is running, and whether they
  are current** - Hrdle's own and herdr's, on every server card. Previously the
  only version anywhere was a grey `v0.3.86` in a corner of the settings row,
  and nothing at all said whether it was the published one (#259)
  - herdr's newest release comes from the manifest herdr itself updates from
    (`herdr.dev/latest.json`), cached six hours; Hrdle's from its own GitHub
    releases, the same lookup `hrdle update --check` has always done
  - An unreachable network reports the installed version and no verdict, rather
    than claiming either answer

### Fixed
- **The "update herdr" button could never install anything.** It ran `herdr
  update` while the server was still running, and herdr refuses to replace the
  binary while any server answers its socket - by printing `Herdr was not
  updated.` and **exiting 0**. So the button downloaded the release, discarded
  it, restarted every pane PTY, and reported success. Measured on this machine:
  fifteen workspaces and eighteen agents restarted, one of them mid-turn, to
  install nothing (#260). The order is now stop, update, start
  - The result is verified rather than inferred from an exit code: if the
    version on disk did not move, the apply fails and shows what herdr actually
    said
  - **With nothing to install, nothing is restarted.** The old path ran the same
    two commands on every press regardless
- **A newer herdr no longer goes unmentioned.** The check compared the binary
  against the running server and nothing else, so with both on the same old
  version there was no warning and no button - which is exactly the state a
  machine sits in between updates (#259)
- **The terminal no longer looks hung after herdr restarts.** Every pane PTY is
  re-created, and nothing told the browser: it kept showing the last frame of
  processes that had ceased to exist, ignoring input, until someone reloaded the
  page. The restart is announced while it happens and the panes are re-subscribed
  when it ends (#261)

## [0.3.86] - 2026-08-10

### Changed
- **You can now ask what is being sent to the transcription service, and get
  an answer.** A request carries four values - the key, the model, the language
  and the vocabulary prompt - and each used to come from its own function with
  its own precedence rules. The request existed as one thing only for the
  length of one `fetch`, so "what is this session sending" had no one to ask:
  the answer meant reading four files and reassembling them in your head, and
  twice in one day that produced a confident wrong diagnosis
  - One resolver decides all of it, and `GET /api/glasses/stt-preview?session=`
    serves exactly what it returns - model, language, prompt, where each came
    from, and which vocabulary group contributed which term. The transcription
    endpoint calls the same function, so this is the sent value rather than a
    second guess at it
  - `hrdle stt-prompt` with no arguments now prints that alongside the
    session's own words. What was set, and what it turned into
  - The settings screen no longer shows an "effective prompt". It never was one
    - that screen has no session, so the line it showed left out the words of
    whoever is speaking - and the name is what sent an afternoon after a
    per-session vocabulary bug that did not exist. It shows the line it can
    honestly show: the one every session shares
  - The API key is not in the preview. It is write-only and stays that way
- **The shared-words field is gone, replaced by a switch.** It sat between the
  session's own words and the glossary and was squeezed thin by both: a word
  said always belongs in the glossary, and a word about to be said is the
  session's to write with `hrdle stt-prompt`. It was empty from the day it
  shipped except for the five days a leftover `off` in it silently disabled the
  whole vocabulary prompt. Switching the bias off was the one thing it was
  really used for, so that is now what it is: a switch, reachable from the
  glasses, with the line it would send shown under it. An `off` left in the old
  field is carried over as "off" - nobody's deliberate silence gets switched
  back on by an update

## [0.3.85] - 2026-08-10

### Changed
- **The two usage cycles sit side by side once the card is wide enough.** The
  5-hour and 7-day charts were stacked at every width, so on a tablet the card
  spent a screen and a half on two lines that each used a third of their own
  row. They are SVGs with a viewBox, so half the width costs pixels and nothing
  else
  - The switch is a container query on the card, not a viewport one: the same
    card also renders in the 480px dashboard side panel, where two columns
    would be worse than one. Below 32rem of card width it stacks exactly as
    before
  - A plan with only one of the two cycles (Codex's free tier has no 5-hour
    window) keeps the single chart at full width rather than leaving half the
    row empty

## [0.3.84] - 2026-08-10

### Added
- **The transcription model can be switched from the dashboard and from the
  glasses settings screen.** It became a setting in 0.3.83 but only over the
  API, which meant a curl on the host that runs the server - fine for trying it
  once, wrong for a choice that is answered by listening for a few days and
  changing your mind
  - The dashboard's Groq card carries the select, since that is where the
    consequences already are: requests, audio and remaining quota are on the
    same card
  - The glasses screen fills its options from the server's own list rather than
    hardcoding them, so it cannot offer a model the server would reject

### Fixed
- **The dashboard was naming the wrong model.** The Groq card's model label was
  a constant, so it read `whisper-large-v3-turbo` whatever was actually in use -
  including right after switching away from it
- **A cost is no longer shown for a model this server cannot price.** The
  estimate was always at the turbo list rate; with the model switchable that
  figure would be silently wrong rather than merely approximate. Only the model
  with a rate written down gets a number, and the others show a dash - never
  `$0.00`, which reads as free

### Fixed
- **Speech no longer comes back as `ハーダー`, and silence no longer comes back
  as `ご視聴ありがとうございました`.** Both were measured rather than guessed:
  the glasses screen recording keeps every frame it drew, and the voice
  screen's `[confirm]` frame *is* the transcript, so the eight days to
  2026-08-09 read back as 1030 real utterances
  - `herdr` had been in the vocabulary prompt the whole time and arrived as
    `ハーダー` ten times and as `herdr` never once - the model heard it
    correctly and simply wrote it the ordinary Japanese way, which a prompt has
    no say over. Same for `issue` (`イシュー`, 23 times), `Codex` and `Claude`.
    Spelling is now repaired after the fact in `stt-corrections.ts`, where it is
    a lookup rather than a hope
  - Whisper fills silence with whatever its training data put after silence,
    and for Japanese that is a video sign-off. Those are matched as the *whole*
    transcript only: as a substring the same words are ordinary speech, and
    cutting them out of a real sentence would be the worse failure

### Changed
- **The STT glossary is now the words that are actually spoken.** Fourteen of
  its thirty-four terms were never said once in those 1030 utterances
  (`リベース`, `プルリクエスト`, `コンフリクト`, `リント`, `タブ`, `タグ`,
  `エラー`, `ログ`, `バグ`, `リファクタ`, `スクショ`, `Kimi`, `Grok`) and were
  holding budget inside a 190-character cap. The terms that are only ever
  misspelled rather than misheard left too, since the correction pass handles
  them now
  - `ペイン` went with them for a third reason: it is what the code calls a
    pane, not what anyone says out loud. `パネル` came back eleven times and
    `ペイン` never, so the glossary carries the spoken word
  - The freed budget went to terms the recording shows being said, including
    `音声認識` - which had been coming back as `温泉式`

### Added
- **The transcription model is a setting.** It was hardcoded to
  `whisper-large-v3-turbo`; Groq also offers `whisper-large-v3`, which trades
  speed and cost for accuracy. Which one suits this user's voice is not a
  question anyone can answer from here, so it is switchable and can be answered
  by listening. A closed set of models, because an unknown one is a 400 on
  every utterance and the wearer would only see "STT provider error"

## [0.3.82] - 2026-08-09

### Fixed
- **iOS: the soft keyboard no longer paints most of the screen black.**
  Focusing any input on an iPhone covered the terminal with a black band that
  only scrolling would temporarily clear (#219, contributed in #220 by
  @Chapapon)
  - Two corrections were fighting: the app shrinks itself to
    `visualViewport.height`, and iOS *pans* the layout viewport over the page
    on top of that. A script cannot undo the pan, so the fix follows it - the
    app is translated by `visualViewport.offsetTop` and stays glued to the
    visible area, with re-syncs around focus changes because Safari applies the
    pan asynchronously
  - Measured while merging: with the keyboard open, a full-screen overlay now
    covers the visible area rather than the whole screen, which is the better
    of the two behaviours. With the keyboard closed nothing changes at all

## [0.3.81] - 2026-08-09

### Added
- **A URL on the screen can be copied without selecting it.** Claude Code's
  login screen offers `c to copy`, and on this kind of host that key cannot
  work: with no `DISPLAY` the only thing it produces is an OSC 52 sequence, and
  herdr's renderer consumes that before any client sees it - absent from the
  control stream's frames and from `herdr api schema --json` alike, measured on
  herdr 0.7.5. So a 450-character OAuth URL sat on a tablet's screen, wrapped
  over four rows, with nothing but touch selection to get it out
  - A pane's URLs now appear as a chip in its corner, each with copy and open.
    Nothing is shown while the screen holds none
  - Rejoining the wrapped rows is a heuristic, and has to be: Claude Code's TUI
    hard-wraps its own output, so herdr's `recent_unwrapped` read returns the
    same pieces as `visible` - there is no wrap flag left to consult. The only
    join made is a URL ending the last column of a row that is full, continued
    by the leading URL-character run below. Both halves of that test matter, or
    a URL merely ending a short line would swallow whatever came after it
  - An OAuth URL is worth nothing if one character is wrong, so the rule would
    rather truncate than invent. The first thing it caught in the real thing
    was its own blind spot: every row arrives carrying a trailing `\r`, which
    made a full 160-column row measure 161 and stop looking full
  - Asked for upstream as herdrdev/herdr#1459. The OSC 52 handler is kept for
    the day a pane's copy reaches API clients

## [0.3.80] - 2026-08-08

### Fixed
- **A reconnect no longer takes the glasses off the session you are talking
  to.** The glasses follow the screen a person most recently raised, and a
  client replays its subscription whenever its socket comes back - so a tablet
  left open on a desk won that election every time the network hiccuped
  - Measured across a day of screen recordings: 138 focus changes, 44 of them
    to one session, every one of those from a device nobody had touched. The
    phone would claim the session being talked to and the tablet would take it
    back seconds later, over and over
  - The reconnect replay now says so, and the server records the session
    without refreshing the claim. A resumed client stays followable; it just
    does not jump the queue by reconnecting
  - Picking a device up still claims, which is what the election is for

## [0.3.79] - 2026-08-08

### Added
- **A recorded frame says which build drew it.** The screen recording is read
  days later to decide whether something is fixed, and it could not answer
  that: on one morning three glasses builds and three server versions shipped,
  and telling which pair drew a frame meant correlating the file against a
  console line that happened to print the version
  - A frame now carries the glasses build and the commit it was built from, and
    every recorded line carries the server that wrote it - frames, gaps,
    gestures and focus alike. A frame says which pair was running; a gap says
    which server saw the glasses leave
  - The commit is there because a version says which number a build claims, not
    which code it holds: an unreleased build and the packed ehpk answer the same
    number
  - Recordings written before this read back unchanged

## [0.3.78] - 2026-08-08

### Fixed
- **The picker no longer opens on a session that is not asking anything.** It
  opened on a Claude session showing a `Read` result and offered a line number
  and a line of code as the two things to choose between; earlier the same day
  it offered a Kimi question's own tab bar as that question's answer
  - Both came from the same read: one item on a row painted unlike its
    neighbours, which is a guess about pixels. It is the right guess for
    OpenCode, whose permission prompt exists nowhere else, and it has nothing
    to be right about for an agent that writes its questions down
  - Claude records the `AskUserQuestion` call in its transcript and Kimi records
    `interaction.request` in its wire, both with the options and the
    descriptions under them. Those files were already being read here, so the
    question now comes from the agent rather than from the screen
  - A numbered list is still read for every agent: a permission prompt is
    numbered and is in no record at all. Codex, Grok and OpenCode are unchanged
- **A question's options carry their descriptions without being scraped.** They
  come from the record, so there is no indentation rule to get right and
  nothing to truncate by guess

## [0.3.77] - 2026-08-08

### Fixed
- **The summary strip stays out of the way on a Kimi or OpenCode session.** It
  was up permanently, and what it said was the message directly beneath it -
  two of the panel's eight lines spent repeating what was already on screen
  - Claude writes a real summary; the other agents have no such thing, so what
    they send is a copy of their own latest message. That is one useful line on
    a workspace card and nothing at all above the transcript
  - It could not retire itself either: the "is this recap still current" test
    compares it against the newest message, and a recap whose source *is* the
    newest message is never behind
  - Measured across a day of screen recordings: the Kimi session drew the strip
    on 79% of its conversation frames, Claude's on 0%
- **A paged message no longer loses the lines the strip took.** Paging tiled by
  the panel's full height while the body drew what the notice left, so with a
  banner up three lines at every page boundary were on no page at all - a
  three-part answer arrived with the middle part missing and nothing to say so

## [0.3.76] - 2026-08-08

### Added
- **A recording stops when the sentence does.** The 30-second limit closes a
  microphone nobody closed; this closes one that has finished being spoken
  into, which is the ordinary case - you say a sentence and then wait, and
  waiting is what the tap was for. A second and a half of quiet ends it and
  transcribes what was collected, the same path a manual stop takes
  - It does not start until something has been said. Tap, then take a moment to
    think, and nothing happens - being cut off before the first word would be
    worse than the open microphone this exists to close
  - It does not end on a pause. Drawing breath mid-sentence is about a second
    of quiet, so an ordinary pause resets the count rather than ending on it
  - The threshold is deliberately low, because the two ways of being wrong are
    not symmetric: too low and a recording fails to stop itself, which the
    30-second limit catches, while too high cuts somebody off mid-sentence,
    which nothing catches. It may want tuning against the G2's own microphone
    gain, and is one constant
- **The ready screen says which glasses build is installed.** The setup guide
  redeploys whenever a sentence changes; the glasses app is rebuilt, packed,
  uploaded and promoted. So the two are never in step, and the version on the
  phone was the half nobody could see - the card at the end of setup reported
  the server's version, its session count and its API usage, and nothing at all
  about the app doing the asking
  - The app now puts its version and the commit it was built from into the
    greeting it sends the guide, and the guide shows them as one more row. The
    commit is there because a version number says which number a build claims,
    not which code it holds: an unreleased build and the packed ehpk both
    answer the same `0.0.57`
  - Both were already baked in at build time (`__APP_VERSION__` from
    `app.json`, `__BUILD_COMMIT__` from git) and until now went only to a trace
    log nobody reads on a phone
  - The row is left out entirely for an ehpk from before this, which greets the
    guide exactly as it always did. The guide half of it lives in
    hrdle/hrdle-setup

## [0.3.75] - 2026-08-07

### Fixed
- **A Kimi session's conversation is readable again.** Kimi Code 0.34 renamed
  the working directory in its `state.json` from `workDir` to `cwd` and turned
  the timestamps into epoch milliseconds. Hrdle required the old name, so every
  session started since that upgrade was skipped before anything could read it,
  and Chat answered "no messages" about a session holding a full transcript
  - The same blindness stopped the history list at the day of the upgrade, left
    the Kimi usage tab under-reporting, and emptied the first prompt on the
    workspace card
  - Nothing appeared in a log, because a session that cannot be found and a
    session with nothing in it return the same thing
  - Both spellings are read now, so the sessions from before the upgrade are
    still there
- **A question on the glasses says what its options mean.** Kimi writes a bare
  label on each numbered line - `案A`, `案B`, `案C` - and puts what tells them
  apart on the line below it, which nothing was reading. The wearer was handed
  three labels that name nothing and asked to choose between them
  - The description under an option now travels with it, on the notification
    and in the picker, cut to length rather than allowed to run
  - A description the terminal wrapped is put back together the way the
    language wants: latin text gets back the space the wrap consumed, Japanese
    does not get one it never had
  - Each row in the picker is clipped to a single line. An option with a
    description on it is long, and three that wrapped would push the last one
    off the screen it is being chosen from
- **The tab bar above a Kimi question is no longer offered as its answer.** The
  reader that finds options drawn side by side found `intro.lead   Submit` -
  the bar that switches between questions - and opened a picker on it. Tapping
  would have moved to another tab while looking like an answer
- **A session list with nothing in it now says the VPN is off.** Hrdle is only
  reachable over the tailnet, so a phone with Tailscale switched off gets no
  answer from the server - and no answer is exactly what it looked like it had
  got: an empty list, indistinguishable from a machine with no sessions on it.
  The list arrives over a WebSocket that never opens rather than a request that
  fails, so nothing on that path had a failure to report
  - The peers poll is what knows. It already runs every 5s and is the first
    thing to fail when the device leaves the tailnet, so it now carries a
    reachability flag: an HTTP status, even a 500, counts as reached, and only
    a transport failure counts as unreachable
  - Where the list would be blank it now says the server cannot be reached and
    what to do about it, and where the list is still showing what it last
    managed to load it says that too, above the stale rows. The advice names
    Tailscale only when the address the page was served from is a tailnet one
    (a `.ts.net` name, CGNAT, or the Tailscale ULA); anything else gets the
    generic line rather than a guess
  - Coming back is immediate. The session watchers back off up to a minute
    between attempts, so switching the VPN on used to look like it had not
    worked; the first successful poll after a failure now resets that backoff
    and reconnects

## [0.3.74] - 2026-08-07

### Added
- **A recording stops itself after 30 seconds.** Spoken instructions to an agent
  are a sentence or two, so an open microphone is far more likely to be one
  somebody forgot to stop than one still being spoken into - and left running it
  spends the wearer's battery, the upload and Groq quota to produce a transcript
  with a minute of room noise on the end. Stopping transcribes what it has, the
  same as stopping by hand
  - The screen says the number rather than counting down to it. A countdown
    means redrawing the panel over BLE every second for the whole recording,
    which is what the deliberately slow spinner exists to avoid
  - It is disarmed by everything else that ends a recording - a manual stop, a
    cancel, the host tearing the run down - and is not armed at all when the
    microphone refused to open

### Fixed
- **The speech vocabulary is made of words someone chose, not of workspace
  names.** Workspace labels led the prompt sent to Whisper, on the reasoning
  that 「2脚ロボ開発」 is a coinage nothing else can supply. That held while a
  label was a name. The naming convention appends a status suffix (`— 作業中`,
  `— 完了済`) and agents write the reason for an interruption into parentheses,
  so a label became a sentence written for a person reading a list - and
  thirteen of them spent 189 of the 190 characters available. `タブ` was the
  only glossary term that fit; `リリース`, `コミット`, `リベース` and `ペイン` -
  the words reported as being misheard - were all pushed out
  - Labels are gone from the prompt entirely rather than trimmed: nothing stops
    one growing again, and a name written to be read is the wrong thing to ask
    for words about to be spoken
  - What a session is about is now said deliberately. `hrdle stt-prompt "音声
    認識、ハルシネーション"` sets it from inside the session, resolving which one
    it is the same way `hrdle glasses` does, so the agent doing the work can
    keep its own vocabulary current
  - Whatever is set, half the budget stays with the glossary. The failure was a
    group filling the line, and the group that replaced the labels could have
    repeated it
- **A saved vocabulary no longer silently disables everything else.** The
  glasses settings screen wrote a prompt that *replaced* the composed one, and
  outranked `HRDLE_STT_PROMPT` doing it. One left over from a comparison on
  2026-08-02 meant five days of five-word prompts with no glossary, no session
  vocabulary and nothing anywhere saying so - it took a "recognition feels worse
  today" report and a code read to find. What that field saves is now one group
  inside the composed line, ahead of the glossary; replacing outright is left to
  the environment variable, which does not outlive the process that set it.
  `off` from either side still means no bias at all
- **A long recording is no longer cut off at eleven seconds.** `idleTimeout: 60`
  was set inside the `websocket` object, which is the WebSocket idle timeout;
  nothing set the server-level one, so every HTTP request ran on Bun's default
  of 10 seconds. Six speech transcriptions died at it in the two days to
  2026-08-06, each arriving on the glasses as "nothing was recognized". Groq is
  not the slow part - 8 seconds of audio transcribes in ~0.33s from this host -
  so what was being lost was the upload from the phone over the tailnet, which
  means the long recordings on a slow link: exactly the ones worth keeping.
  HTTP requests now idle for 120 seconds, and the leg we do not control, the
  call to Groq, is bounded at 60 inside that so a stalled provider comes back
  as a 502 rather than as the connection dying under the wearer
- **The glasses say which of the two things happened.** A transcription that
  never came back and one that came back empty both read "(nothing was
  recognized)", and only one of them is answered by speaking more clearly. A
  failure now says so, and says the recording was not the problem
  - The simulator was swallowing the error and returning an empty transcript,
    where the device passes the request straight through. That made it the one
    place a cut-off request looked like a recording of silence - the exact
    class of divergence the simulator exists to not have

## [0.3.72] - 2026-08-07

### Fixed
- **A pane that redraws no longer mints questions.** OpenCode's TUI redraws
  constantly and its highlight reads slightly differently across frames, and
  the relay treated every one of those as a new decision - a fresh item with an
  id of its own. On the device that was seven identical permission prompts
  inside 1.3 seconds: answering the first only uncovered the second, and the
  wearer could not get past them
  - The pane's own cursor does have to reach the glasses, because the walk that
    answers such a pane starts from it. But that is an edit to the question on
    screen, not another question. It is sent under the same id now, which is
    how a client is told the difference between "redrawn" and "asking something
    else"
  - The behaviour this replaces was required by a test written the day before,
    so the test was wrong too and went with it

## [0.3.71] - 2026-08-07

### Fixed
- **Codex's options are read, and read whole.** Every agent picked a different
  glyph for the cursor on the selected row - `❯` from claude, `→` from kimi,
  and `›` from codex, which was not in the list. The cost was not the row it
  marks going missing; it was that row going missing while its sibling stayed,
  because `2. No, quit` carries no cursor and matched on its own. So the
  glasses were handed a single option reading `No, quit` - and answering it
  types `1`, which is `Yes, continue`
  - It showed up on the trust prompt, which is the first thing codex draws and
    the worst one to answer by accident: it decides whether project-local
    config, hooks and exec policies load. Measured against codex-cli 0.146.0
  - The class now carries every cursor an agent has been seen to draw, in all
    three readers that have to agree about it
- **A question that wraps is shown whole.** A question long enough to matter is
  long enough to wrap, and the reader took one line of it - whichever fragment
  happened to sit last. Codex's trust prompt arrived as `injection. Trusting
  the directory allows project-local config, hooks, and exec policies to load.`,
  the tail of a sentence whose beginning said what was being decided. Where no
  single line ends in a question mark, the paragraph above the options is taken
  instead of the line above them

## [0.3.70] - 2026-08-07

### Fixed
- **The glasses stop following a browser nobody is holding.** A wearer reading a
  conversation was carried off to a workspace they had never touched, three
  times in one recording, every gesture of their own somewhere else. Following
  the session open on the screen in front of you is the point - you move, the
  glasses come along - but this machine runs several agents that open the web UI
  headlessly to take screenshots, and each of those counted as a person
  - A driven browser now claims no focus at all, decided where focus is decided
    rather than filtered by the glasses, because nothing downstream wants it
    either. `navigator.webdriver` is the signal, which is what it is for
  - Every real screen still counts, desktop included. The device type says where
    you are, not whether you are there

- **A question's tab bar is no longer offered as a set of choices.** Claude Code
  draws `← ☒ 複数選択 ✔ Submit →` above its question, and it is a menu by
  every test the side-by-side reader applies: the arrows carry no letters so
  they are dropped, and of the two items left only the active tab is painted
  differently. A wearer got a picker offering "複数選択" and "Submit" for a
  question that was working perfectly well, and answering it would have walked
  the pane between tabs and pressed Enter somewhere nobody chose
  - A tab carries its state as a glyph because it has one; an option in a row
    of options does not - it is chosen by being chosen. So a row containing a
    checkbox, tick or radio is a set of toggles whatever else it resembles. The
    whole row is refused rather than the item dropped, because the walk counts
    positions along the row the pane draws

## [0.3.69] - 2026-08-07

### Fixed
- **The first question of a set reaches the wearer.** The second one did and the
  first did not, which took a while to see for what it was: `enterBlocked` fires
  on a status transition, and the first question does not always have one - a
  pane holding queued input is already `blocked` when the question appears.
  Answering the first is what finally moved the status, which is why the second
  arrived
  - It had been covered by accident. A blocked pane always produced *some* item,
    even when that was only its status bar read as a question, and the real
    question replaced it when one turned up. Declining to build the junk in
    0.3.68 took away the thing the real question was arriving into
- **Answering says what was sent.** The item belongs to the pane's blocked
  epoch, so the panel does not take it down - the server does, once it sees the
  pane move - and the seconds in between were spent looking at the question just
  answered, which then vanished without naming the choice. Reported from the
  device as not being able to tell whether a pick had gone through. The strip
  now leads with the answer for a couple of seconds: not a claim that the agent
  received anything, only that these are the keys that went. A multi-select
  names everything it ticked rather than the row it sent from

## [0.3.68] - 2026-08-07

### Changed
- **The agent is picked from a list rather than a row of buttons.** Five agents
  no longer fit across the create dialog, so the fifth wrapped onto a line of
  its own - and the row only gets longer as agents are added. A select costs one
  tap more and stays one line however many there are, which on the phone the
  dialog is mostly used from is the trade worth making

### Fixed
- **A pane that is blocked without asking no longer interrupts the wearer.**
  herdr reports `blocked` for the gaps between turns as well as for a question,
  and with no question and no options the scrape fell through to "the last line
  that says something" - which on a live pane is whatever the TUI drew at the
  bottom. `⏵⏵ auto mode on (shift+tab to cycle)` appeared on a wearer's face
  under a `[!] WAITING` header
  - It could not be got rid of. A waiting item claims double-tap on the
    conversation screen, where it means "later" rather than "back", so a
    notification nobody asked for took away the way out - and dismissing it did
    not help, because the next blocked flicker built a fresh, undismissed one.
    The screen recording has twenty-odd double-taps in a row, all landing on
    the same screen
  - A waiting item is now built only when something was recognised: a
    permission line, an option block, or a line that reads as a question. A
    guess is worth showing when something real is already waiting; it is never
    worth interrupting someone for
- **The question is found by where it sits, not by its punctuation.** It was
  looked for by an ASCII `?` or `Do you want to`, and a Japanese question ends
  in neither - `好きな果物を選んでください（複数可）` is a question and says so
  with a verb. So the glasses were shown `❯ ちなみに録画情報を見てください`:
  the line the wearer had just typed into their own input box, handed back as
  the agent's question. An agent writes its question and puts the options under
  it, so the question is the last thing said above the first option, and
  nothing below it can be - which needs no list of question marks

## [0.3.67] - 2026-08-07

### Fixed
- **A session's address stops changing when it is renamed.** Its id was the
  herdr workspace *label* - text a person edits - while herdr's stable
  `workspace_id` sat next to it. The workspace-naming convention has every agent
  rename its workspace at least twice per task, so the address changed
  mid-conversation, by policy: ten spoken replies in a row 404'd against a name
  that had just been rewritten, and the next thing said out loud went to a
  different session
  - The 404 was the lucky half. The lookup took the first label match, so two
    workspaces sharing a name delivered to whichever sorted first and answered
    200 with nothing naming the one that received it. Reproduced on a live
    server before fixing: two workspaces called `dup-test` appeared as two
    entries with one id, and a prompt to that id succeeded
  - The id is `workspace_id` now and the label is what `name` carries. A label
    is still accepted as an address - it is what `hrdle send local:dev:%1` types
    and what an installed ehpk holds - but an ambiguous one resolves to nothing,
    and the two paths that deliver something say which of "gone" and "say which
    one" happened, because only one of them is fixed by naming the session
  - Renaming a session no longer moves its settings. Theme, custom title and STT
    vocabulary were keyed by the same mutable id, so every rename quietly
    abandoned them; six such orphans were sitting in the file on the machine
    this was found on. Entries keyed by an old label are moved onto the
    workspace id at startup, and only when exactly one live workspace carries
    that name - a wrong guess would paint a session in a colour chosen for a
    different one

## [0.3.66] - 2026-08-06

### Added
- **Options drawn side by side are readable from the glasses.** OpenCode asks
  permission before touching anything outside the project and draws the
  question as one horizontal row - `Allow once  Allow always  Reject` - with no
  numbering and no checkboxes, so neither reader saw it. A blocked OpenCode
  pane produced a waiting notification with nothing under it, which is the
  failure 0.3.62 set out to prevent arriving through a door nobody had opened
  - As text that row and the key hints beneath it are the same shape, so no
    rule could admit the first without offering `ctrl+f fullscreen` as an
    answer. As paint they differ: the selected option carries a background of
    its own and every item in the footer shares the row's. The reader works on
    colour, and "exactly one item painted unlike the row it sits on" finds the
    menu, rejects the footer, and names the selection in one stroke
  - That selection is also the only place the pane's own cursor is recorded.
    Reading it on every pass is what makes moving the cursor safe again -
    0.0.52 removed cursor-driving for doing it blind and drifting out of step;
    here the position is measured rather than assumed
  - The movement was measured against a live pane, not read off the footer,
    which says `⇆ select` and is wrong: Tab moves nothing. The arrows move it,
    both ways, and both wrap - so the far end of a row is one press backwards
    rather than several forwards
  - **The notification itself now says something.** Reading the row was only
    half of it: a waiting item is assembled on the server, and OpenCode frames
    every line of its prompt with a rule. Every pattern in the relay's scrape
    anchors at the start of a line and allows only spaces and a cursor glyph
    before what it looks for, so the rule alone made this file blind to that
    agent - and would have, even had OpenCode numbered its options. The
    question fared worse: it ends in no `?` and says no `Do you want to`, so
    the fallback took the last non-empty line and the notification a wearer got
    was one box-drawing glyph
  - The rule is now stripped before any reader sees a line, a line with no
    letter and no digit in it can never be the question, and the two halves
    OpenCode splits its question across (`Permission required`, then what it
    wants permission for) are joined into the one sentence a wearer can decide
    on. The waiting item carries the options, how the pane takes an answer to
    them, and where its own cursor is - a walk needs a starting point, and an
    item that lost it withholds its choices rather than let the glasses guess
  - The coloured read is a second round trip, taken only when the ordinary one
    found no options at all. Every agent that already worked keeps the exact
    read it had

## [0.3.65] - 2026-08-06

### Changed
- **Mirroring the device hides the simulator's own controls.** While the
  mirror shows the wearer's screen, the ring buttons, host lifecycle, demo
  and voice-input controls acted on the local panel hidden underneath it -
  and the ring ones would fight the wearer for the real screen. They
  disappear while the mirror is on (the keyboard shortcuts go quiet too)
  and return when it is off. Server settings, the replay-player link and
  the backdrop stay available

## [0.3.64] - 2026-08-06

### Added
- **OpenCode is a supported agent.** It joins Claude Code, Codex, Grok and Kimi:
  start one from the create modal, see it in the session list with its own
  colour, read its transcripts in the conversation view and its token usage on
  the dashboard. `hrdle setup` installs its herdr integration alongside the
  others, so a resumed session keeps its identity
  - It is the first provider that reads a **database** rather than files.
    OpenCode 1.18 keeps sessions, messages and parts as rows in
    `~/.local/share/opencode/opencode.db`; the reader opens it readonly per
    query the way the Codex reader already does, and an unreadable or
    mid-migration file degrades to an empty list rather than an error
  - Its cost figures are OpenCode's own. Every other agent's spend here is our
    estimate from a price list; OpenCode computes and stores a per-turn cost,
    so the dashboard reports what it recorded. A window with no cost recorded
    shows nothing rather than zero - a free model's genuine 0 is a different
    statement from "unknown"
  - A tool call and its result live in one row there, so the transcript reader
    splits them back apart to the call-and-result shape the conversation view
    pairs up - which means an OpenCode tool call renders as the same single
    card as everyone else's, and a call the user refused shows as the refusal
    rather than as one still running

### Fixed

- **A multi-select question is answerable from the ring, on either agent.**
  0.3.62 fixed following a question that moves and shipped believing the
  multi-step case was closed. It was closed for single-pick lists only. Driven
  against live Claude Code and Kimi Code panes, seven separate faults turned up
  between the scrape and the key that answers it
  - **kimi's multi-select draws no numbers at all** - `[ ] Apple`, four rows,
    not a digit on the screen even though `1-4` still works as a key. Neither
    reader matched a line of it, so the payload came back with no choices and
    the half-drawn-frame guard held the *previous* question: the panel showed
    question one while the pane had moved to question two, which is the exact
    silent failure 0.3.62 set out to prevent. Both readers now take an
    unnumbered checkbox block as the menu it is
  - **The picker drove the pane's cursor with arrow keys**, making it a second
    cursor over the pane's own. They came apart on any redraw, and a
    multi-select redraws on every tick - three swipes in, the panel offered
    `Banana` while the pane sat on `Type something`. Options are now answered
    by their own number, which both agents accept and neither moves its cursor
    for, so there is no second cursor left to keep in step
  - **The send row sent Enter**, which in current Claude Code toggles the row
    under the pane's cursor rather than submitting. It sends Tab now, which is
    what carries both agents on to the next question
  - **A ticked box read back as empty on Claude Code**, which writes U+2714
    where only U+2713 was listed - so the send row counted nothing and a
    wearer's own ticks looked like they went nowhere
  - **The rows the ring cannot answer are dropped in every dress they arrive
    in**: `Type something.` in a single pick, `[ ] Type something` in a
    multi-select, and kimi's `Other:` once it is the field being typed into
  - **A tick shows the moment it is made** rather than a server re-read later,
    and a re-read of the same question no longer sends the cursor home
  - **A tick reaches the panel as a glyph the firmware has** (`[○]`). Both
    agents' check marks were being sent raw, so the device drew tofu on the one
    row a wearer reads to know what they have ticked - while the simulator,
    drawing from a browser font, showed them perfectly
- **A question that changes to one the scrape cannot parse replaces the old
  one.** The half-drawn-frame guard held on the options alone, so a pane that
  had genuinely moved on was left showing the previous question's answers. It
  now holds only while the question itself is unchanged: the right question
  with nothing under it beats the wrong question's options

- **One unreadable file no longer takes the whole dashboard down.** The panel is
  a dozen independent readings gathered with `Promise.all`, which rejects on the
  first member to reject, and the cache in front of it only serves a stale value
  once it has one - so on the first build after a restart, a single throwing
  reading returned an error for `GET /api/dashboard` instead of the panel, and
  kept doing it, because a failed build caches nothing. Every agent's usage
  dark because one provider could not read one file
  - Each reading is now isolated: one that throws degrades to its own empty
    value, is logged with the name of the reading that failed, and the rest of
    the panel renders. The obligation used to sit in each service and had to be
    remembered again by every provider added
  - Two readings could actually do it. Codex's rollout scan guarded every level
    of its directory walk except the top one, so an unreadable `~/.codex/
    sessions` - or a plain file where the directory belongs - escaped. And the
    daily-activity chart checked only that `dailyActivity` was *present* in
    `stats-cache.json`, a file another program writes: anything there that was
    not a list reached `.slice` and threw
- **A tool call naming its file as `filePath` is summarised by its basename.**
  The summary and the result's syntax highlighting only looked for `file_path`,
  `path` and `notebook_path`, so an agent using the camelCase spelling got the
  first 60 characters of an absolute path as its card heading, and no
  highlighting


## [0.3.63] - 2026-08-06

### Changed
- **The glasses recording records the glasses, not the phone.** Which session
  the phone was focused on used to be written all day, glasses or no glasses -
  hours of lines nothing could replay, bookending every file. The replay
  player then opened onto that silence: position 0 was a blank canvas even
  though the day's frames were all there, further in. Focus is now recorded
  only while the glasses are live (between their first frame and the gap
  marker when they go), with one parked focus line flushed just before the
  frame that ends an off-air stretch, so recordings still say what was being
  worked on. A day the glasses never joined gets no file at all

## [0.3.62] - 2026-08-04

### Fixed
- **The option lists the other agents draw are read at all.** The scrape only
  understood claude's `1. Yes`. kimi writes `[1] Yes` with U+2192 as its
  cursor, so nothing was extracted: a blocked kimi workspace produced a waiting
  item carrying the question and no options, the picker never opened for it,
  and a tap fell through to the microphone
  - Both readers - the server's, which scrapes a pane it already knows is
    blocked, and the app's, which scrapes a live terminal buffer - now take
    either numbering, and agree on the rows the ring cannot answer:
    `Type something.` / `Chat about this` (claude) and `Other` (kimi) all open
    free-text entry, which has no keyboard on the glasses. The app dropped none
    of them before, so one pane read two ways produced a picker with rows the
    server's own notice did not offer
  - Verified end to end against kimi-k3: question, next question, the submit
    screen, and the answers landing in the transcript, by ring alone

### Changed
- **`Save PNG` writes the green EVEN's own simulator writes.** EVEN Hub
  rejected a submission with "the color tone of the provided screenshots does
  not match the original display captured from the simulator" - theirs is pure
  green with only the alpha varying, ours was a mint with a bloom behind it,
  251 distinct colours against their 7. Side by side that reads as processed
  - The panel keeps its own green; only the export changes. One is a viewing
    preference, the other is a submission format
  - Layout was measured against the official simulator on the same screens:
    identical line counts, at most 1px of vertical drift and 3px of width over
    lines up to 568px. The browser font was never the problem here

## [0.3.61] - 2026-08-04

### Changed
- **Renaming a session renames its herdr workspace.** The session menu's
  title field used to save a display title of hrdle's own, so the name on the
  card and the workspace label herdr shows everywhere else drifted apart the
  moment either was set. The field now writes straight through to
  `workspace.rename` - one name, stored where the workspace lives, same rule
  as the display order. The input starts prefilled with the current name, an
  empty name is rejected rather than meaning "back to automatic", and a name
  another workspace already carries is refused. Theme and voice vocabulary
  follow the session to its new name; an open terminal survives the rename,
  though a reloaded page will ask you to pick the session again under its new
  name
- **Voice vocabulary keeps its priorities without the title store.** Workspace
  names now live only in herdr labels, so the STT prompt tells the two kinds
  apart by script: a Japanese label is a name someone says out loud and leads,
  an ASCII label is directory-ish text and stays last, the glossary between
  them as before

## [0.3.60] - 2026-08-04

### Fixed
- **A session showed a stranger's conversation after its directory was
  renamed.** A transcript was addressed by the pane's working directory, which
  is only ever a guess at where one lives: Claude Code fixes the project
  directory when the agent starts and never moves the file, so a `mv` of the
  working directory under a running agent leaves the pane naming a directory
  nothing was written to. The lookup then walked up to an ancestor - `/home` -
  and answered with the newest transcript there, which is a different session
  entirely. The recap, the first prompt and the context meter went blank at the
  same time and for the same reason. A session id is unique across every
  project, so a miss now scans for the id instead of guessing at paths again,
  and the transcript is carried by its real location rather than re-derived
  from a path. Where the id resolves to nothing, the conversation is empty
  rather than someone else's - the fallback that once read "a conversation from
  the right directory beats an empty screen" was the thing showing the wrong
  one
- **The Claude changes list had the same fault, and showed it as edits.** Asked
  for a directory it had no transcript for, it walked up to an ancestor and
  listed whatever ran in `/home/you` last - a plausible-looking list of files
  the session never touched. It reads only this directory's own project now,
  and where a rename has moved the session out from under its project name, it
  finds it by the cwd the transcript itself last recorded

## [0.3.59] - 2026-08-04

### Fixed
- **A question that changes under a still-blocked pane is followed.** One
  AskUserQuestion call holds several questions: the TUI takes the answer to the
  first and draws the second without the pane ever leaving `blocked`. Nothing
  either side watched changed state, so the glasses kept the first question's
  text and options
  - The quiet failure is the expensive one. A picker still showing question one
    while the pane has moved on sends its Enter to question two - an answer to
    something the wearer never saw, which looks exactly like it worked
  - The tracker now re-reads a pane that is still blocked and replaces the
    waiting item when the question or its options changed. A fresh id rather
    than an edit in place, because it is a fresh decision. It leaves a
    dismissed item alone (the wearer chose the PC for that pane) and ignores a
    read that came back without options while the last one had them, which is a
    half-drawn frame rather than a question that lost its choices
  - The glasses half - re-opening the picker on the next question - ships with
    the app rather than the server, so a server running this alone updates the
    notice instead of leaving it stale

## [0.3.58] - 2026-08-04

### Added
- **Each session brings its own speech vocabulary.** A workspace can be given a
  short phrase of words it is about (the session menu, beside the custom title,
  or `PUT /api/sessions/:id/stt-prompt`), and those words lead the bias sent
  with its transcriptions. `?session=` on the STT request names who is
  speaking; the glasses take it from the workspace they are replying to
  - Whisper's 224-token ceiling is what made one server-wide line a problem
    rather than a simplification: as workspaces multiply, names alone eat the
    budget and the words being said *in this session* are what fall out. A
    session about the G2 display and one about tax paperwork were biased
    identically, and neither got the terms it needed
  - The session's words sit **before the glossary but do not replace it**,
    pushing herdr's labels out instead. The glossary is what is said every day
    in every session - a session that spent the whole budget on its own
    vocabulary would start mishearing `リリース` again
  - It joins the composed line rather than becoming a fourth override: the
    saved setting and `HRDLE_STT_PROMPT` already mean "send exactly this", and a
    per-session vocabulary is an addition to a composition, not a replacement
    for someone's explicit choice. A session with no words of its own composes
    exactly as before
  - Glasses v0.0.50 carries it to the device

## [0.3.57] - 2026-08-04

### Added
- **The dashboard shows what the glasses have spent on Groq.** Today's
  transcription count, the length of audio behind it, an estimated cost, a
  fortnight of daily audio, and how much of each quota is left. It sits in the
  server section rather than under the agent tabs - Groq is not an agent, it is
  this server's own outbound spend, on the one input path with no keyboard
  behind it
  - Unlike every other usage panel here, this one is **recorded rather than
    aggregated**. Kimi, Codex and Grok all leave transcripts on disk and can be
    recomputed at any time; Groq leaves nothing - no usage endpoint, remaining
    quota only as headers on a transcription response, and no way to ask
    afterwards. A request not written down as it happened is gone, so
    `/api/glasses/stt` records on the way past, before the response status is
    acted on (a rejected request still spends quota, and the headers on a 429
    are the ones worth having) and without awaiting it (the user is waiting on
    a transcript, not on a tally)
  - Two quotas, because Groq caps two things on two clocks: requests per day
    and audio seconds per hour. A remaining bar is drawn only for a limit Groq
    actually reported, so a missing bar reads as "not measured yet" rather than
    "full"
  - The cost is an estimate at the list price per hour of audio and is labelled
    as one. Audio length is measured rather than guessed - raw PCM is a
    division, a WAV body has its chunks walked, and anything that is not a
    plain PCM WAV measures zero, because a guessed duration would be spent as
    real money on the estimate
  - History starts from this release. Nothing before it can be recovered

## [0.3.56] - 2026-08-04

### Fixed
- **Starting a second server printed a crash where one sentence would do.** The
  server options were the entry point's default export, so Bun called
  `Bun.serve` itself and a taken port arrived as an uncaught exception - a
  stack pointing into `bun:main`, five lines of quoted Bun source, and
  `EADDRINUSE` at the bottom. It reads as Bun falling over, and it is almost
  always just the service already running. It serves explicitly now and asks
  the port who holds it: our own `/health` answering means there is nothing to
  do, so it says so in one line and exits 0. Anything else keeps the error and
  the non-zero exit, without the stack. The discovery listener moved after the
  main port is won, so a second start no longer warns about the neighbouring
  port that the first one legitimately holds

## [0.3.55] - 2026-08-04

### Changed
- **The demo's workspaces are named for the states they are in.** They were
  named for gestures, which the footer already carries - so the marks down the
  left edge went unexplained, and those are what a wearer has to learn to read
  at a glance. A row says what that row is now: waiting on you, working right
  now, done with nothing to answer, two panes under one workspace, and the one
  that closes the app. The exclamation, the dot and the blank each have a row
  saying what they mean

## [0.3.54] - 2026-08-04

### Changed
- **`hrdle qr` is `hrdle address`, and prints text instead of drawing a code.**
  The short form for the glasses app's setup screen comes first, the browser
  URL under it. The old name still works - it is in people's shell history.
  `install.sh` ends with it, falling back to `qr` so that a fresh install
  between this commit and the release that carries it does not end in silence

### Removed
- **The QR scanner, and the code it was meant to read.** The glasses app's
  WebView refuses a camera to web content, so the one screen that needed to
  scan never could - measured on device, and the reason the setup screen has
  asked for a nine-character address since. `qr-scan.ts`, `qr-decode.ts`,
  `photo-capture.ts` and `camera-probe.ts` were kept anyway, for the day the
  host implements `onPermissionRequest`. Keeping them cost more than that day
  is worth: four modules, the jsQR dependency, two blocks of translated
  strings, and - the expensive part - a story told across the app, the setup
  site and the installer about a code that nothing could read. The history has
  them if the platform ever changes

## [0.3.53] - 2026-08-04

### Fixed
- **The demo said double-tap goes back on the screen where it closes the app.**
  It is one gesture with two answers - from a workspace it steps back, from the
  list it asks the host to close - and the tutorial taught the wrong one at the
  root. The list row says it closes the app now, and the stepping back is
  taught where it is true, on the conversation screen, alongside the swipe
- **The page-budget test now checks what the panel keeps.** The version that
  shipped with 0.3.52 counted lines against a model of the page and let an
  overflowing lesson through: `screenText` hands back everything it assembled
  and the container is what clips, so a line over budget disappears with
  nothing to say it did. It compares against `conversationLines()` and asserts
  every message is still in the body - the failure it exists for is precisely
  the paging line falling off, which is the line explaining the swipe that
  would have revealed it

## [0.3.52] - 2026-08-04

### Added
- **The demo speaks the phone's language.** Its strings live in `i18n.ts` in
  English and Japanese now, and the language is the one the phone already has
  (a saved choice first, then `navigator.languages`) - the demo is the screen a
  wearer meets before anything is set up, so there is nowhere to go and change
  a setting first
  - This is the first thing the G2 itself draws in Japanese. It costs no
    re-reckoning of `metrics.ts`: the panel measures real glyph advances and
    wraps Japanese every day, for what the agents send back. What it costs is
    room - full-width is about half the characters per line - so the two tables
    are the same lesson written twice, each to its own budget
  - `demo-i18n.test.ts` holds that budget: in both languages a workspace name
    and an option each have to be one row, and the recap plus the four messages
    have to come in under a page. A line over budget is a line behind the swipe
    that would have revealed it

## [0.3.51] - 2026-08-04

### Changed
- **The demo teaches the screen it is on.** It ran on plausible work - a
  workspace called `api-refactor`, a migration, a database question - which
  reads as a screenshot: nothing on it says what a workspace row is or which
  gesture opens it. Every string is a caption for the thing it sits in now. The
  workspaces are named for the gesture or mark they carry, the transcript
  explains the transcript, each option in the picker says what checking it
  does, and the voice screen says where spoken words end up
  - The transcript is short enough that the whole lesson is on the first page.
    A conversation opens at its newest message, so a line that does not fit is
    behind the swipe it was trying to explain
  - The recap stops saying the workspace is waiting once it has been answered

## [0.3.50] - 2026-08-03

### Fixed
- **The DEMO tail stayed on after the demo did not.** Entering a server address
  while the demo was up closed the gate that handles the setup screen and left
  the demo running: `demo` is a flag on the state the real app draws from, so
  every live workspace carried DEMO for the rest of the run - the app saying
  the wearer is looking at canned data while they are looking at their own
  sessions. The gate now ends the demo as it closes, and a closed gate is inert
  (its handlers could otherwise still start one, a tap after the real wiring
  had taken over)

## [0.3.49] - 2026-08-03

### Added
- **The demo answers, and the conversation moves on.** Answering an agent
  without a keyboard is what this app is for, and the demo stopped one step
  short of showing it: the send said what it would have done and nothing
  happened. A spoken reply now arrives as a transcript, joins the transcript as
  the wearer's turn, the workspace goes to work, and the agent answers it
  - The microphone is not opened. Transcription is the server's job and a demo
    has no server, so a real recording could only ever arrive at "(nothing was
    recognized)" - the gesture that matters most, demonstrated as a failure
  - The picker answers the same way. Its boxes tick locally, since there is no
    pane to read them back from, and what was ticked is what the reply says
  - Demo workspaces carry an agent session id. A transcript is addressed to an
    agent session rather than to a workspace, so without one the conversation
    screen resolved to no target and opened empty - the screen the whole demo
    leads to
- **A demo button in the simulator.** The demo lives behind "no server address"
  and the simulator always has one, so the sequence a reviewer sees could only
  be checked by clearing the address on a device

### Fixed
- **The multi-select footer reaches the panel.** `buildChoice` held the
  single-pick wording as a constant, so the device drew "tap:confirm" over the
  one screen where a tap does not confirm; only the copyable transcript had the
  right words. The same divergence the screen mirror has now produced three
  times - wording in two places, and the device gets the older copy
- **The voice screens say DEMO.** Every other screen carried it. A recording
  screen that does not is a recording screen claiming to be listening

## [0.3.48] - 2026-08-03

### Changed
- **The setup gate has a seam the tests can hold.** It shipped broken twice,
  both times as one line, both times because nothing could reach it: four
  callbacks inside an async function, behind a branch that only runs on a
  device with no server address. 0.3.45 wired a way out and no way around;
  0.3.46 wired a way into the demo and left the demo's own gestures going to a
  noop. Both are cases in `setup-gate-wiring.test.ts` now, and the gate is a
  plain function over its dependencies

## [0.3.47] - 2026-08-03

### Fixed
- **The demo answers the ring.** 0.3.46 drew the demo's session list and then
  ignored every gesture. The gate that handles the setup screen is still the
  only handler while the demo runs — the real wiring sits below an await that
  has not resolved — and it was passing swipes and taps to a noop, because it
  had been written for a screen with nothing on it
  - Double-tap on the demo's root is the exit dialogue, the same question a
    root asks anywhere. Routing it back to the setup screen would have made the
    one screen a reviewer reaches first the one place the gesture means
    something else
  - The setup guide is drawn straight at the bridge, behind `updateDisplay`'s
    back, so its record of the panel is wrong on both crossings. Without
    invalidating it, a second visit would upgrade the guide's containers in
    place — same ids, different geometry — and draw a list into a screen shaped
    like a paragraph

## [0.3.46] - 2026-08-03

### Added
- **A demo mode on the glasses, so there is an app to judge before there is a
  server.** An EVEN Hub reviewer has no herdr server and is not going to
  install one, so the app they were asked to judge was a paragraph of setup
  instructions and nothing else — and everything the rubric asks them to test
  (does it answer the ring, does it survive five minutes locked, does every
  gesture have a visible response) was unanswerable, because nothing was on
  screen to answer it
  - Tap on the setup screen starts the same app on canned data: the real
    session list, conversation and pickers, driven by the real controller and
    the real gestures. Nothing in it draws anything of its own — a second
    implementation of every transition would drift, and the ones that drift are
    always the ones nobody is looking at
  - It does not pass for the real thing, or it would break the first-run rule
    it exists to satisfy. Every screen carries `DEMO`, riding as the header's
    tail — the part that never yields. Voice says outright that nothing was
    sent, and nothing opens a socket
  - Double-tap leaves the demo for the setup screen rather than the app: that
    gesture leaves every screen here, and the demo is something the wearer
    stepped into. The exit dialogue is one more double-tap away, from there

## [0.3.45] - 2026-08-03

### Fixed
- **The ring works on the screen that comes before a server.** Everything that
  handles a gesture lives below an await that only resolves once a server
  address has been stored, so a wearer who has not set one up sat on "not
  connected" with no working input of any kind — not a tap, not a swipe, and no
  way to close the app. An EVEN Hub reviewer has no server at all, so that
  screen was the whole of what they saw; they reported it as double-tap failing
  to bring up the exit dialog and the submission was rejected for it. Reading
  the code, the root page does call `shutDownPageContainer(1)` — the reviewer
  never reached the root page
- **The title takes the header bar, and the clock gives way.** The clock always
  survived and the title was clipped to make room; adding the date took the
  right-hand side from 52px to 173px, so a workspace name that fitted yesterday
  lost ten characters today. The title says which session is being read, which
  is the question — so it is served first, and the clock takes what is left:
  the date and time together, the time alone, or nothing

### Changed
- **An eighth line in the conversation, out of padding nobody was using.** The
  band between the bars was 204px usable, which is seven rows and 15px of
  remainder — a row that could not fit however the padding was tuned. A bar
  holds exactly one line either way (its inner height stays 28 against a 27px
  line), so `BAR_H` went 36 → 32 and gave the body 220px: eight rows with 4px
  to spare. The list keeps its nine; the notification card gains one
- Every `36` in the container definitions is `BAR_H` now, and `panel-paint.ts`
  no longer keeps its own copies of `HEADER_PAD` and `BODY_PAD` — the panel's
  geometry had two homes with only one of them authoritative

## [0.3.44] - 2026-08-03

### Added
- **A multi-select can be answered from the ring.** Claude Code's multi-select
  answers to space-then-enter, and the ring could send neither a space nor
  anything but Enter — so a tap submitted an empty set and the question came
  back unanswered. The picker looked like it worked and did nothing
  - Three verbs are needed where a single pick needs two: check, send, leave.
    Double-tap means "leave" on every screen in this app, so the third verb is
    a row rather than a gesture: tap checks an option, tap on the last row
    sends, double-tap leaves as it always has
  - The send row carries the count. Swiping onto it sends the pane no key —
    the pane's cursor never left the last option. A toggle re-reads the pane,
    so the boxes shown are the pane's rather than a guess
  - A single-pick list is untouched: no extra row, Enter from any row, same
    footer
- **The phone's power state rides on every heartbeat** (`pwr=chg,82%`) and on
  the exit line, and a charger going in or out gets a line of its own. The
  glasses' own battery is not available — `onDeviceStatusChanged` has only ever
  delivered `connectType: "none"` with filler behind it, which is why `dev=`
  and `batt=` never appeared
- **A ninth row in the session list.** The container had 240px for rows of 27,
  which is eight rows and 24px of remainder — a gap above the footer holding a
  row that missed by 3px. `LIST_PAD` leaves 248px, so it fits with 5px to spare
- **The date rides with the clock** (`2026-08-03 09:41`). A wearer reading a
  list has often been away from it for longer than a clock can say. ISO order,
  not a locale's — the panel draws English and this way the fields cannot swap
  meaning

### Fixed
- **A written plan is no longer taken for a menu.** Tapping a waiting session
  put the wearer into a picker holding three lines of a plan, with a working
  cursor and an Enter that would have sent one of them to an agent that asked
  nothing. Two faults, either of which alone was enough:
  - `stripAnsi` ended by deleting every non-ASCII character, so a Japanese pane
    arrived as the punctuation between its words. It cost more than the
    choices — the scraped question line comes out of the same buffer.
    Renderability is `stripUnrenderable()`'s judgement, which the session list
    has been passing Japanese through all along
  - Any line with a number and a dot was an option. An option block now has to
    look like one: numbering that starts at 1 and counts up without repeating,
    at least two, close together, and near the pane's tail where a prompt sits
- **`headerless` is carried through the screen mirror.** The list screen gives
  the header's bar back to its rows, but the flag never left the device — so
  the browser mirror, the recording and the replay player drew every list frame
  36px lower than the device did, with an empty header above it. The same shape
  as the `card` fault in 0.3.43, one field over

## [0.3.43] - 2026-08-02

### Fixed
- **The notification card is carried through the screen mirror.**
  `screenText()` marks the overlay screen as a card - inset, bordered, sized to
  its message - but `publishScreen` destructured only header/body/footer/notice,
  so the flag never left the device. The browser mirror, the recording and the
  replay player all drew a notice as plain body text
  - `debug-ui.ts` already carried a comment about this exact shape: a screen
    rebuilt field by field drops anything not named, which is how the notice
    strip went missing once before. `GlassesScreen` now carries `card` and
    every field-by-field rebuild names it
  - Not cosmetic. The border was added so a notification reads as a
    notification rather than as more body text, and until now there was no way
    to see on the simulator whether that had worked
- **The screen shown when the server cannot be reached says what to do about
  it.** It named the failure and then closed, which reads as the app being
  broken - and whoever meets that screen is usually meeting the app for the
  first time, with the address wrong or the machine off. It now names both
  things to check before it closes

### Changed
- **The README says what Hrdle is rather than which category it is in.** It is
  herdr plus handle: herdr runs the sessions, this is the handle you take hold
  of them by. And the machine being headless is the case it was built for, not
  a caveat - both now in the first screenful, in English and Japanese. The same
  framing leads the EVEN Hub store description
- **`min_sdk_version` raised to 0.0.12**, the floor the EVEN Hub review rubric
  names. The bundled SDK was already `^0.0.12`
- Glasses app built as v0.0.37 and submitted to the EVEN Hub store for review

## [0.3.42] - 2026-08-02

### Added
- **The replay player's backdrop can be swapped, and a frame exported as a
  transparent PNG.** Pick a file, paste a URL (persisted, sharing the
  simulator's `glasses-bg` key - both windows are the same lens) or drop an
  image onto the screen; Reset returns the default room. Save PNG writes the
  current frame as the canvas alone (transparent, 576x288) for the EVEN Hub
  store listing, which composites its own room photo behind submissions

## [0.3.41] - 2026-08-02

### Changed
- **The dashboard panel fits in two screens instead of four.** Measured at its
  real width, the Claude tab ran to 1565px of scroll, and the space went to the
  things with least to say: 116px on two latency numbers, 502px on three charts
  that were mostly axis in a column too narrow for an axis. Now 1179px, with
  more in it
  - **Hourly activity is a heatmap, which is what it was called.** The payload
    has been hour-by-hour all along and the card summed it into four blocks —
    170px to say "mornings are busy". Twenty-four cells fit in less room and
    answer when the day actually starts, with the peak hour on the title row.
    Stepped on the square root of each hour's share, because one batch hour can
    hold five times any other and a linear scale left the rest a single shade
  - **The server card is one line per metric**: name, value, and an inline
    sparkline. The full charts are a tap away and the choice is remembered
  - **Latency moved onto the local server's own title row.** It measures this
    browser's link to that server, so a card of its own above a list of peers
    described none of them
  - Usage limits are untouched. The burn-down projection earns its space when
    the limit is close, which is the moment it exists for

## [0.3.40] - 2026-08-02

### Fixed
- **The Kimi cost chart shows its figures on a tablet.** They were in a `title`
  tooltip, which on a touch screen does not exist — so the chart had bars and
  no numbers, and the question it was built to answer needed a mouse to ask.
  Each day's amount now sits above its bar
  - Muted ink rather than the bar's green: the colour is the mark's job, and a
    row of green numerals competes with it
  - Every day that cost something is labelled while the range is short. Past a
    week they thin out, with the most expensive day and today reserved first —
    in that order, because ranking today first cost the peak its label whenever
    the two fell side by side. Today's figure is on the title row regardless
  - Sub-cent days print as `<$0.01`; four decimals is right in a stat tile and
    two characters too many in a column a finger wide

## [0.3.39] - 2026-08-02

### Added
- **Ring gestures are recorded with the screen mirror, and replay shows them.**
  (#129) The device publishes each tap / double tap / swipe just before acting
  on it, the recorder writes it as its own line kind next to frames and gap
  markers, and the player overlays a fading badge on the lens so demo footage
  shows the wearer driving. A gesture also proves the device alive, so a
  disconnect right after one still writes its gap marker. Requires the updated
  glasses app; older ehpks simply record no gestures

### Changed
- **The replay player is its own page** (`/glasses?player`). The first player
  lived in the simulator's side panel, a whole screen away from the panel it
  was driving; now the screen sits large in the middle with play/pause, seek
  bar, wall-clock and speed directly beneath, Space / arrows / Home / End on
  the keyboard, and the newest day loaded on open. The canvas painter moved to
  `panel-paint.ts`, shared by simulator and player, so a replayed frame wraps
  and clamps exactly as the wearer saw it

## [0.3.38] - 2026-08-02

### Added
- **The Kimi tab says what today cost, and shows the days before it.** The two
  figures it had were rolling windows, and neither answers the question: a
  24-hour window read at 10:00 is mostly yesterday. The new chart buckets by
  your own calendar day, with today's figure on the title row
  - Cost only. Tokens are in each bar's tooltip rather than on a second axis
  - A day whose models could not be priced stays unknown instead of being drawn
    as zero. `$0.00` says you spent nothing, which is a different claim
- **The chart outgrows the seven days the logs can be read for.** Completed
  days are written to `kimi-daily-usage.json` in the data directory and joined
  onto the live week, up to a month
  - No timer: a finished day never changes, so it is written during the
    aggregation that was going to run anyway, and only when its figure is new.
    A day is lost only if the server saw none of the week it belonged to
  - A day this server never saw is drawn as a hole, not as zero, and the
    footnote counts them. Past a week the axis labels its two ends rather than
    every day - twenty weekday initials are a grey smear
  - Stored days keep the list price in force when they were recorded, which is
    nearer what was billed than re-pricing history at today's rates

## [0.3.37] - 2026-08-02

### Added
- **The glasses screen mirror can be recorded, and recordings replayed.** (#127)
  With `HRDLE_GLASSES_RECORD=1` set, the server appends every mirror frame to a
  per-day JSONL file under the data directory - one line per screen transition,
  a gap marker where the device disconnected, and the server's own arrival
  clock next to the device's stamp. Off by default: the recording is the
  user's own prompts and notification text. 365-day rolling window
  - The simulator gains a replay player (day picker, seek bar, 1x-60x with
    long stills capped at 2.5s) that feeds a recorded day through the same
    painter the live mirror uses, so wrapping, the 7-line clamp and the notice
    strip match what the wearer saw
  - `GET /api/glasses/recording` / `GET /api/glasses/recording/:day` (inside
    the auth glob) list and read recordings; old footage stays replayable
    after recording is switched off

## [0.3.36] - 2026-08-02

### Changed
- **The major dependency upgrades, all six.** i18next 25 -> 26, react-i18next
  16 -> 17, lucide-react 0.577 -> 1.28 and @hono/zod-validator 0.7 -> 0.9 each
  had their breaking changes looked up and then matched against the tree; none
  of them land here. `react-i18next@17` peer-requires `i18next >= 26.2.0`, so
  those two moved together
- **TypeScript 5.9 -> 7.0, and the native preview is gone.** 7.0 is the Go
  compiler moving out of `@typescript/native-preview` and into the `typescript`
  package, which this repo had been typechecking with for months under the
  preview name - so the upgrade was mostly deleting the second way of saying it.
  The four `tsgo --noEmit` scripts are `tsc --noEmit`, that being the one binary
  the package ships
  - 7.0 ships **no public compiler API** until 7.1. Nothing here consumes one -
    vite goes through rolldown, the react plugin through babel, biome is Rust,
    and the glasses build calls the CLI - but a tool that did would stop working
- **The glasses manifest says the Even App version the SDK actually needs.**
  `min_app_version` was 2.0.0 while the SDK declares its own floor as 2.2.6, so
  the manifest was promising a phone it cannot run on: an install that succeeds
  and then does not work. Phones below 2.2.6 can no longer install it, which is
  the point of the field

### Fixed
- **Following the phone yields to the ring.** A wearer swiping the session list
  had the cursor pulled back to whatever a browser tab elsewhere was showing,
  every five seconds, for as long as both were open. `AUTO_ADVANCE_IDLE_MS`
  already exists so "a reader who is working the ring is never fought for
  control" and the auto-advance clock keeps it; `followFocus` did not, and it is
  the one that takes the cursor rather than the page. It yields on the same
  clock now

## [0.3.35] - 2026-08-01

### Fixed
- **Splitting a workspace that already holds nine panes puts the pane on
  screen.** herdr numbers panes in base36 - the tenth is `pA`, not `p10` - and
  every pane-id boundary here matched `\d+`. So `pA` onwards mapped to null,
  was rejected before it reached the split tree, and the split created a pane
  herdr listed and this app never drew. The log said it plainly: a tab herdr
  reported with eight panes came up as `panes=1`
  - One unmappable id also collapsed the whole exported layout, so such a
    workspace lost its pane geometry as well as its panes and fell back to a
    flat chain of whatever did map
  - The token travels verbatim now rather than parsed as a number. A numeric id
    still goes on the wire as a number, so a peer on an older frontend keeps
    rendering the panes it always could

### Changed
- **The dashboard opens on the numbers instead of a spinner.** Nothing polls
  while the panel is closed and every leg of the payload blocks on its own
  expiry, so the TTL had always lapsed by the time it was reopened - the common
  case was the worst case, every time. The assembled payload is now served
  stale-while-revalidate, with a warm-up shortly after boot so the first open of
  a server's life is served the same way, and the client holds the last payload
  outside React so a reopen paints what you were last shown
  - System metrics and the client count are stitched in fresh on every answer.
    A frozen CPU line reads as a hung panel rather than a fast one
- **The dashboard's widgets look like one list.** Each drew its own box inside
  the panel's box - two borders and 28px of padding around an 80px chart - and
  titled it in one of two styles. One `Card` draws the box now and the widgets
  render content. The panel's own scroller is gone too: Dashboard brings one,
  and two nested scrollers meant a flick moved whichever the finger was over

## [0.3.34] - 2026-08-01

### Changed
- **The browser simulator draws through the device's own `updateDisplay()`.**
  It supplies a bridge that records containers instead of sending them to a
  host, and the canvas paints what that bridge holds - so the
  rebuild-vs-upgrade decision, which container id a string is addressed to, and
  every container's geometry are decided once, in `display.ts`, for both. It
  used to lay the screen out a second time from `screenText()`, and every
  divergence that cost real debugging time was of that shape
- **Dependencies refreshed within their declared ranges** - hono, zod, react,
  vite, tailwind, i18next and the rest. `backend/tsconfig.json` gained an
  explicit `rootDir`: the backend compiles `src/**` and `../shared/**`
  together, so the root they share is the repository, and the newer typechecker
  stopped inferring that

### Fixed
- **Fullscreen on an upright phone was unreadable.** The panel is twice as wide
  as it is tall and the fit took the smaller ratio, so a portrait phone fitted
  it to its short edge - 312px of panel on a screen 844px long. It turns a
  quarter now, room and all, and is fitted against the swapped axes: 624px on
  the same screen. Turning the phone brings it upright
  - The rotation goes on the children, not on the fullscreen element: that one
    sits in the top layer, where the UA stylesheet pins `transform: none
    !important` and an author `!important` does not outrank it

## [0.3.33] - 2026-08-01

### Added
- **The glasses list says how full each agent's context is.** It reported which
  workspaces were running and nothing about the agents inside them: context use
  existed only on the pane rows of multi-pane workspaces, so the single-pane
  ones that make up most of the list carried nothing, and the model was never
  declared in the glasses' own types although the server had been sending it all
  along
  - Every row carries `ctx:` and one of eight block heights, beside the name it
    belongs to. Eight steps is coarser than a figure on purpose - the list
    answers "which of these is filling up"
  - The model and the exact percentage are in the footer, for the row the cursor
    is on. On all thirteen rows they were the same two facts thirteen times
  - A heading leaves the mark to its pane rows, since one level covering three
    agents describes none of them

### Changed
- **The glasses' working indicator beats instead of turning.** `▲▶▼◀` rotated
  one frame every three seconds, which is never seen turning - only sampled -
  and four sampled triangles read as four states rather than one thing running.
  It is now a small dot alternating between `·` and `•`
  - Those two are also the only small glyphs the firmware pairs: 80 and 144
    units against the 320 of every full-width mark, where everything else that
    size is punctuation on the baseline or sits raised off it. Braille, the
    obvious candidate, has no glyph at all - all 256 codepoints of U+2800-28FF
    measure zero and would be dropped before reaching the panel
  - Being narrower, they would have started every running row's name a third of
    a column to the left; the badge is padded back out to the column in 5px
    spaces

## [0.3.32] - 2026-08-01

### Fixed
- **The G2 session list marks the sessions that are waiting for you.**
  `statusLabel` returned a badge only for `processing`, so `waiting_input` - the
  state most worth finding on that screen - looked exactly like idle and
  completed. Survivable while waiting sessions floated to the top; freezing the
  order so the cursor would hold still (#102) left the state with neither a mark
  nor a position
  - Waiting outranks working, on the row and in the heading: a session that is
    running will finish on its own and one that is asking will not. A heading
    reads its panes rather than only its own indicator, because the panes can be
    below the fold exactly when the summary is all there is to go on
  - `completed` and `idle` stay unmarked on purpose - most sessions are one of
    the two, and a mark on most rows is not a mark
  - The cursor no longer shoves its own row sideways: `>` is 10px against a
    space's 5, so the row under it sat 5px right of every other row, and the
    cursor moves on every swipe

### Changed
- Glasses app built to v0.0.30 ehpk

## [0.3.31] - 2026-08-01

### Fixed
- **The conversation can be scrolled to its last line.** The transcript ended
  flush against the bottom edge - on a phone, where the session bar and the home
  indicator are - so the final lines sat under them with no scroll left to reach
  them
  - Measuring turned up a second cause: the virtualizer's `getTotalSize()` runs a
    steady ~45px short of what the rows actually render to, so the last message
    hung below the sized container and was clipped. One trailing space covers
    both, 128px plus the safe-area inset
  - The at-bottom threshold moves with it. Auto-follow aligns the last message to
    the viewport edge and leaves that padding below as unconsumed scroll, which
    the old 24px threshold would have read as "the reader scrolled away" -
    following would have stopped after the first new message
  - The history list ended the same way and gets the same treatment, smaller

## [0.3.30] - 2026-08-01

### Added
- **A collapsed workspace card now says what its panes are doing.** A workspace
  with more than one pane or tab showed only its title, path and the `3 panes` /
  `2 tabs` badges until it was expanded: model, ctx, memory and the recap moved
  to the pane rows because one card-level number cannot say which pane it
  describes. That made the workspaces with the most going on the least readable
  rows in the list
  - One pane speaks for the card while it is collapsed - the one waiting on the
    user, else the one still working, else whichever spoke last - showing its
    name, tab, model, ctx gauge, memory and recap
  - The other panes shrink to a chip each, carrying a status dot, the name and
    the context percent, so three panes cost about three lines
  - Expanding still swaps in the tab/pane tree, so nothing is drawn twice, and
    the lead pane's recap replaces the summary line it would have repeated
  - The tab name is left off a single-tab workspace, where `Tab 1` says nothing

## [0.3.29] - 2026-08-01

### Fixed
- **A tool call in the conversation now says what it acted on, whichever agent
  made it.** Kimi's `Read`, `Edit` and `Write` showed the tool's name and
  nothing else - 37 of the 82 tool lines in a real transcript
  - The cause was reading a call's arguments by tool name. `case 'Read'`
    returned `file_path`, which is Claude's spelling; Kimi calls it `path` and
    Grok `target_file`. Returning the empty string also shadowed the fallback
    that scans for the first string argument and would have found it - so the
    tool names that were never taught (Grok's `read_file`, Kimi's `FetchURL`)
    read fine, and the ones taught a single agent's spelling were the ones that
    broke
  - Arguments are read by field now: a description first, then what was
    searched for, then the file, then the instruction given. What is left bare
    is `TodoList` and `AskUserQuestion`, whose arguments are arrays and which
    have nothing to say
- **A scoped search in the web UI named the directory it looked in rather than
  what it was looking for.** `Grep` carries a `path` alongside its `pattern`
  whenever it is scoped, and the file fields were read first

## [0.3.28] - 2026-08-01

### Added
- **The glasses app takes a nine-character address instead of a Tailscale
  FQDN.** `91.210.90` rather than
  `https://beelink-arch.tail4459c9.ts.net:5924`. The server answers a plaintext
  `/whoami` one port above its own, carrying only its FQDN, product name and
  version, and only to callers on a private or CGNAT address
  - Plaintext is the requirement rather than a shortcut: the certificate is
    issued for the FQDN, so reaching the machine by IP or short hostname fails
    TLS, and `fetch` has no way past a certificate error the way a browser's
    warning page does. One unverified request buys the name; everything after
    it is ordinary verified HTTPS, and a tailnet caller's packets are inside
    WireGuard regardless
  - A bare hostname works too (MagicDNS resolves it inside the tailnet), as
    does a full URL. `100.` is the only part of a Tailscale address that can be
    dropped - the second octet onwards is allocated per node, not per tailnet -
    and it is enough
  - `hrdle qr` and the server banner both print the short form
- **The setup wizard's scan step is gone**, because the phone app's WebView
  will not do it. Measured on device: it denies a camera to web content
  (`permissions.query` still reads `prompt` while getUserMedia throws
  `NotAllowedError`), opens no file chooser for `<input capture>`, and refuses
  `clipboard.readText()`. All three are the host's unimplemented callbacks, not
  anything this side can fix
  - The QR code itself stays. Read with the phone's *own* camera app it opens
    the server in a browser, which is a different job and one that works

### Fixed
- **Peer discovery finds the tailnet again.** It has probed a literal port 5923
  since the rename, so a tailnet full of installs discovered nothing (#459).
  The port is composed from identity now, and with one server reachable the
  rest of the tailnet comes back as a list rather than more typing

## [0.3.27] - 2026-08-01

### Changed
- **The history list reads like the conversation it opens.** The transcript was
  rebuilt to read like the Claude app while the list stayed the old cold grey,
  so every tap announced a seam that isn't there. Same palette now
  (`--color-conv-*`), light and dark, across the search field, facet sidebar,
  filter drawer and date headers
  - The row leads with the recap - it says what happened - and falls back to the
    prompt, dimmer for being a fallback. Under it, one muted line of
    `project / agent / branch / when`, with the agent as the same coloured dot
    the transcript uses for its speaker
  - Off the row: the boxed agent badge, four metadata icons, message count and
    duration. A list is for telling one conversation from another, and none of
    them helped with that. The peer stays - a session on another machine is a
    different thing, not a detail
  - Facet chips lose their five per-axis colours for one quiet style

## [0.3.26] - 2026-08-01

### Fixed
- **A working Kimi or Codex pane no longer reads "completed" for the whole
  turn.** The indicator took the hook override first for thread agents, and the
  documented Kimi setup registers `Stop` and nothing else - so "finished" is the
  only hook event that ever arrives, and with a 24-hour TTL it pinned the
  indicator until the next turn ended. herdr was reporting `working` the whole
  time and being ignored
  - Claude stopped reading hooks first for exactly this shape of bug; thread
    agents kept the old order because herdr's accuracy for them was unverified
    (#390). Verified now on herdr 0.7.5: a Kimi pane read `working` through its
    turn and `done` within twenty seconds of its end, with two Kimi panes on one
    host disagreeing correctly
  - The rule is now the same for every agent: herdr watches the pane, a hook
    only reports the moment it fired. An agent with no herdr integration (Grok)
    has no status to read, so its hook still carries the indicator as before

## [0.3.25] - 2026-08-01

### Fixed
- **An uploaded image arrives as a paste, so the agent shows `[Image #1]`
  again.** Attaching a picture from a phone left the prompt holding fifty
  characters of upload path where the picture should be
  - Nothing here had changed: the upload has always sent the path as terminal
    input. Claude Code recognises an image only in its *paste* handler - which
    is how a terminal delivers a drag-and-drop - and its auto-paste-detection
    only treats a batch as a paste above roughly 300 bytes, which a path is
    nowhere near. Verified on a live pane against Claude Code 2.1.220: the same
    path, raw versus wrapped in DECSET 2004 markers, gives the literal path
    versus the placeholder
  - All three upload paths go through it: the phone's input bar, the desktop
    file picker, and a pasted clipboard image. The separating space sits
    outside the markers, since inside it would be part of the filename the
    agent goes looking for

## [0.3.24] - 2026-08-01

### Added
- **Syntax highlighting for code in the conversation.** The file viewer has
  highlighted code since it existed; the transcript showed the same files as one
  flat grey. highlight.js is already in the bundle for the viewer, so this costs
  the parse and nothing else
  - Not one of highlight.js's own themes: the viewer imports github-dark, which
    is dark-only and cold next to the conversation's warm neutrals, and its
    single-class rules would paint its greys into light mode. The `hljs-*`
    classes are re-coloured under `.cv-code` from variables that follow the
    theme
  - Fenced blocks name their own language; a tool call's input is JSON; a
    result borrows the language of the file the call named - and only when its
    output has line breaks, since a one-line result is a status message and
    colouring "File created successfully at: ..." as TypeScript tints scattered
    words in an English sentence. Errors stay red and unhighlighted
  - Highlighting declines rather than returning the source untouched: the value
    goes through `dangerouslySetInnerHTML`, so the only thing on that path is
    output highlight.js escaped itself. Blocks over 40k characters are skipped

## [0.3.23] - 2026-08-01

### Fixed
- **A collapsed tool row says what the tool was asked, not only its name.** The
  summary knew `description`, file paths, `pattern`, Bash commands and prompts,
  but not `query` - the field every search tool carries - so a column of
  `WebSearch` / `ToolSearch` rows was indistinguishable until each was opened
  - `query` and `url` join the list. A URL outranks the prompt beside it: for a
    fetch, the address says which page, the question rarely does
  - An input matching nothing known falls back to its first short single-line
    string, skipping identifiers and knobs (`id`, `session_id`, `model`, ...),
    so a tool nobody anticipated still says something about itself
  - Every branch is cut to one line and ellipsized at 60 characters; the header
    is one line, and a pasted paragraph should not decide its width

## [0.3.22] - 2026-08-01

### Fixed
- **The conversation view follows its pane, not its workspace.** A workspace
  with two agent panes holds two conversations; the subscription named only the
  workspace, so the server resolved it by directory - and that answers with the
  most recently modified transcript in the project folder. Three Claude panes in
  one repository all read whichever had written last, which is generally not the
  pane on screen
  - The pane's own agent session id now travels with the subscription and back
    on every message. The server uses it to pick the pane's working directory
    (the workspace's is the *first* agent pane's, so a pane working elsewhere
    was read against a project folder holding none of its transcripts) and to
    resolve the transcript by id rather than by mtime
  - Watchers are keyed by session and pane together. One key per workspace meant
    the second pane's subscription tore down the first pane's watcher
  - An id that resolves to nothing falls back to the directory, and a
    subscription without an id behaves as before, so an older peer still answers

## [0.3.21] - 2026-08-01

### Changed
- **The conversation view is read-only, and laid out after the Claude app.** It
  had two jobs and did neither cleanly: it rendered a transcript in terminal
  styling, and it offered a second place to type into a pane that already has
  one
  - Input goes first, all of it - no composer, no echo line under the messages,
    no soft keyboard raised on entering chat mode on mobile. Two inputs for one
    pane only made it ambiguous which one was listening, and the answer was
    never the one on screen. Their plumbing goes with them: `sendInputRest`
    through the pane tree, `sendTerminalInput`, `sendTerminalInputRest` and the
    input-echo event that had no listener left
  - The surface has its own warm neutral scale (`--color-conv-*`) rather than
    the session's terminal color. That color identifies a pane; it was never
    chosen to be read against. Both light and dark
  - The user's turns are bubbles on the right, the agent's a full-width column
    in a 46rem measure at 15px and 1.7 line height
  - **A tool call and its result are one card.** The transcript stores them a
    message apart - the call on the assistant turn, the result on the user turn
    after it - which is how the old layout ended up with a "System" speaker
    reading out the result of something two screens up. They are paired by
    `toolUseId`, and the result-only message stops being a row at all
  - One speaker label per turn, so a burst of twelve tool calls is labelled
    once. Thinking and context-continuation summaries fold away by default; a
    tool whose result is an error opens by default
  - Code blocks carry a copy button, and the emoji markers are lucide icons

## [0.3.20] - 2026-07-31

### Fixed
- **A notification is no longer silenced because the glasses app happens to be
  running.** `deliveredToGlasses` suppressed the browser notification, the peer
  notification and the push, on the reading that the wearer had already been
  told — and the flag cannot establish that. It is set when a relay item was
  created, and all that proves is that the glasses app held a socket
  - The G2 returns to its home screen with the app still running, still drawing
    and still subscribed: observed on 2026-07-31 with `fg=1`, `drops=0` and the
    flag up, while the panel showed nothing. An app left running with the
    glasses off the face silenced the phone for its whole life
  - Neither field that would settle it is usable. `isWearing` reads `false` even
    on a wearer's face, because the protobuf omits zero values and `false`
    therefore covers both "not worn" and "never filled in". `connectType` has
    read `none` on every device-status event recorded, including while the app
    was drawing
  - So the rule is the one the relay itself already follows: losing a
    notification is the worse failure of the two. Two notifications for one
    event is a nuisance. The flag stays on the wire — it is true, worth seeing,
    and where suppression goes back when the glasses can report being worn

## [0.3.19] - 2026-07-31

### Added
- **Notifications arrive by Web Push**, so one no longer depends on a browser
  tab being awake. They have always been fired by the page when a mux WebSocket
  message arrived, which works exactly as long as the page is running — and on
  Android it usually is not. The tab freezes when the screen goes off, its
  keepalive stops, and the server drops the socket as a zombie sixty seconds
  later. Measured on the phone: three closes in one two-minute window, so every
  hook event in those gaps was broadcast to nobody. The fallback was the
  glasses, and the glasses app is killed by its host every few minutes
  - **No new infrastructure.** VAPID means the keys are generated here and
    registered with nobody: no Firebase project, no API key, no account.
    Nothing new listens on a port — the server only POSTs outbound to whatever
    endpoint the subscription names — and the payload is encrypted to the
    subscription's own key, so the push service forwards bytes it cannot read.
    Two files under the data directory, both 0600: the keypair and the devices
  - RFC 8291 (`aes128gcm`), asserted by a test rather than assumed. The first
    library tried encrypts with `aesgcm`, the superseded draft, and a push
    service dropping it later would have taken every notification with it
  - The service worker needed a `push` handler and nothing else. Its click
    handler has understood `notify-session` and the deep link into a session
    since long before this, so the session travels in the payload's url and is
    unpacked into the shape that handler already reads
  - Subscribing is behind the password — it is a browser asking for a copy of
    every notification. `POST /api/push/renew` is the exception, for the
    service worker's re-subscribe when a push service rotates an endpoint: a
    worker cannot read the token the page holds, so naming the endpoint being
    replaced stands in for it. It refreshes a device authenticated once and
    cannot add a new one
  - A 410 from a push service prunes the subscription; a 5xx or a timeout does
    not. Dropping a real phone on a transient error silences it permanently and
    nothing would say why

## [0.3.18] - 2026-07-31

### Changed
- **The glasses app frames the setup guide rather than carrying it.** The phone
  screen was the whole wizard — seven screens, their wording, the connection
  test, the settings panel. All of that lives at
  [hrdle/hrdle-setup](https://github.com/hrdle/hrdle-setup) now, served from
  Cloudflare Workers, and `phone-ui.ts` is a frame plus answers to the things a
  web page cannot do for itself
  - The reason is arithmetic. A wording change over there costs a deploy; the
    same change in the app costs a rebuilt ehpk, an upload to EVEN Hub, a version
    bump and a promotion to Beta — three times in one afternoon
  - The host still writes the server address, because `startGlassesMode` reads
    that key from the *host's* own store when the app starts on the G2, and
    nothing the guide saves on its own origin would be there. It still reads the
    QR code, because that is `captureImageFromCamera`
  - **And it makes every request to the server**, which was not the plan. The
    server answers `Access-Control-Allow-Origin: *`, so the guide was going to
    call it directly. Private Network Access stops that: the guide is
    public-origin, a tailnet address is inside CGNAT space, and Chrome refuses
    the crossing whatever CORS says. Measured rather than assumed — from that
    origin a fetch to `api.github.com` returns 200 and one to a `.ts.net` host
    does not reach the network at all
  - No offline copy of the guide. The setup it describes ends in reaching a
    server over a tailnet, so a phone with no internet cannot finish it anyway,
    and a second copy of seven screens is a second copy to keep correct. A failed
    load gets the fact and the address instead
  - `setup-wizard.ts` and `brand.ts` are gone with the screens they served. The
    ehpk is 10 kB smaller for having stopped carrying the wizard

## [0.3.17] - 2026-07-31

### Added
- **The setup guide is a website now**, at
  [hrdle-setup.abe00makoto.workers.dev](https://hrdle-setup.abe00makoto.workers.dev)
  (source in [hrdle/hrdle-setup](https://github.com/hrdle/hrdle-setup), served
  from Cloudflare Workers), and the glasses app's first screen points at it
  - Four of the wizard's screens are commands typed on a machine that is usually
    not the phone reading them, and there is no way to get a command from one to
    the other: copying puts it on the phone's clipboard, which the machine cannot
    see. Opened over there, the copy buttons land where the commands are going
  - It is also where those screens can be corrected without a rebuilt ehpk, an
    upload to EVEN Hub, a version bump and a promotion to Beta — which is what a
    wording change cost three times in one afternoon
  - The split is not a preference. Connecting has to write the server address to
    the *host's* store, because that is where the G2 reads it from, and the QR
    scan goes through the host SDK's camera. Those two screens stay in the app;
    everything before them is on the site, which ends by handing back to it
- **The wizard wears the app's actual icon, and the icon sweeps.** It carried a
  red rounded square with an `H` in it — a placeholder, on every screen, of an app
  that has a real mark. The mark is a scanner: eleven lamps in a slit, the light
  parked left of centre so it reads as travelling rather than stopped
  - So it travels. The keyframes are the icon's own brightness profile read
    across the band and replayed through time — each lamp starts one eleventh of
    a cycle further along than its left neighbour, so at every instant the eleven
    of them hold the distribution the still artwork does. It does not pulse
  - Drawn from the source geometry rather than inlined as a PNG, and checked
    against it: all seven red lamps and all three white cores agree to within
    0.007 units of 512. Each lamp keeps its original opacity as an SVG
    attribute, so `prefers-reduced-motion` falls back to the artwork as drawn
    rather than to something flat

## [0.3.16] - 2026-07-31

### Added
- **A glasses run that dies without a word is still dated.** Nineteen runs were
  recorded on 2026-07-31; thirteen announced their own exit and five were killed
  too abruptly to say anything — the heartbeat simply stopped. A quarter of the
  day's deaths were invisible until someone read the log afterwards, and then
  only by inferring death from an absence of lines, which reads exactly like a
  log that is lagging. That confusion nearly had a live run declared dead the
  same morning
  - The server already knew: `muxClose` drops the relay subscription the moment
    the socket goes. It just did not say which run it was, or that it was
    glasses at all. `unsubscribeGlassesRelay` now reports what it dropped and
    the close writes it down — `[glasses-relay] device gone: [a147] code=1006`
  - Only hardware. A simulator tab closing is not glasses going away, and every
    browser socket passes through the same call, so one that was never
    subscribed reports nothing

### Fixed
- **The glasses app no longer misses the host's launch source** (`v0.0.18`). The
  host pushes it once when loading completes and the SDK keeps no copy — the
  subscription is a plain event listener with no cached getter beside it, so
  whatever is not listening at that moment never finds out. The SDK's own
  troubleshooting table says as much: register it early
  - It was registered after `initDisplay` resolved, which put a full round trip
    to the host in the way — the bridge, then the startup page container, and
    only then a listener. Three runs the same day reached `startup complete`
    having never been told their launch source
  - `initDisplay` now takes a callback and runs it the moment the bridge
    resolves, before it builds the container. On `appMenu` a missed push meant
    the companion settings UI silently not starting; on either source it meant
    the log could not tell a discarded instance apart from one that was simply
    not listening yet

## [0.3.15] - 2026-07-31

### Added
- **The glasses app's setup screens speak Japanese** (`glasses/src/i18n.ts`).
  `glasses/src` had no i18n at all, which is why those screens were written in
  English and stayed there — the rule is that prose we write is English *unless*
  it goes through a translation table, and there was no table. There is one now:
  a lookup, a language and a way to change it, rather than react-i18next, since
  nothing there is React and the ehpk pays for every kilobyte
  - Language comes from a saved choice, then `navigator.languages`, then
    English. The header toggle switches it on any screen and the choice persists
  - The tests check that both tables carry the same keys. `t()` falls back to
    English, so a missing key does not break a screen — it produces one sentence
    in the wrong language, which is exactly the kind of thing nobody notices
  - Phone screens only. What the G2 itself draws stays English: Japanese is
    full-width, so the line widths in `metrics.ts` and the seven-line clamp would
    all have to be re-reckoned, and that is its own piece of work
- **The first setup screen draws the network** rather than describing it. The
  one fact people were missing — that a machine of their own does the work — was
  a sentence in the middle of a paragraph. It is a diagram now: machine,
  Tailscale, phone, Bluetooth, G2, top to bottom
  - **The internet leg is dashed and the local ones solid**, because which hop
    leaves the building is the point of the picture. Tailscale is named as what
    it is: a VPN across your own devices, crossing the open internet so the phone
    reaches that machine from anywhere, encrypted end to end, opening no port for
    anyone else to find. People are right to ask whether this exposes their
    desktop, and the answer belongs where the question forms
  - The machine's box says `awake 24/7`. An agent keeps working while nobody is
    watching, and nothing reaches a phone from a sleeping machine

### Changed
- **The machine does not have to be one you own.** A small VPS is already awake
  around the clock and already has a fixed home, which is exactly what this
  wants — the step says so now, with the sizing and the one consequence worth
  knowing (the agent accounts sign in from there rather than from your desk).
  Every screen said "computer", so the whole surface says "machine" now, the
  step badge included

## [0.3.14] - 2026-07-31

Aimed at one thing: nothing typed by hand that a machine could have handed over.

### Added
- **`hrdle qr` prints this server's address as a QR code**, for the glasses
  app's Connect screen to read. The address is a Tailscale FQDN with a
  random-looking tailnet in the middle of it, and until now the way it reached a
  phone was somebody reading it off one screen and typing it into another. The
  name comes from the same `tailscale status` the server uses to pick its
  certificate, so the code necessarily carries the host that certificate was
  issued for — deriving it any other way produces an address that resolves and
  then fails TLS (`backend/src/commands/qr.ts`)
- **The setup wizard reads that code with the camera** (`glasses/src/qr-scan.ts`).
  One still image through the host's own camera UI (`captureImageFromCamera`),
  decoded with jsQR — no `getUserMedia`, no permission prompt of ours, nothing to
  tear down. Reading it fills the address field and connects, with no second
  press to confirm something nobody typed. The browser build uses a file input so
  the screen is still testable at `?phone`

### Changed
- **`install.sh` finishes the job instead of printing homework.** It used to copy
  the binary and leave four numbered instructions; every one of them was
  something it was standing right next to. It now allows certificate generation,
  registers the service, and ends by printing the QR code — so the last thing the
  installer does is put the address in front of a camera
  - The sudo line is the deliberate exception: `curl ... | bash` leaves stdin
    pointing at the pipe the script arrived through, so a password prompt has
    nowhere to read an answer from. `sudo -n` goes through silently with a cached
    credential and prints the line to type without one
  - `HRDLE_NO_SERVICE=1` installs the binary only
- **The wizard is seven screens rather than nine.** Two of them existed only
  because something else was missing
  - *Phone on the tailnet* could not be checked at all: a WebView cannot see
    whether Tailscale is installed, and reaching anything inside the tailnet
    needs the very address the next screen asks for. Measured rather than
    assumed — Chrome refuses plain HTTP to `100.100.100.100` and to tailnet IPs,
    while HTTPS to the server goes through. Connecting *is* the check, so it is
    one screen with it
  - *Start the server* was a screen because the installer stopped short of doing
    it
  - Both retired step ids map onto their replacements, so a setup in progress
    when this lands resumes where it was instead of restarting
- **The wizard's theme is red**, from the app icon. Brand and state are kept
  apart: the mark, progress bar, headings and buttons are red, while "Connected"
  and the WebSocket `OPEN` stay green — painting a success indicator in the brand
  colour would make it the same colour as "Could not connect". The voice-input
  panel is shared with the browser simulator, so its accent is a CSS variable and
  the simulator keeps the green the G2 actually draws in
- **`hrdle setup` is shown without `-P` first.** The password is optional, and a
  tailnet is usually one person's own devices; asking for one is now the
  alternative rather than the instruction
- **The Tailscale links are App Store and Google Play buttons.** A coloured
  phrase inside a paragraph does not read as something to press on a phone, and
  was reported from the device as "where is the install link?"

### Fixed
- **The copy button on the setup screens copied its own label.** It read the
  command back off the surrounding box, which includes the button — and the
  button says `copied` for a second and a half after a press, which is exactly
  when someone taps it again
- **The last setup screen's footer sat on top of the voice-input fields.** The
  sticky action bar has nothing to advance to there, so it is gone and Disconnect
  lives in the page

## [0.3.13] - 2026-07-30

### Added
- **Setting Hrdle up from the glasses app is a wizard now, one screen at a
  time**. The phone companion screen is the only thing someone who installed the
  glasses app from the store has, and what stands between them and a working
  setup is a computer, two other tools, a command that needs sudo, and a URL
  nobody has memorised. All of that was one scrolling page with a "Setup"
  heading, four bullet points, and the URL field already visible below it —
  which invites a person who has installed nothing to type something into that
  field and fail (`glasses/src/setup-wizard.ts`, `glasses/src/phone-ui.ts`)
  - Nine screens: what Hrdle is, a machine to run it on, a coding agent,
    Tailscale, install, start, this phone on the tailnet, connect, ready
  - **Every screen says whether the work happens on the computer or on the
    phone.** Someone is holding the phone and reading instructions for a machine
    across the room, and "copy this" is ambiguous in exactly the way that wastes
    ten minutes
  - **Connecting is the only real gate.** A server that answers proves herdr,
    Tailscale and Hrdle are all installed and running, so the screens that ask
    about them complete at once rather than being walked through. That one rule
    also gives two more entrances for free: someone returning to a working setup
    sees no wizard at all, and "Already running" on the first screen goes
    straight to the URL field
  - Progress is stored, so closing the app mid-setup resumes where it left off
    rather than starting over
- **The phone companion UI opens in a browser at `?phone`**. It was reachable
  only through the Even Hub app menu on real hardware, so every wording change
  in a nine-screen wizard would have cost an ehpk build and a launch on the
  device. Same rule as the glasses simulator: it is where this is checked first,
  never where it is checked last (`glasses/src/main.ts`)

### Changed
- **`install.sh` installs herdr itself instead of warning and exiting.**
  Stopping there turned a one-line install into "run it, watch it fail, install
  herdr, run the same line again" — and the second run is character for
  character the first, so nothing was gained by making anyone type it twice.
  `HRDLE_SKIP_HERDR=1` opts out. Tailscale stays manual on purpose: it needs
  sudo, its package route differs per distribution, and a half-applied network
  daemon is a worse place to be left than a missing one — the wizard puts it
  before the install step instead, so that failure never comes up

### Fixed
- **The copy button on the setup screens copied its own label.** It read the
  command back off the surrounding box, which includes the button, and the
  button says `copied` for a second and a half after a press — which is exactly
  when someone taps it again
- **The last setup screen's footer sat on top of the voice-input fields.** The
  sticky action bar has nothing to advance to there, so it is gone and the
  Disconnect button lives in the page

## [0.3.12] - 2026-07-30

### Added
- **The glasses' voice input has settings, on the glasses app's own web
  screens**. The Groq key, the transcription language and the vocabulary prompt
  were server-environment values, which meant changing the language or trying a
  different prompt required editing a systemd EnvironmentFile and restarting.
  The panel appears in the phone companion UI once a server answers, and in the
  simulator (`glasses/src/settings-ui.ts`, `POST/GET /api/glasses/settings`)
  - **Language.** It was pinned to `ja` — the endpoint accepted `?lang=` and the
    only caller never passed it — so speaking English was transcribed as though
    it were Japanese. Auto-detect / Japanese / English now, where auto sends no
    language at all and lets Whisper decide. Verified against Groq with one
    audio clip: `ja` returns katakana where `en` and `auto` return Latin text
  - **Key.** Saving one overrides `GROQ_API_KEY`, so a fresh install no longer
    needs shell access to start transcribing. It is write-only: the API takes a
    key and never returns one, reporting only whether one is set and from where
  - **Prompt.** The composed vocabulary prompt shows as the placeholder, so the
    editor starts from what is actually being sent rather than an empty box.
    `off` disables the bias. The glossary is Japanese, which is the other half
    of why English transcription was poor - a language switch alone does not fix
    it, and this is how you replace the words
  - Settings live in `<dataDir>/glasses-settings.json` at 0600, written through
    the same atomic-rename and mutation-lock path as the peer registry
  - Precedence, in each case, is: the saved setting, then the environment, then
    the built-in default. A `?lang=` on the request still wins over all of it
  - **The phone companion UI only gains the panel after `/glasses-upload`**,
    since that screen ships inside the ehpk. The simulator the server serves at
    `/glasses` updates with this release

## [0.3.11] - 2026-07-30

### Changed
- **The Keyboard/Input toggle is a real target now**. It sat at half the height
  of the keys beside it and padded to almost nothing, which made `Input` the
  smallest thing on the bar - measured at 42x20 against the keys' 45x34
  - It is sized against the keys now: **79x30 and 56x30** inside a 138x34 group,
    so `Input`'s tap area roughly doubles (840px^2 -> 1680px^2)
  - The width comes out of the keys' share, since they flex. They go from 45 to
    40px wide, still well above the 34px they were before v0.3.10, and the row
    still ends exactly at the screen edge (measured on a 412px phone with touch
    emulation)
  - The floor is where the padding stops: the keys keep a 38px minimum, so on a
    narrower phone the bar scrolls inside its own row rather than pushing the
    page sideways

## [0.3.10] - 2026-07-30

### Changed
- **The keyboard's action bar fills the row, so the keys are easier to hit**.
  ESC / TAB / ^C / ^E / ^O / the file picker sat at a fixed `min-w-[34px]`
  packed against the left edge, while the keys below them (q, w, e, ...) have
  always flexed to fill the width - so the bar left empty space on the right and
  the targets stayed small. They flex now, the same way the main keys do
  - Measured on an emulated phone (412px wide, touch): each key went from about
    34x30 to **45x34**, and the row now reaches the right edge instead of
    stopping 100px short. The gap between them went from 4px to 6px
  - It adapts rather than being a new fixed number: on a wider screen the keys
    grow further, and removing one widens the rest instead of leaving a hole
  - The tablet's floating keyboard uses the same bar and keeps its compact
    height; it gains the same spread

## [0.3.9] - 2026-07-30

### Removed
- **The URL button in the keyboard's action bar**. On a phone it called
  `handleExtractUrls` in InputBar, whose body was a comment saying the mobile
  path was not wired up: tapping it did nothing at all, and had done nothing
  since it shipped
  - The rest of the feature went with it. The action bar is shared with the
    tablet's floating keyboard, which was the only thing that could open the URL
    menu, so removing the key left DesktopLayout's menu unreachable.
    `detectedUrls` / `showUrlMenu` / `urlPage`, the three handlers, the 90-line
    panel and `Terminal.extractUrls()` are all gone (-140 lines)
  - The `terminal.noUrls` i18n key was already unused (the panel had the string
    inline), and the onboarding step no longer promises a URL list
  - Worth noting for anyone tempted to rebuild it: `extractUrls` scanned
    `term.buffer.active`, which with `scrollback: 0` holds only the visible
    viewport, so even where it ran it saw one screen

## [0.3.8] - 2026-07-30

### Changed
- **The documentation is English too**. v0.3.6 moved the code and this file and
  left the docs behind, which produced `glasses/README.md` explaining an English
  codebase in Japanese, and a `CLAUDE.md` that states an English-only rule two
  sections above two Japanese ones. Now English: `CLAUDE.md`'s hook-notification
  and glasses sections, `glasses/README.md`, `HANDOFF.md`,
  `poc/herdr/FINDINGS.md`, and the five skills
  - Each skill's `description` keeps its Japanese trigger phrases. Those are
    matching data rather than prose: translating them would stop "リリースして"
    from invoking anything
  - The notification table in `CLAUDE.md` was also still listing the Japanese
    hook messages that v0.3.6 replaced
- **`architecture.json` is English throughout** (226 strings), and with it the
  viewer that embeds it. It still called itself "CC Hub Architecture", drew
  `Peer CC Hub` in its diagram and named `cchub send / peek` - none of which
  exist any more
- `README.ja.md` stays Japanese: it is the Japanese README. So do the `ja` i18n
  catalogs, the STT glossary, and the fixtures whose Japanese is the thing under
  test

## [0.3.7] - 2026-07-30

### Fixed
- **The password the env file sets is the password the server reads**. On Linux,
  `setup -P pass` writes into the service env file and startup reads it back -
  except setup wrote a bare `PASSWORD=` while startup looked at
  `CCHUB_PASSWORD`, and nothing reads a bare `PASSWORD`. So the password was
  written, reported as configured, and never used: **the server came up
  unauthenticated while setup said it had set one**. Neither half fails on its
  own, which is how it survived. Both sides compose the name from identity now
  (`HRDLE_PASSWORD`), with a test asserting the writer and the reader agree
  - `CCHUB_PASSWORD` is still read, so an install from before the rename keeps
    working. A bare `PASSWORD` deliberately is not: it is a name other things
    use, and taking it from the ambient environment would switch auth on with a
    password the user never chose for this server
  - Existing installs lose nothing - their env-file password was already being
    ignored. It starts working once `hrdle setup` is re-run, which rewrites the
    file with the name the server reads
  - macOS was never affected: its password lives in the Keychain, which both
    sides already agreed on
- **The rest of the rename's display leftovers**: `hrdle status` announced
  itself as "CC Hub", the cache-clear page carried the old name in its title and
  heading, `status` and `debug` printed `cchub` in their hints, both Anthropic
  clients sent a `cchub/<version>` User-Agent while the `userAgent()` helper sat
  unused beside them, the Codex hook writer named its temp file `.cchub-tmp-`,
  and the STT glossary was still biasing toward the old spoken name
- `.env.example` documented `CCHUB_PASSWORD` and `CC_HUB_DATA_DIR` (the data
  directory has gone through identity for a while, so that one was simply
  wrong), and listed neither `HRDLE_STT_PROMPT` nor `GROQ_API_KEY`

## [0.3.6] - 2026-07-30

### Changed
- **The code speaks English, and stops using emoji**. Comments, log lines, CLI
  output, test names and this file were half Japanese and half English, so every
  reader had to know both, and status was carried by glyphs - a checkmark, a
  warning sign - that say nothing to a `grep` over a log. All of it is English
  now, and status is a word: `warning:`, `error:`, `Hint:`
- **Hardcoded UI strings that never went through i18n were translated too** -
  PeerManager, the glasses simulator and its phone page, the G2 display footers
  and the fallback page in `index.html`. The Japanese product surface is now
  exactly the `ja` locale and nothing else, rather than the locale plus whatever
  happened to be typed inline
- **What stays Japanese is data rather than prose we wrote**: the `ja` i18n
  catalogs, the STT glossary in `stt-prompt.ts`, and the fixtures whose Japanese
  is the thing under test (CJK wrapping, kinsoku, UTF-8 splitting across chunks).
  Two emoji tables stay because they are functional: the substitution map in
  `glasses/src/metrics.ts` that turns emoji into glyphs the G2 firmware has, and
  the file-picker and URL keys whose emoji *is* the label
- **`CLAUDE.md` states the rule** under "Language and Style Rules", exceptions
  listed, so the next change does not have to rediscover them. It covers commit
  messages and PR bodies as well

### Notes
- Tests were updated where they asserted on a string that moved (the relay
  fallbacks, the `--base64` error, the G2 footers, `Summary:` and
  `[code N lines]`). 779 tests pass, lint and typecheck are clean, and the dev
  server was checked against a real herdr: 14 workspaces listed, the dashboard
  answering, `/glasses` served
- The Japanese documentation is untouched on purpose - `README.ja.md`,
  `architecture.json`, `specs/`, `HANDOFF.md` and the skill files are documents
  rather than code, and `README.ja.md` exists to be Japanese

## [0.3.5] - 2026-07-30

### Added
- **A "Save PNG" button in the simulator**. The EVEN Hub store listing supplies
  its own background for each Environment (Home / Office / Store / Cafe) and
  composites the app's own drawing onto it. A submitted image must therefore be
  the drawing and nothing else, and a screenshot of the lens element bakes the
  simulator's background in, so the room appears twice. `#g2-canvas` already has
  the shape Hub asks for - 576x288, background alpha 0, lit pixels green with 16
  alpha levels - so this button saves rather than converts. The file name carries
  the mode (`hrdle-glasses-conversation-....png`)

### Changed
- There are now three ways to capture the glasses screen, and `CLAUDE.md` says
  which is for what. "Copy screen" is for wrapping, line counts and clipped
  characters; `screenshot "#lens"` is for **whether the green survives in front
  of a bright wall** (the G2 is a see-through display, so text can never answer
  that); "Save PNG" is what gets submitted. Yesterday's rule said "paste text
  into an issue rather than a screenshot" - actually taking the captures is what
  showed that to be wrong
- Also recorded the `getUserMedia` substitution for exercising the simulator's
  audio headlessly. With no audio device `startMicCapture` fails and the screen
  jumps straight to "(nothing was recognized)" - which looks like a transcription
  bug and is not one

## [0.3.4] - 2026-07-30

### Changed
- **The icon is a scanner now** ([#23](https://github.com/hrdle/hrdle/pull/23)).
  The old one was `Hr`, cc-hub's mark with the letters swapped, built to be
  **read** - which left nothing to go on below 32px. The new one lines up 11
  lamps in a slit and lights only a few of them. The light sits left of center
  (0.33) so the thing reads as mid-sweep rather than parked. The band folds into
  a shallow V rather than running level (`S x 0.028`, about 4 degrees) - the nose
  it descends from peaks at the center - and the frame, every single lamp, the
  recess behind them, the glass and the height of the light all ride that fold.
  A level version looks plausible enough alone; side by side it does not
- **The PNG and the SVG are built as different things**. `icon-512.png` /
  `icon-192.png` are Canvas renders carrying the hairline, the grain and the
  glass reflection, quantized to 256 colors to take 512px from **284KB to 40KB**.
  `favicon.svg` is a stripped-down version drawn from the same geometry with none
  of the texture (at 16px it collapses into mud, so the shape has to carry it
  alone). The geometry parameters are left as a comment at the top of the SVG
- **The glasses app (EVEN Hub) icon follows the same design**. Their spec is
  **24x24 monochrome, and the Hub editor's brush is fixed at 2x2** - effectively
  a 12x12 pixel drawing, where the V's fold does not even reach 1px and reads as
  a chip rather than a step, so that one is level. What survives is the single
  idea: a wide slit with a few lamps lit, left of center

### Notes
- `theme_color` stays `#1a1a1a`. That is not the icon's color but the UI's own
  background, shared by `index.css`, `terminal-themes.ts` and `useTheme`

## [0.3.3] - 2026-07-30

### Fixed
- **A voice reply was addressed to a pane in a different workspace than the one
  being replied to**. `selectedPaneId` is wherever the list cursor last stopped,
  and several paths move `sessionIndex` alone (reordering the list, opening a
  conversation from a relay item, resume). The result was a state that sent
  `life`'s pane `%6` to `hrdle-work-1`; the server correctly answered 404 and the
  glasses swallowed it - the item was marked answered and the screen returned to
  the conversation, so **a reply that never arrived looked exactly like one that
  did**. The reply target now resolves against the workspace that is open (an id
  that does not belong to it drops out and becomes "the active pane"), and a
  failed send keeps the confirmation screen up so a tap can retry. Every
  workspace has a `%1`, which is why this happened to work until you picked
  anything past the first pane of a multi-pane workspace
- **Codex conversations could not be read from the glasses or the history**. Both
  routes to a transcript go through the id herdr reports, and that id existed
  neither in the `threads` table nor in a rollout file name. herdr reports the
  `session_id` from the `SessionStart` hook the Codex integration hands it, and
  **another Codex process emitting its own `SessionStart` steals the pane's
  stored id** ([ogulcancelik/herdr#1789](https://github.com/ogulcancelik/herdr/issues/1789);
  fixed on master and shipped in preview, but not in 0.7.4). A third route now
  runs only when the two precise ones miss: ask herdr for that session's cwd and
  read the newest rollout in the same directory. It exists **to be deleted once
  the herdr fix reaches stable**, and the TODO in the code lists what to remove

### Changed
- **The glasses app was re-registered with EVEN Hub as `Hrdle`
  (`com.hrdle.glasses`)**. Hub treats `package_id` as immutable, so a rename can
  only happen by creating a new project. Build history, testing group and store
  listing do not carry over, and the version starts again from v0.0.1 (v0.0.3 is
  in Beta now). The old `com.m0a.cchubglasses` stays Private as a fallback
- The repository's skills were renamed to `hrdle-*` and collapsed to one copy.
  `cchub-test` was still driving the dev ports the rename moved (3456/5173) and
  an old working directory; `cchub-profile` was operating a `cchub.service` that
  no longer runs. The parallel copies under `.agents/skills/` that `AGENTS.md`
  forbids are gone (they pointed at a `.Codex/` path that does not exist)
- The STT override environment variable is now `HRDLE_STT_PROMPT`. An `envVar()`
  helper composes it from `identity.json`'s `binaryName`, so the next rename
  follows automatically
- Added the rules for working on the glasses to `CLAUDE.md` (simulator support is
  part of the implementation, and the simulator gets checked before a release).
  The simulator and the device disagreed four times in two days, and every one of
  those was found on the device after the work had been called done

## [0.3.2] - 2026-07-29

### Fixed
- **The glasses conversation view came up empty for kimi sessions**
  ([#5](https://github.com/hrdle/hrdle/issues/5)). The history API reads Claude's
  jsonl by default and only reaches a thread agent's transcript (kimi/codex/grok)
  when `?agent=` names it. A query without the name is not an error but an
  **empty answer**, so the G2 showed `(no messages)` and the agent looked like it
  had said nothing. Sending a voice prompt worked the whole time; only the answer
  was unreadable. The glasses now name the agent the way the web UI does, and
  take the `agentSessionId` a thread agent carries in place of `ccSessionId`. The
  server returns one or the other, so looking only at the latter left a kimi
  workspace with no conversation to open at all. This also fixes an older bug
  where paging back ignored the pane and re-read the workspace's Claude
  transcript (scrolling back through a pane's conversation swapped in a different
  one)
- **The STT override variable did not carry this product's name**
  ([#14](https://github.com/hrdle/hrdle/pull/14)). `CCHUB_STT_PROMPT` was
  hardcoded at the call site and so survived the rename by a day - exactly the
  failure `shared/identity.ts` exists to prevent. It is now `HRDLE_STT_PROMPT`,
  composed by `envVar()` from `binaryName`. It first shipped in v0.3.1 and nobody
  has it set, so there is no fallback

### Notes
- **The glasses are never done on the simulator alone**
  ([#16](https://github.com/hrdle/hrdle/pull/16)). `debug-ui.ts` goes through the
  same `GlassesController` and `screenText()` the device does, and still drifted
  from it four times in two days on character width, paging and glyphs. CLAUDE.md
  now spells out the order: check on the simulator, release, check on the device
- `glasses/src` changed, so **reaching the real G2 needs the ehpk rebuilt and
  uploaded** (`/glasses-upload`). The simulator served at
  `https://<host>:5924/glasses` updates with this release

## [0.3.1] - 2026-07-29

### Added
- **A vocabulary prompt is passed to speech recognition**. Whisper treats the
  initial prompt as "the transcript that just came before" - the supported way to
  tell it which words are coming. Left empty it guesses from Japanese at large,
  so `herdr` is not in its vocabulary, `pane` comes back as `paint`, and the
  user's own coinage `2-legged robot dev` comes back spelled another way. That
  last one is more than a spelling problem: the glasses hand this text straight
  to an agent, so a name that does not match is a name that cannot be resolved.
  `services/stt-prompt.ts` composes the prompt per request from live state:
  **custom titles -> glossary (34 terms) -> herdr labels**. That order is the
  point of the design; the first cut put names first, 13 workspaces ate two
  thirds of the 190-character budget, and `release` - a word said several times a
  day - never made it in. Labels go last because Latin-script directory-ish names
  are not read as Japanese words in the first place. `CCHUB_STT_PROMPT=off`
  disables it, and any string can be substituted for A/B testing
  ([cc-hub#664](https://github.com/m0a/cc-hub/pull/664))

### Changed
- **The glasses app was renamed to Hrdle and restarted as a new EVEN Hub
  project** (`com.m0a.cchubglasses` -> `com.hrdle.glasses`, v0.1.62 ->
  **v0.0.1**). Hub treats `package_id` as immutable (the store listing displays
  it with no Edit), so changing the id means uploading the ehpk as a new project.
  55 builds of history, the testing group and the store listing do not carry
  over; the old project stays Private as a fallback
- The glasses' display name, binary name, repository URL and storage prefix are
  injected from `identity.json` at build time. No product-name literal is left in
  `glasses/src` (`app.json` is the exception - `package_id` and `name` are read
  before the bundle exists)
- The glasses' localStorage keys moved to the `hrdle-` prefix. Old keys are read
  **only when reading** (`glasses/src/storage.ts`). Because of that, "disconnect"
  and "reset the background" clear every generation of the key - a leftover old
  key would reconnect to the same server on the next start

### Fixed
- A stale hook override could beat live herdr status on the pane indicator
- The `hrdle update` hint now names the binary you actually have

### Notes
- The vocabulary prompt's A/B was measured with **Gemini TTS synthetic speech**
  (the coinage came back stably, latency 350-450ms with no regression). **Its
  effect on real microphone audio is unverified**, so if speaking into the device
  still garbles things, terms and budget will be adjusted
- **Hallucinations on silence and very short clips are not fixed** (the usual
  Japanese sign-off phrases). The prompt does not remove them; a length and
  volume floor is needed separately

## [0.3.0] - 2026-07-29

The first release as Hrdle. The contents are identical to cc-hub v0.2.98; only
the values in `identity.json` differ (zero code diff).

### Changed
- **Renamed from CC Hub to Hrdle**
  ([#459](https://github.com/m0a/cc-hub/issues/459)). Rewriting `identity.json`
  carries everything composed from it - systemd unit, launchd label, data
  directory, scratch paths, Keychain, localStorage keys, hook command and
  detection patterns, CLI help, PWA manifest - along without a call site
  changing. The groundwork upstream (`m0a/cc-hub`: #635 / #637 / #653 / #655 /
  #658 / #668 / #672) is what reduced the rename itself to editing one file
- **The default port is 5924**. It was chosen to run alongside cchub during the
  migration, and it stays 5924 afterwards. Leaving 5923 free means starting cchub
  is all it takes to go back if something breaks - the ports do not collide, so
  both can run at once. The dev ports moved one along too (3457 / 5174) so both
  products' dev servers can run at the same time
- **The tagline is now `Coding Agent Session Manager`**. It has handled Claude /
  Codex / Grok / Kimi for a long time, and the name was the first thing to stop
  matching that
- The icon keeps its construction (rounded charcoal, green monospace, progress
  bar underneath) with `CC` becoming `Hr`

### Notes
- The update paths are separate: cchub from `m0a/cc-hub`, hrdle from
  `hrdle/hrdle`. Reads from cc-hub do not change after archiving, so
  `cchub update` keeps resolving up to v0.2.98. **The fallback to the old
  environment is preserved**
- While both run, hooks fire into both. A notification received by the server
  that does not own the session has no matching session to open, so the only real
  cost is a duplicate notification

## [0.2.98] - 2026-07-29

### Fixed
- **Ports and display names go through identity** (#672): actually running the
  rename on a fork surfaced a batch of values that never went through identity.
  `identity.json` still returns cchub / 5923 / 3456, so behavior is unchanged
  - **`cli.ts` bound a different port than `--help` printed**. Help started
    reading the port from identity in #658, while the `DEFAULT_PORT` that
    actually binds stayed hardcoded. Under the current name they happen to match;
    after a rename **the number help prints and the number it binds diverge, and
    it goes after the port the product being replaced is using**
  - **`index.html`'s FOUC script read a localStorage key that had moved**.
    Namespacing in #653 left the bare `<script>` behind, so **the pre-first-paint
    theme check kept reading a key the app no longer writes** (a pre-existing bug
    unrelated to the rename). A `transformIndexHtml` plugin (`enforce: 'pre'`)
    now injects the placeholder at build time and walks the same prefix list
    (legacy included) the app itself does
  - **`glasses.ts` kept its own production/dev ports next to `notify.ts`'s**.
    After a rename a `cchub glasses` note flies to another product's server
  - **The conversation view's image path regex** hardcoded `/tmp/cchub-images`. A
    changed `tmpPrefix` makes it **match nothing**, degrading every screenshot in
    a conversation to a raw path
  - The startup banner and the title of a hook notification with no cwd now go
    through identity as well
  - So do the dev ports (vite's `server.port` / proxy target / playwright's
    `webServer.url` / five e2e specs). The frontend dev port had no home in
    `identity.json`, and a `playwright.config.ts` value that drifts from vite's
    fails **not as a test failure but as a 120-second wait ending in "the dev
    server did not start"** - hence `frontendDevPort`
  - **`shared/identity.ts` could not be imported from Node**. Bun and Vite accept
    a JSON import with no attribute; Node requires one. The moment
    `playwright.config.ts` became the first consumer outside Bun/Vite, the tests
    died on `ERR_IMPORT_ATTRIBUTE_MISSING` without running a single case
- **The dev server was one step from grabbing the production port** (#672): the
  change above removed `-p 3456` from the backend dev script, leaving the port
  decision to "does argv contain `--watch`". **bun does not pass `--watch` into
  the child's argv, so that check is always false** and the dev server binds the
  production port (EADDRINUSE with a service installed; without one, dev occupies
  5923 and vite's proxy hits nothing). It also produced a combination where
  **stop does not free the port dev grabbed**, since `bun run stop` only clears
  3456/5173. `scripts/dev-backend.sh` now reads `devPort` and passes `-p`, and
  the check itself was **deleted rather than repaired** - the same default is the
  local target of `cchub send` / `cchub peek`, which should aim at the installed
  service, so making the check work would silently point a CLI started in dev at
  the dev server
- **The glasses phone UI completed a port-less URL with the old port** (#672):
  `phone-ui.ts` appended `:5923` as a literal. That is not a label but **where
  the device actually connects**, so after the rename it reaches the old
  product's server. It is injected through `define` now (not `import`, because
  glasses/src deliberately does not depend on shared/ and the ehpk ships to the
  device)

## [0.2.97] - 2026-07-29

### Fixed
- **Close three gaps a rename walks straight into** (#668): rewriting
  `identity.json` to Hrdle on a fork and running it surfaced three copies of a
  name that nothing checks, all of them pre-existing on the cc-hub side. They
  were extracted under the cchub name, so behavior is unchanged (`build.sh` still
  emits `dist/cchub`, and the tests still escape to a temp dir)
  - **`scripts/build.sh` carried its own `dist/cchub`**. It is the one consumer
    positioned to read `identity.json` and did not. `release.yml` renames
    `dist/<binaryName>` while `identity-consistency.test.ts` only cross-checks
    `release.yml`, so **a drift goes unnoticed until a release build fails**. It
    reads `identity.json` now and exits non-zero on a missing key (a missing key
    prints `undefined` and exits 0, which slips past `set -e`, produces
    `dist/undefined`, and only fails at CI's rename step)
  - **Four tests hardcoded `CC_HUB_DATA_DIR`** (`sessions.test.ts` /
    `jwt-secret.test.ts` / `peer-registry-lock.test.ts` /
    `session-metadata-lock.test.ts`). Renaming the env var does not make those
    lines fail; it makes them lines that set nothing, and **the tests pass while
    writing fixtures into the real data directory**. On the fork `~/.hrdle` duly
    filled with 20 fake sessions. It shows up as contamination rather than
    failure, so a green suite hides it
  - **The scan in `identity-operational.test.ts` was itself a literal**. It keeps
    passing after a rename while only looking for a name that no longer exists.
    The patterns are composed from `IDENTITY` now
- **That scan excluded the test directories wholesale** (#668): the exclusion
  added with the scan in v0.2.94 (#657) was `/tests/|__tests__/`, so **the four
  files above could not be detected in principle**. The exclusion is now limited
  to the four files where holding a literal is the point (`shared/identity.ts`
  and the three tests with goldens), and `backend/tests` was added to the scan.
  Verified both ways: zero new detections on the current tree, and a planted
  violation reported with file name and line number

### Changed
- **Glasses: read what the host returns about drawing** (#667): every drawing
  call the SDK exposes returns a result, and every one of them was thrown away
  (`createStartUpPageContainer` returns success/invalid/oversize/outOfMemory;
  upgrade / rebuild / shutdown return booleans). It cost more than a log line:
  **`drawn`, the record that skips a container write when no write is needed, was
  caching rejected content as though it had reached the screen**, so the resend
  the comment promises never happened and the container stayed stale. A rebuild
  the host rejected was worse still - the mode was recorded as sent, so every
  later frame considered the geometry current and skipped the rebuild

## [0.2.96] - 2026-07-29

### Fixed
- **The "crash" was an exit. Return the root screen's double tap to the host**
  (#665, glasses v0.1.60): two days were spent chasing `host exit: system` as a
  crash, and [Even Realities' official reference](https://github.com/even-realities/everything-evenhub/blob/main/plugins/everything-evenhub/skills/handle-input/SKILL.md)
  had it defined all along
  - `SYSTEM_EXIT_EVENT` (7) = **System-level exit (e.g. user confirmed exit
    dialog)**. Abnormal termination is `ABNORMAL_EXIT_EVENT` (6), and **this app
    has never received one**. All 18 were `system`
  - **Why it exited unintentionally**: the review requirements say "Please ensure
    double tapping at the root page **on OS** can invoke exit dialogue", so
    **double tap on the root screen means exit as far as the OS is concerned**.
    This app was using it for the waiting overlay. The gesture meant to look at a
    notification summoned the exit dialog, and confirming it looked exactly like
    a crash. The heartbeat stretching from 30s to as much as 60s just before
    death (12 of 18) fits too, if you read it as the WebView going to the
    background while the dialog was up
  - The root screen calls `shutDownPageContainer(1)`. Mode `1` (cancelable), and
    **it does not clean up** - nothing is decided yet, and unsubscribing early
    would leave an app that does not respond after the dialog was cancelled
  - **No overlay is lost**. Waiting items open themselves on arrival and on
    reconnect. What is lost is only reopening one that was closed, and the count
    remains in the footer
  - It was also a guaranteed rejection had it been submitted for review
- **The glasses do not draw while another app is on screen** (#665, glasses
  v0.1.60): the log showed `writes` still climbing after `foreground: exited`.
  The host **discards drawing from the background before it reaches the screen**,
  so this was BLE traffic to a panel nobody was looking at. Drawing, the spinner
  and auto-advance now stop, and one full screen is drawn on return. A recap also
  holds its reading position

### Changed
- **The `host exit` line carries the gesture that preceded it** (#665):
  `host exit: system fg=0 gesture=doubleTap@0.4s`. That turns the explanation
  above from an argument into something checkable - a double tap just before
  means an exit, its absence means something else

## [0.2.95] - 2026-07-29

### Changed
- **The recap is two lines now, and scrolls by character** (#660, glasses
  v0.1.59): from the device - "scrolling a line at a time looks like the screen
  switched to something else; shave it a character at a time and let it slide".
  A line step is a 27px jump, and the reader had to hunt for where in the
  sentence they were, every time
  - Each step **drops 10 characters from the front and re-wraps the rest**. The
    whole block slides left
  - **10 characters / 2.5 seconds = 4 characters per second**. The same reading
    speed as the approved "5 seconds per line", cut into thirds of a line. The
    two constants set the reading speed together, and **only their ratio sets the
    drawing frequency**, so moving one alone changes the speed
  - The recap went from three lines to two. The 27px it gives back goes to the
    conversation. Reaching the end still means 15 seconds of stillness, a jump
    back to the top, and a stop after two passes
  - **This also fixes content skipping in a recap made of short lines**. When one
    step overruns "the amount visible as two lines", a line scrolls past without
    ever appearing. Prose never reaches that, but scrolling exists precisely to
    fix "you cannot see all of it", so the step width is capped by what is
    visible
  - Fixed the simulator's "Copy screen" dropping the recap too (`lastScreen`'s
    type had no `notice`). Same shape as the mirror fix earlier, on a different
    path
- **Do not send the panel content identical to last time** (#661, glasses
  v0.1.59): the device log showed **a full-screen redraw 0.2 times a second,
  forever**, just sitting in the session list. The 5-second `sessions-updated`
  push redrew every time without checking whether anything had changed. Idle, the
  only thing that actually changes is the footer clock, once a minute
  - The record is per container, and an update that changes nothing is not sent.
    The record is written **after the device accepts the write** (treating a
    failed update as sent means it is never resent)
  - **The record is dropped on resume**. Across a suspend the host may have torn
    the page down, and a stale record skips exactly the write that would restore
    the screen. A blank screen is far worse than one rebuild
  - **This is not a crash fix**. v0.1.58 died once after 985 draws and once after
    217, so neither rate nor total explains the deaths. Every one was
    `host exit: system`, with no JS exception and a flat heap
  - The original reading - "crashes only happen after going to the background" -
    was **an artifact of how the logs were aligned**. Re-cut per startup, 7 of
    them died with no background transition recorded
  - Instead the heartbeat gained **`fg=1/0`** (from the host's own
    foreground/background events, also stamped on the `host exit` line) and
    **`writes=`** (container writes actually sent). The next death will say which
    side it was on instead of inviting a guess, and the gap against `renders=` is
    the only way to measure this change on the device

## [0.2.94] - 2026-07-29

### Changed
- **Three more silently-breaking names moved into identity, and a scan to keep
  them there** (#657): sorting the remaining literals ahead of a sweep over
  display strings turned up three that were operational rather than display. All
  have the shape of #635 / #637: **a rename breaks them and nothing looks broken**
  - `cchub.service.d` in `debug.ts` - systemd only reads `<unit>.d/`. Writing a
    drop-in for a unit that does not exist is not an error, and
    `cchub debug enable` silently fails to enable the inspector
  - `basename(execPath).startsWith('cchub')` in `notify-command.ts` - this
    decides what gets written into the user's Claude/Codex hook configuration.
    Notifications stop with nothing in any log
  - The hook detection regex in `codex-hook-config.ts` - used to recognize an
    existing entry. Once it stops matching, a second copy of the same hook is
    appended
  - **The real fix was for what let them through**: both prior audits were done
    by eye. Added a test that walks the tracked sources and checks that unit
    names, launchd labels, `/tmp` paths and the data directory are not literals
    outside `identity.ts` (`backend/tests/unit/identity-operational.test.ts`).
    Verified by planting a violation in an unrelated file and seeing it reported
    with file and line. Deliberately narrow: only names that have to match
    something to work, and never comments or log lines
- **The message catalogs name the product through identity** (#658): text that
  tells the user what this product is called was the last large block outside
  `identity.json` (28 places in the backend catalog, 6 in the frontend one, 16 in
  the CLI help)
  - **Not one call site changed**. Both catalogs already interpolated
    `{{param}}`, so only the injecting side moved. In the backend, `t()` merges
    the identity set (`product` / `bin` / `port` / `service` / `configDir` /
    `keychain`) underneath the caller's arguments; in the frontend, `product` /
    `bin` go to i18next's `defaultVariables`. A caller passing the same key
    explicitly wins
  - **Note for a rename**: the CLI help aligns its columns with literal spaces,
    so a name of a different length needs them adjusted by hand (`cchub` and
    `hrdle` both being five characters is luck). Recorded as a comment where the
    parameters are defined
  - The mechanism is invisible from where the strings are used, and losing
    `defaultVariables` puts a literal `{{product}}` in front of the user -
    including in the hook setup prompt, which is handed to an agent that then
    edits the user's configuration file. So two tests were added: one imports the
    app's own i18n module and checks the real init, the other scans both catalogs
    for surviving `{{product}}` / `{{bin}}`. Verified that deleting
    `defaultVariables` reports three strings by key
  - Help output is byte-identical to before in both en and ja

## [0.2.93] - 2026-07-28

### Added
- **Can run on a herdr named session** (#655): #459 has cchub and hrdle running
  side by side on one machine for a while. Sharing one herdr server means each
  one's workspaces appear in the other's list and they fight over the same panes
  (#520 with the volume turned up). herdr already has named sessions, which
  separate the server, the socket, the workspaces and the persistence wholesale,
  so `HERDR_SESSION` selects one. **Unset, behavior is exactly as before**
  - **`HERDR_SESSION` takes priority over `HERDR_SOCKET_PATH`**. herdr injects
    `HERDR_SOCKET_PATH` into every pane it starts (alongside `HERDR_ENV` /
    `HERDR_PANE_ID` / `HERDR_WORKSPACE_ID`), so that variable comes from the
    environment rather than from intent. The obvious priority (an explicit socket
    wins) would make the most natural way to test this - start it from a terminal
    inside another instance - ignore the session and connect to the same server,
    while looking like it worked
  - **The server is started with `--session`**. `HERDR_SOCKET_PATH=... herdr server`
    binds that socket but reports `logs: ~/.config/herdr/herdr-server.log`: the
    socket moves and the session directory does not, so two servers write the
    same `session.json` (the workspace restore data) and lose each other's state.
    An inherited `HERDR_SOCKET_PATH` is explicitly dropped from children so it
    cannot come back
  - **The socket is stated explicitly to child processes** (`herdrChildEnv()`).
    `PaneController`'s `herdr terminal session control` and herdr-update's
    `herdr status` both relied on inheritance alone. Under systemd there is no
    inherited value, so a `HERDR_SESSION` server was being watched while the
    default session's panes were being driven
  - Verified: from `HERDR_SESSION` set and no server running, startup brought a
    server up and `herdr session list` showed a session with its own socket and
    its own `herdr-server.log`. Confirmed down to the two instances disagreeing
    at the same moment on the same host - live=0 on the named side, live=10 on
    production

## [0.2.92] - 2026-07-28

### Changed
- **Namespace the localStorage keys and carry the old ones over** (#653): the
  third pass of the identity work (after #635, #637). **This is the only place a
  rename (#459) actually costs the user something**, and 40 keys hold the theme,
  UI scale, language, keyboard position, input history and auth token. Renaming a
  localStorage key does not fail; it forgets (the theme resets and everyone is
  signed out)
  - Call sites write a setting name rather than a key (`storageKey("theme")`),
    and `migrateLegacyStorage()` carries values from the old prefix to the
    current one (`frontend/src/utils/app-storage.ts`, 24 files)
  - **A copy, not a move**. The rename assumes old and new builds run alongside
    each other, and deleting the key the old build reads signs it out the moment
    the new one starts - inflicting the exact failure this machinery exists to
    prevent, on the other build
  - The migration runs when `app-storage.ts` is loaded rather than from
    `main.tsx`. ES imports are evaluated before the importing module's own body,
    so `import "./i18n"` (i18next reads the stored language at init) finishes
    before any statement in main.tsx. Inverting that order makes a namespaced key
    unreadable without loading the module that carries the old one over
  - **Normalizing `cc-hub-token`**: that one key was spelled with hyphens while
    the other 39 used `cchub-`. It becomes `cchub-token` here, so the rename is
    not this migration code's first run in production. Existing logins survive it
  - The CustomEvent names (`cchub-image-zoom` / `cchub-conversation` /
    `cchub-input-echo`) are a different namespace from localStorage and their
    listeners live in files outside this conversion, so they were left alone.
    Prefixing only the dispatch side silently breaks the pair the moment the
    prefix changes
  - Verified in the browser: planted `cc-hub-token` and another legacy key,
    reloaded, and confirmed both appear on the `cchub-` side with their values
    intact, the originals remain, an existing `cchub-theme` is not overwritten,
    and unrelated keys are untouched

## [0.2.91] - 2026-07-28

### Fixed
- **Glasses: stop auto-advance after two passes (suspected of drawing enough to
  get killed by the host)** (#651): after auto-advance reached the device, the
  rate at which the host killed the app jumped (ehpk v0.1.58)
  ```
                      host exit   median lifetime   longest
  before auto-advance  0.8 /h         26.3 min      114 min
  after auto-advance   6.7 /h         12.3 min       15.6 min
  ```
  - **Zero JS exceptions, flat heap**. It is not crashing - it is
    `host exit: system`, the phone ending it. The only thing that changed just
    before is **how much this app draws**
  - Looping was right; **looping forever was wrong**. As long as a conversation
    was open, worn or not, all four containers were redrawn over BLE every five
    seconds
  - **Two passes, then it stops**. One pass is easy to miss, and a third is drawn
    for someone who is no longer there. Five minutes of drawing goes from 60 to 8,
    and to 0 on a screen with nothing to send
  - A ring gesture resets the pass count (a reader has arrived). It settles at the
    **top** of the recap, not its last three lines. Paging finishes before it
    settles
  - **Causation is unproven**: the bad-looking window is only 48 minutes long and
    the ehpk was swapped three times inside it. Three of the five exits were
    update-driven and two were spontaneous - not a difference two samples can
    carry. But the mechanism is ours and it is cheap to fix

## [0.2.90] - 2026-07-28

### Fixed
- **Glasses: the recap scroll rewinds / the last line flashes past** (#649): the
  report from the device - "it jumps back to the start right after it finishes
  scrolling" - had **two causes** (ehpk v0.1.57)
  - **The rewind was a bug introduced in #644**. `noticeWindow = 0` was inserted
    **mechanically at every** `conversationPage = 0`, and two of those are inside
    `loadConversation`, **which runs on every refresh of a conversation that is
    already open**. Every time the agent said anything, the recap rewound to line
    one. The cause was bulk insertion without reading the callers. The two
    refresh-side inserts are gone; the reset when a different conversation opens
    stays
  - **It turned around the instant it reached the end**, so the last line was on
    screen for less time than any other - and the last line is the one worth
    waiting for. It now holds for one page interval (15 seconds) before going
    back
    ```
     0s  scroll starts    5s  scrolling   10s  scrolling
    15s  reaches the end  30s  back to the top  35s  scrolling ...
    ```
  - **It returns rather than stopping** because someone who looks up a minute
    later should be able to read the recap from the beginning. Paging takes its
    turn before the recap's loop, so a looping recap never pushes the body off
    screen

## [0.2.89] - 2026-07-28

### Changed
- **Glasses: the recap scrolls slowly, one line at a time** (#647): two pieces of
  device feedback on v0.2.88's auto-advance, together (ehpk v0.1.56)
  - **A three-line band advancing every five seconds rushes the reader**. The
    number that came back from the device is **five seconds per line** (three
    lines in 5s is fast, three lines in 15s is right)
  - **Scroll, not page**. Switching three lines at a time replaces the whole band
    and **loses the place mid-sentence**. It flows one line at a time, keeping
    two of the three
    ```
     0s: Summary: the LiPo and the charger are still to be chosen. Of the
         priority-B items this is the easiest to get wrong.
         The buck converter, wiring and tools follow mechanically, so once
     5s: priority-B items this is the easiest to get wrong.   <- two lines stay
         The buck converter, wiring and tools follow mechanically, so once
         the charger is settled the rest is automatic.        <- one is new
    ```
  - **The pricing is proportional to lines gained per step**. A recap scroll is
    one line = 5 seconds; a page turn is the whole body = 15 seconds. It is not
    seven lines' worth (35 seconds) because a page is not re-read from the top -
    you pick up where you were
  - There is still one clock (it ticks at the shorter interval and paging counts
    ticks). A second timer would make two rhythms interfere

## [0.2.88] - 2026-07-28

### Added
- **Glasses: what was cut off becomes visible if you wait** (#644): a 7-line
  screen cannot hold the recap and the conversation at once, so the recap ended
  in `...` - **saying there is more with no way to reach it**. Long waiting
  banners and any message past its first page had the same problem (ehpk v0.1.55)
  - **The clock walks the overflow**: the notice band one window at a time, then
    the message's pages, one step every five seconds
    ```
    -- at 0s --                        -- at 5s --
    Summary: the LiPo and the charg...   the rest is automatic.
    this is the easiest to get wrong.    tomorrow's plan is to look at the...
    The buck converter and wiring fo...   about 5,000 yen.
    --------------------------------    --------------------------------
    Continuing the shopping question.    Continuing the shopping question.
    ```
  - **Only one thing moves at a time**. A screen where the recap scrolls while
    the conversation pages cannot be read at a glance, and this screen is never
    read any other way
  - **It stops at the end. It does not loop** - arriving and staying is what
    "you have read all of it" looks like
  - **It waits ten seconds after a ring gesture**. It never takes control while
    someone is working the ring, and ten seconds is long enough not to mistake a
    pause between gestures for finishing
  - **Five seconds a step**. Each step redraws over BLE, so it is deliberately
    slow, matched to the sessions push so the panel does not carry two rhythms
  - Tool lines (`[Bash] ...`) are excluded: their truncation is horizontal, so
    this vertical walk would never reveal it

## [0.2.87] - 2026-07-28

### Fixed
- **Glasses: the device mirror dropped the recap band** (#642): the recap showed
  on the device but not in the mirror. The mirror **rebuilt the received screen
  field by field**, so the `notice` added in #639 was never named and vanished
  ```ts
  paint({ header: screen.header, body: wrapForPanel(screen.body), footer: screen.footer }, screen.mode)
  //                                                                              ^ no notice
  ```
  - The local drawing path spreads `{ ...raw }` and was fine. **Of the two paths,
    only one dropped it**
  - The field is named explicitly now, with a comment recording why it was
    dropped. Switching to a spread would fix today's case and leave no readable
    reason when the next field is added
  - **No ehpk needed**. The device has been sending `notice` from the publisher
    side since v0.1.54; the receiving mirror is the simulator bundled with the
    server binary

## [0.2.86] - 2026-07-28

### Changed
- **Glasses: draw the separator instead of typing it, and win a line back**
  (#639): the divider between the recap or question banner and the conversation
  was a **line of text**, `------------------------`. That is **27px, one of the
  reader's seven lines**, spent on a rule (ehpk v0.1.54)
  - The panel can draw a line itself. `TextContainerProperty` has `borderWidth`
    (0-5) and `borderColor` (0-15 levels), and **every container in this app had
    them at 0**
  - The notice became its own container with a 1px border. The rule costs **6px**
    including padding, under a quarter of the old 27px
    ```
    situation        notice lines  rule   body lines   old
    no notice             0         0px       7         7
    1-line recap          1         6px       6         5   +1
    2-line recap          2         6px       5         4   +1
    question banner       2         6px       5         4   +1
    ```
  - **On rebuild cost**: this app talks over BLE, where rebuilding a page is
    expensive, so it only happens on a mode change. `updateDisplay` looks at the
    notice's **line count**, not its text, so changing the wording is still a
    partial update. A rebuild happens only when the notice appears, grows or goes
  - The simulator and the mirror draw the same border from the same constants.
    Concatenating it into `body` would let a window claiming to "draw what the
    device draws" show a different screen, so `GlassesScreen` carries `notice`
    separately too

## [0.2.85] - 2026-07-28

### Changed
- **Runtime paths move into identity as well** (#637): #635 collected the names
  the installer and the service manager use, and left **the paths the running
  server touches**. Those are the worse half, because getting them wrong does not
  fail
  - **`/tmp/cchub-images` existed as three separate literals** (the static route
    in `index.ts`, `routes/upload.ts`, `routes/files.ts`). It worked only while
    all three agreed, and nothing checked that they did. One drifting means
    uploads land in a directory nothing serves, and the only symptom is a 404
  - A drifted `/tmp/cchub-usage-history.json` returns **an empty history** rather
    than an error (it looks like "no usage yet")
  - The macOS Keychain service name is where the server's password lives.
    Changing it does not fail startup - **it starts without a password**
  - Added `tmpPrefix` / `browserLogName` / `keychainService` to `identity.json`
    and routed everything through `TMP_PATHS` in `shared/identity.ts`
    (`backend/src/index.ts`, `routes/logs.ts`, `routes/upload.ts`,
    `routes/files.ts`, `services/usage-history.ts`, `utils/keychain.ts`)
  - `/tmp/cc-hub-browser.log` was recorded with its current hyphenated spelling
    rather than normalized to `tmpPrefix`. CLAUDE.md points at that path as a
    `tail -f` target, which makes the inconsistent spelling load-bearing. Fixing
    it deliberately during a rename is fine; changing it as a side effect of a
    refactor is not
  - **Verified by running it**: uploaded an 8x8 PNG, watched it land in
    `/tmp/cchub-images`, and fetched it back byte-identical from
    `/api/files/images` (one round trip through all three of the triplicated
    consumers). Also confirmed that a POST to `/api/logs` appends to
    `/tmp/cc-hub-browser.log` and that a dashboard fetch writes a snapshot to
    `/tmp/cchub-usage-history.json`
  - No user-visible behavior changes

## [0.2.84] - 2026-07-28

### Changed
- **Collect the product name into one file** (#635): doing the rename (#459)
  today would mean editing 169 files in 1241 places, and missing one fails
  somewhere nobody is looking (miss the asset name in `update.ts` and it **goes
  after a release that was never published** - which shows up on someone else's
  machine at install time; miss a unit name in `uninstall.ts` and a timer for a
  service that does not exist keeps running). Most of them are not names anybody
  chose, either: `cchub-update.timer` is `${serviceName}-update.timer` and
  `com.cchub.server.plist` is `${launchdPrefix}.server.plist`, and spelling those
  compositions out at the call site is what turned one rename into a thousand
  - `identity.json` holds the values, `shared/identity.ts` holds the names
    composed from them (unit file names, launchd labels, asset names, the hook
    command, the User-Agent), and the **eight places where a mistake loses data
    or breaks the service** are wired to it (the data dir and its override env in
    `storage.ts`, `setup.ts`, `uninstall.ts`, `status.ts`, `update.ts`,
    `notify.ts`, `hook-status.ts`)
  - Display strings and logs, `CHANGELOG.md` (216 places) and `specs/` (26) are
    out of scope. Nothing depends on the former matching, and the latter records
    what was true at the time - rewriting it would make the history lie
  - `install.sh` and `.github/workflows/release.yml` cannot read the JSON (the
    installer runs via `curl | bash` with no checkout, and the repository to
    clone is itself a value in that file; the Actions matrix is evaluated before
    jq could run). They keep their own copies, and
    `backend/tests/unit/identity-consistency.test.ts` catches a drift
  - **Confirmed the output did not move**: the three systemd units already
    installed on this machine (written by the pre-change code) are byte-identical
    to the composed templates, and `backend/tests/unit/setup-units.test.ts` pins
    them as goldens. The `getServiceBinaryPath` regex (which decides which binary
    `cchub update` replaces) returns the same path against the real unit before
    and after
  - No user-visible behavior changes. This is groundwork for #459, and a cleanup
    that stands even if the rename never happens

## [0.2.83] - 2026-07-28

### Added
- **Show the name you gave a pane** (#631): herdr has supported renaming panes
  for a while, but cchub dropped the field in its client layer, so renaming
  appeared to do nothing. `%3` is an address saying where a pane sits in the
  split tree, not a name, so a user-supplied name wins where there is one (the
  glasses session list and conversation header, the web workspace list - where it
  also outranks the `agentName`/`claude` that says what is running). An unnamed
  pane still falls back to the id, and a whitespace-only label (which herdr
  accepts) counts as unnamed
- **Glasses: report other sessions' notifications as a count in the header**
  (#627): a notification arriving from another session while a conversation was
  open took two of the seven lines (the body plus the divider). The same item was
  also shown full-screen in a dialog and stayed in the list afterwards, making
  this its third appearance. All a reader needs mid-read is "something arrived,
  the list is worth a look", so it became a count in the header. The title and
  the tail (status, count) are measured separately so a long workspace name
  cannot push the count off the right edge - only the name is squeezed (ehpk
  v0.1.52)
- **Glasses: stamp the commit into a build, not just the version** (#629): a
  version number is what a build calls itself, not what code is inside it. The
  startup line now reads `[glasses] main: v0.1.51 (cab2a76) isEvenHub=true`, with
  `+dirty` appended when the source was uncommitted at build time (only `src/`
  and `shared/` count; `app.json` and `out.ehpk` change on every release by
  design). `pack` refuses a dirty bundle - shipping one means the device names
  code that does not exist, and neither Hub nor the device can be traced back to
  a real tree afterwards

### Fixed
- **A tab's close button was an invisible tap target on touch devices** (#618):
  the ✕ in the tab row is shown on `group-hover` and is `opacity-0` otherwise.
  An `opacity-0` element still takes hit tests, so on a phone or tablet - where
  hover never happens - a 26px "close tab" button sat invisible at the right edge
  of the row. Tapping there brought up the close confirmation instead of
  switching tabs. It is wrapped in `[@media(hover:hover)]` now so touch devices
  never render it (closing by touch is still a long press). `px-2` also became
  `px-2.5`, taking the desktop hit area from 26px to 30px. The responsive e2e in
  `touch-targets.spec.ts` could not catch this - it only measures height, and the
  button cleared the bar at `min-h-11` = 39px
- **Glasses: the header bar now fits at every time of day** (#627): this font
  gives digits different widths (`1` is 8px, `0` is wider), so a bar that fits at
  one time overflows at another - it was 1-2px over for about a fifth of the day.
  The squeeze loop bottoms out at one space, and measuring title, tail and clock
  separately still overflows once concatenated, so past that floor the title is
  shaved a character at a time (the tail is never shaved: what it reports is
  worth widening the bar for). Swept all 1440 minutes against three kinds of
  name and confirmed 331 overflows before the fix become zero. Layout that
  depends on the time cannot be verified at a single time, so the sweep itself
  became the test
- **Untracked the generated static-assets bundle** (#632): work on #631 caught an
  untracked file in a `git add backend/src` and committed it by mistake. It is
  3.6MB of base64 generated by `scripts/build.sh` and regenerated wholesale on
  every binary build, so tracking it produces an enormous diff every time anyone
  builds. It was also behind the "exceeds the configured maximum of 1.0 MiB"
  warning Biome had been printing for several revisions. The blob left in history
  stays - rewriting main is not worth it

### Changed
- **glasses bumped to v0.1.52** (#630): `app.json` still said v0.1.51 while two
  glasses changes (#627, #629) had landed on main, so packing in that state would
  produce a second "v0.1.51" with different contents. The exact event the version
  guard exists to prevent, arriving through a path the guard does not watch. Bumped
  ahead of the release rather than at release time to close it. **Repository-side
  only - the device stays on v0.1.51 until this ehpk is uploaded and promoted**

## [0.2.82] - 2026-07-28

### Fixed
- **Glasses: no notification for the session you are looking at** (#624): the
  notification looked like it would not go away on the conversation screen. The
  TTL was fine; the cause was that **the session being read** was the one
  notifying. An agent fires `Stop` at the end of every turn, so while you watch
  that conversation a notification about it arrives every turn and replaces the
  last before its 90-second TTL expires (ehpk v0.1.51)
  - It says nothing either. "This conversation is done" over the conversation
    itself **spends one of seven lines saying what the other six already show**
  - An `info` for the session on screen produces neither a dialog nor a banner.
    It skips **that item** rather than muting the queue, so other sessions'
    notifications arrive as before
  - **Questions (`waiting`) are exempt** - they carry choices, and those are not
    in the conversation body
  - The list screen is unchanged. The selection there is a cursor, not "what is
    being read"

## [0.2.81] - 2026-07-28

### Changed
- **Glasses: notifications are shown as a dialog** (#621): one line at the top of
  a list is easy to miss, and **a notification that gets missed is not a
  notification**, so notifications now use the full-screen overlay that questions
  already had (ehpk v0.1.50)
  ```
  cchub-work-2 [i]                08:53
  Response complete
  tap:open  dbl:close
  ```
  - **It withdraws itself after 8 seconds**. A question may own the screen until
    it is answered; a notification may not - dismissing one with a ring gesture
    every time an agent finishes would be work. It returns exactly where it
    interrupted (the list, or the position in the conversation being read)
  - The banner stays for the item's lifetime, so missing the dialog does not mean
    it is gone
  - It only interrupts the list and the conversation. **It does not interrupt a
    choice or voice input** - there the panel is the input, and replacing it
    mid-gesture loses what was being said
  - The overlay was generalized to any relay item. Waiting still comes first (a
    question is never buried under an FYI that is merely newer), and the side
    that asked nothing says "close" rather than "later"

## [0.2.80] - 2026-07-28

### Fixed
- **Glasses: do not silence browser notifications for the simulator** (#619): the
  suppression check added in v0.2.79 asked "is anyone subscribed to the relay",
  and the simulator uses the same controller as the device, so it subscribes the
  same way. **Leaving a preview tab open silenced notifications** while the
  glasses that were supposed to show them were on nobody's face
  - `subscribe-glasses-relay` gained `onDevice`. **Relay items still go to both**
    (showing what appears on the panel is the simulator's job). What changes is
    only what a subscription proves: reaching a wearer is something only the
    device can claim, so only the device suppresses
  - The device (`startGlassesMode`) passes `onDevice: true`, the simulator
    (`startDebugUI`) `false`. Those two already diverge, so it is declared as one
    more field of `GlassesPlatform`
  - **Omitted means device**. An old ehpk without the field is running on
    someone's face, while the simulator ships inside the server binary that reads
    the field and so can never be older than the server
  - No ehpk re-release needed (the current v0.1.49 behaves correctly as omitted)

## [0.2.79] - 2026-07-28

### Added
- **While the glasses are on, notifications go to the G2 and the browser push
  stops** (#615): the phone was buzzing about the same event the glasses were
  showing. Hook events are diverted into the existing glasses relay (an `info`
  item, TTL 90 seconds) (ehpk v0.1.49)
  - **A notification appears at the top of the session list**. The list is where
    the glasses sit when nothing is happening, which is exactly when a
    notification arrives. Until now `info` was only drawn on the conversation
    tab - that is, it only reached someone already looking at the session it came
    from, the one person who least needed telling
    ```
    [i]cchub-work-2: Response complete
    >▲ glasses dev
        cchub-work-2
    ```
  - **Suppression happens only when delivery did**. `hook-event` carries
    `deliveredToGlasses` only when the item actually landed on the glasses; with
    no glasses, an unresolvable session or a rate limit, the browser notification
    goes out as before. **A lost notification is worse than a duplicated one**
  - The hook's `session_id` (the agent session id) is matched against a herdr
    pane, falling back to `cwd`. If several agents claim the same directory the
    pane is dropped (stopping at the workspace beats replying to the wrong pane)
  - No hook-derived info is created while herdr reports `blocked`. Conversely, if
    a hook arrived first, the moment a real question appears only the hook-derived
    item is removed. An agent's own `cchub glasses` note is unrelated and stays
  - Indicator updates always run regardless of the flag (that is state, not a
    notification)
  - Note: the simulator subscribes to the relay through the same path, so
    **leaving a tab open stops browser notifications**

### Fixed
- **Give the notification hook a path it can resolve** (#614): `cchub notify`
  depended on PATH and could be invisible to the process running the hook
  - The hook command written by setup is an absolute path now
  - The guidance for an unconfigured session was corrected to ask only for the
    hooks CC Hub actually reads

## [0.2.78] - 2026-07-28

### Changed
- **Glasses: refuse to pack an ehpk whose versions disagree** (#612): the version
  travels two ways - through the **bundle** (injected at build time) and through
  **app.json** (which Hub reads). Bump one and forget to build and the two part
  ways quietly: Hub shows the new number while the device calls itself the old
  one. **Worse than having no number**, because it looks plausible. Reproduced in
  one command
  ```
  app.json=0.1.99  bundle=0.1.48  <- packing used to sail straight through
  ```
  - `bun run pack` cross-checks first. A mismatch stops it, and so does a missing
    `dist/`
  - The `/glasses-upload` skill's steps were updated to `bun run pack`
  - Rebuilding v0.1.45 today came close to getting this order wrong for real.
    This is not the sort of thing attention protects

## [0.2.77] - 2026-07-28

### Changed
- **Glasses: print the version in the startup log** (#610): "which version is on
  the device" had to be **inferred** by lining log timestamps up against Beta
  promotion times. That cost two dead ends today alone (the first looked like the
  heap measurement was missing, when that version simply was not on the device).
  An inference wearing a number is not a fact (ehpk v0.1.48)
  ```
  [glasses] main: v0.1.48 isEvenHub=true
  ```
  - The version is injected from `app.json` at build time. Typing it by hand
    guarantees a drift, so it comes from **the same source the pack uses**

## [0.2.76] - 2026-07-27

### Added
- **Glasses: survive a suspend** (#605): the phone suspends the WebView every
  time the Even app goes to the background. To the wearer the app had "crashed".
  **It had not** - zero exceptions across 52 startups, the heap flat at 16MB
  against a 3586MB ceiling, and the vendor documentation says outright that "the
  WebView is suspended ... that's how phone WebViews behave everywhere; it isn't
  an Even bug" (ehpk v0.1.47)
  - **The SDK announces why it ended, and we were throwing it away**.
    `FOREGROUND_ENTER`(4) / `FOREGROUND_EXIT`(5) / `ABNORMAL_EXIT`(6) /
    `SYSTEM_EXIT`(7) all arrive on the event channel, and the handler only looked
    at the four ring gestures
  - **The exit reason is logged**. "Went to the background" versus "was killed"
    is now settled by the host's own statement rather than guessed from inside
    the page
  - **Reconnect and redraw on resume**. No more sitting on a dead screen
  - **The reading position is saved and restored**. On the device through the
    SDK's `setLocalStorage` (host-app storage, which outlives the WebView); in
    the simulator through localStorage
  ```
  on suspend: reading life, two messages back (off=2)
  on restart: back to two messages back in life (off=2)
  ```
  - **The page number is discarded**. A conversation grows, so page two of an old
    body is not page two of a new one
  - **Anything older than 30 minutes is ignored**. That is no longer where the
    reader is
  - The lifecycle is handled **ahead of** the ring gesture debounce. Sharing it
    lets a resume swallow the tap right after it
  - Periodic refresh is paused during a restore. `loadConversation` resets the
    position to 0 at the end, which raced the restore and rewound it

### Fixed
- **The pane you tapped is the pane that opens** (#604): the list has carried
  panes from every tab since #593, while the terminal only draws one tab. Tapping
  a pane on another tab arrived with that pane absent from the layout, and the
  client silently fell back to the first pane of the current tab. **You land on a
  different agent than the one the list just showed you** - the worst shape a
  misfire can take, right after showing it
  ```
  tab 1               tap -> landing
   \- claude  30.6%    %1  ->  %2 (first pane of tab 2)
  tab 2
   \- claude  5.6%
  ```
  - Before opening a pane, wait for the switch to that pane's tab
  - `selectPane` goes through `ensurePaneReachable`. herdr also moves the tab as
    a side effect of `pane.focus`, but **asynchronously**, so a zoom or viewport
    request right after can run before the tree updates
  - A pane missing from the layout is no longer dropped silently; a `select-pane`
    is sent, the server switches the tab, and it arrives in the next layout

### Changed
- **The tab row is a heading again** (#604): tapping it existed to **expand a
  collapsed tab**. #593 removed collapsed tabs, which removed the role and left
  the tap target. Now that tapping a pane brings its tab along, there is nothing
  left to choose here
  - The expand/collapse chevron is gone. Only closing remains (long press, or the
    hover ✕)
  - The pane-count badge shows on every tab. Showing it only when inactive was a
    leftover from when tabs collapsed
- **Glasses: v0.1.46 ehpk** (#603): v0.1.45 was cut with the "other tab" label
  still in it and merged before #600 removed it. It was never uploaded, but
  **shipping different bytes under the same number** looks like an accident in
  hindsight

## [0.2.75] - 2026-07-27

### Fixed
- **You can reply to a pane on another tab** (#600): the list shows panes from
  every tab while the split tree only holds the active one. The conversation is
  readable through the history API, so it **opens**, and replies or key sends
  came back 404. **Readable but unanswerable** - worse than the pane not being
  there (ehpk v0.1.45)
  ```
  %1 (active tab)  peek -> comes back
  %4 (other tab)   peek -> HTTP 404 Pane not found
  ```
  - `ensurePaneReachable` switches to that pane's tab before the operation.
    Verified on the device: `w4H:t1` -> `w4H:t2` and a 200
  - The view follows the pane you replied to, because that is where the next
    thing happens
  - **Read-only paths still 404**. Nobody asked for the desk to rearrange itself
    because they glanced at it
- **Glasses: the "other tab" label is gone** (#600): it warned about a pane that
  was readable but unanswerable. Now that a reply lands, the tab is **a fact that
  leads to no action**. Same reason the `[!]` came off

## [0.2.74] - 2026-07-27

### Changed
- **Glasses: the list badge is for working only** (#596): on the device **seven
  of eight lines carried `[!]`**. A mark almost everything has distinguishes
  nothing. Waiting is an agent's normal state; **moving is the information**
  (ehpk v0.1.45)
  ```
  0s                       3s
  >▲ glasses dev           >▶ glasses dev
      2-legged robot           2-legged robot
   ▲|- %1  31%             ▶|- %1  31%
     |- %3  15%               |- %3  15%
     \- %4  6%  other tab     \- %4  6%  other tab
  ```
  - The blank is a **full-width space**, exactly one cell at width 320. A
    half-width one (width 5) shifts an unmarked name left by three quarters of a
    column
  - **Relay items keep their mark** (`!`). Those are questions already asked and
    unanswered, and they outlive the indicator that raised them
  - A tick redraws **the container holding the cell** (the header in a
    conversation, the row in the list). The condition also widened from "the
    session being read" to "anything moving on screen"
- **Glasses: a multi-pane workspace name is a heading** (#596): that row has
  **nothing to open** - tapping it fell back to `ccSessionId` (the representative
  pane the server picked) and opened one of them arbitrarily. That is the
  ambiguity the pane rows were supposed to remove. It carries neither cursor nor
  marker, and swipes jump over it. The footer count only counts things that open
- **Glasses: panes are drawn nested** (#596): with rules (`|-`, `\-`). A
  single-space indent read as "a different, indented workspace". The device
  carries every thin rule at **width 320** (the double-line variants are missing
  and unusable)

## [0.2.73] - 2026-07-27

### Added
- **Show panes from every tab in the list** (#593): herdr stacks a workspace's
  tabs, and CC Hub filtered the list to the active one. The reasoning was that
  the terminal only draws one tab so the list should match, but **the list and
  the drawing are different questions**. A pane on another tab is a running agent
  with its own conversation, and dropping it from the list makes it not
  off-screen but **unreachable**. Two Claude sessions were invisible on the
  device (the API said 2 where herdr reported a 3-pane workspace, and 1 where it
  said 2)
  - `panes` now covers every tab, and each pane carries a `tabId`
  - **Anything describing the terminal filters again**: the preview, the
    representative agent, the card's pane count and the blocked badge stay on the
    active tab. A card saying blocked while the tab on screen is idle sends the
    reader looking for something that is not there
  - The frontend's "exactly one pane" check was `panes.length === 1`, which
    breaks silently the moment another tab has one pane. Replaced with
    `soleVisiblePane` (counting what the terminal shows)
  - **The zoom and close buttons** were fixed the same way. Close especially: it
    offered "close" on the only pane on screen, and the backend accepted because
    it was not the workspace's last one
  - **The tab tree splits by `tabId`**. It used to line `panes` up under the
    active tab, drawing tab 2's panes as children of tab 1
- **Glasses: panes are listed under their workspace and can be opened** (#593):
  opening a pane reads that pane's agent session, and the state and recap are
  that pane's. A reply reaches its `paneId` too (ehpk v0.1.44)
  ```
  >    2-legged robot
   [!]  %1  31%
   [!]  %3  15%
   [!]  %4  6%  other tab
  ```
  - **A single-pane workspace does not expand**. `%1` is information the name
    already carries
  - **The command is not shown** (every pane runs `claude` and it just fills
    columns with a constant). **The directory only when panes differ**. What is
    left is context%, which actually differs
  - A swipe **crosses workspaces and panes in one gesture**
  - **The list screen's header is gone**. A title bar above a list of titles says
    nothing. The counter and the clock fit in the footer, and the container wins
    back 36px - an **eighth line**

## [0.2.72] - 2026-07-27

### Changed
- **Glasses: record the JS heap in the heartbeat** (#590): four guesses at the
  crash cause have been wrong, so measurement replaces reasoning (ehpk v0.1.43)
  ```
  before: alive 786.0s renders=438 ws=OPEN
  after:  alive 786.0s renders=438 ws=OPEN heap=42/64MB(limit 512)
  ```
  - The heartbeat already goes out every 30 seconds, so **nothing extra is sent**
  - `performance.memory` **only sees the JS heap**. The WebView's DOM, GPU
    textures and native allocations are excluded, so if Android is killing on
    whole-process usage the heap stays normal right up to the death - which still
    narrows the suspects by clearing JS memory
  - The heartbeat **interval itself** is evidence. In 8 of 20 runs it stretched
    from 30s to 45-65s just before dying. Zero JS exceptions across all 43
    startups, so the app is not failing - the engine is being throttled

### Notes
- The claimed correlation "opening CC Hub Web on the phone kills the glasses app"
  is **disproved**. 13 of 46 deaths (28%) fall within ten minutes of a web load,
  but that window covers 27% of the log, and chance predicts 12.5. The numerator
  was being read without the denominator

## [0.2.71] - 2026-07-27

### Fixed
- **Glasses: show the contents of a code block that fits** (#587): `[code]` threw
  the contents away while conveying nothing beyond "there was code here". The
  same shape of problem as `[table]` (ehpk v0.1.42)
  ```
  before:  [code]
  after:   newest (0,0)      dbl:back  p1/3
           page 2            dbl:top   p2/3
           one back          dbl:top
  ```
  - The marker's justification was "source is unreadable at this size", which is
    true of deeply indented real source and **not of most fences in an agent's
    reply**. One command, a few values, a short list all fit (measured at 265px /
    117px / 386px against a 556px frame)
  - **Four lines or fewer, every line inside the frame** means the contents are
    shown
  - **Common indentation is stripped**. At this width four leading spaces decide
    whether a line fits, and removing a shared prefix preserves the relative
    structure
  - What cannot be shown says **how much was hidden** (`[code 12 lines]`)

## [0.2.70] - 2026-07-27

### Added
- **Glasses: a double tap while paging returns to the top** (#584): it now goes
  back **one level at a time**. The way out of a scrolled-back history is its own
  top first, and swiping all the way down purely to leave is too much work for a
  ring with two gestures. The same double tap leaves the session only when you
  are already at the newest (ehpk v0.1.41)
  ```
  newest (0,0)      dbl:back  p1/3
  page 2            dbl:top   p2/3
  one back          dbl:top
  ```
  - Going back also **reloads**. Anything that arrived while you were scrolled
    back is waiting, and live updates only run at the top, so they resume
    naturally
  - The footer label says which one it will do (`dbl:top` / `dbl:back`)

## [0.2.69] - 2026-07-27

### Added
- **Glasses: animate the working indicator** (#581): a still mark only says "it
  was moving when this was last drawn". A moving one says "it is moving now"
  (ehpk v0.1.40)
  ```
  0s glasses dev ▲ / 3s ▶ / 6s ▼ / 9s ◀ / 12s ▲
  ```
  - The cells are `▲▶▼◀`, and **all four being width 320** is what matters -
    uneven ones shift the text after them on every step, which reads as a shake
    rather than a rotation. That is what disqualified ASCII `|/-\` (64/128/160).
    The braille spinner the CLI world uses has no glyphs in the firmware
  - **One cell every three seconds**. A cell is one BLE round trip, so 20/min -
    fewer than the 36/min the sessions push already uses
  - **Only the header** is redrawn (body and footer are untouched, avoiding three
    times the waste)
  - It animates **only while you are looking at a working session**. In any other
    state the tick returns before touching the display, so an idle app sends
    nothing
  - One timer runs for the app's lifetime. Simpler than starting and stopping it
    on every state change, and impossible to leave running
  - Ticks ride the existing queue that serializes SDK drawing. **A full draw
    overtakes and replaces a pending tick** - a full draw includes the header,
    and drawing it twice is exactly the overlap that queue prevents

## [0.2.68] - 2026-07-27

### Changed
- **Glasses: the speaker and the message count left the footer** (#579), to make
  room for information (ehpk v0.1.40)
  ```
  before:  dbl:back  AI 1/1 p1/3        after:  dbl:back  p1/3
           dbl:back  2msgs 2/2                  dbl:back
  ```
  - The body says who is speaking now (`$` marks the user, nothing marks the
    agent). Repeating it in the footer says the same thing twice
  - The count's **denominator was how many messages had loaded**, not the length
    of the conversation. It grows twenty at a time, so scrolling back changed the
    fraction at an unchanged position - it looked like it meant something and did
    not. `2msgs` sat in the same strip with yet another meaning (how many are on
    screen), which the screen itself answers
  - Only the page number stayed. That one means what it says

## [0.2.67] - 2026-07-27

### Changed
- **Glasses: tidy the speaker marks and gain information** (#576): `U>` became
  `$` (the way a shell marks its prompt) and `A>` was removed (ehpk v0.1.39)
  ```
  before:  U> tidy the notation below...     after:  $ tidy the notation below...
           A> the device mirror works.               the device mirror works.
  ```
  - Putting `A>` in front of every reply on a seven-line screen spends columns on
    what the reader can already see. **The unmarked side is the reply to the
    marked one**, and in a multi-message view the blank lines keep the boundary
  - The columns go into the tool lines' budget (no longer reserved for a prefix
    that does not exist)

## [0.2.66] - 2026-07-27

### Fixed
- **Glasses: retire a recap the conversation has overtaken** (#574): a recap
  exists to fill in what happened while you were away, and it was pinned
  permanently to the top of the newest view, spending **three of seven lines**
  explaining events older than the messages on screen. Its age was invisible too,
  and an eight-hour-old recap really did sit above today's work wearing the same
  face as a current one (ehpk v0.1.39)
  - Once a message on screen is newer than the recap, the reader has overtaken
    it, so it retires and gives the three lines back to the conversation
  ```
  linux           recap 04:54 / newest msg 04:51    -> shown (recap is newer)
  wheel-leg-bot   recap 15:27 yesterday / msg 02:00 -> hidden
  life            recap 01:48 / newest msg 01:45    -> shown
  ```
  - The server already sent `ccRecapAt` and the history API already sent a
    per-message `timestamp`. The glasses simply did not have them in their types
  - **When it cannot decide, it stays**. A missing or broken timestamp is not
    evidence that a recap is stale

## [0.2.65] - 2026-07-27

### Fixed
- **Glasses: substitute characters that render as tofu on the device** (#571):
  what looked like a checkbox in the simulator was a white box on the device.
  **The device carries the CJK symbol set** (the round, cross, triangle,
  exclamation, reference and star marks all have real advances), so rather than
  dropping a glyph it is replaced by **something that says the same thing in the
  same number of columns** (ehpk v0.1.38)
  ```
  emoji in the source        drawn on the device
  check / tick / OK marks    ○
  cross / NG marks           ×
  warning / exclamation      ！
  question marks             ？
  star / sparkles            ★
  bulb / memo / pin          ※
  arrows                     → ← ↑ ↓
  ```
  - **A signal keeps its three values**. Letting the green and the yellow circle
    both become the round mark would defeat the distinction they exist for, so
    they map to `○ / △ / ×`
  - **Decoration is dropped**. Party poppers and rockets carry no state, so there
    is nothing for them to become
  - The test is **two-stage**. `getAdvW` returns 0 for a codepoint the font does
    not carry, which catches the tick, the cross, the warning sign and most
    emoji, but **not the green check** (pretext 0.1.4 added an emoji font that
    measures it at 320px, and the device does not have that font). So emoji are
    always in scope regardless of measurement, and everything else follows the
    measurement
  - Substitution is not deletion, so surrounding spaces are left as written. Only
    lines where something was removed get their spaces collapsed
  - It runs in `stripInline`, so the panel and the simulator receive the same
    string. There is no room for the simulator to draw something prettier than
    the device

## [0.2.64] - 2026-07-27

### Fixed
- **Simulator: the panel's edges were clipped in picture-in-picture** (#569): the
  small window has rounded corners, and a line reaching the panel's edge lost it.
  The panel is drawn centered at **92%** of the frame now. The room and the
  reflection still fill the frame (simulator only, no ehpk update needed)

## [0.2.63] - 2026-07-27

### Added
- **Simulator: picture-in-picture shows the whole lens** (#567): so a terminal
  session and how it looks on the glasses can be shown side by side (simulator
  only, no ehpk update needed)
  - **PiP can only carry one video**. Chrome was automatically putting the
    camera's `<video>` into PiP, so the small window showed the room alone -
    neither the canvas layered above it (the green text) nor the CSS effects came
    along
  - The compositing that CSS layers do was **rebuilt as drawing onto a single
    canvas**. The same layers, drawn rather than stacked. That canvas becomes a
    video through `captureStream()` and goes to PiP
  - The camera element got `disablePictureInPicture` so it is no longer chosen
    automatically
  - Compositing **draws at 2x with smoothing off**. The panel is supposed to look
    coarse, and PiP resamples whatever it is handed
  - **A hidden page has its timers clamped to one second - which is exactly when
    you are watching the small window**. That is enough for a panel that changes
    every five seconds and not enough for a live room, so while the camera runs a
    `requestVideoFrameCallback` runs alongside and drives it from the media
    pipeline

## [0.2.62] - 2026-07-27

### Added
- **Simulator: fullscreen** (#565): for recording. The page UI disappears,
  leaving **the background filling the view with the panel centered** (simulator
  only, no ehpk update needed)
  - Looking through the real device, the display sits in the **middle** of the
    field of view rather than filling it, so the panel is centered at **80%** of
    the fit. Drawing it edge to edge is wrong as a picture
  - **Fullscreen dims the room less** (`.42/.52` -> `.24/.32`). That dimming
    exists to keep the green readable in a bright room, and there is barely any
    competition when the panel covers a small part of the frame. Holding it down
    just as hard makes the recording look like night

### Changed
- **Simulator: a stronger green on the panel** (#565): `106,255,122` ->
  `76,255,100`. The G2 is a monochrome green display, and the pale mint read as a
  generic HUD

## [0.2.61] - 2026-07-27

### Added
- **Simulator: camera background** (#563): a **Camera** button under
  **Background** puts the rear camera (`facingMode: environment`) behind the
  panel. A still image looks like a board; a live room looks like where you are
  standing (simulator only, no ehpk update needed)
  - **It is blurred**. The eye is focused on the near display and the room behind
    goes soft. The drawn fallback (`.room` / `.figure`) was blurred from the
    start while photos and the camera went through sharp, and that is why a photo
    looked like a board. Overscanned to 106% so the blur does not run out of
    pixels at the edge
  - It sits inside `.scene`, so the existing dimming pass covers it
  - Stopping **stops the tracks**. Emptying the element alone keeps the camera
    held and its indicator lit
- **Simulator: lens reflections** (#563): a diagonal streak of light, leakage
  along the top of the combiner and vignetting (a waveguide's falloff plus the
  lens rim's shadow). The canvas gets `mix-blend-mode: screen`, making it
  **additive** like the real optics (adding light to the room rather than pasting
  a black rectangle onto it)
  - **All of it outside the canvas, behind a toggle**. The canvas is a faithful
    4-bit render matched to the device, and baking effects into it would ruin
    that. Checking the fidelity needs the plain version. The setting is saved in
    localStorage

## [0.2.60] - 2026-07-27

### Added
- **Glasses: mirror the device's screen into the simulator** (#560): for demos.
  What the wearer is seeing right now, in as many browsers at once as you like
  (ehpk v0.1.37)
  ```
  device (phone WebView)                CC Hub              browsers (any number)
    render(state)
      |-> updateDisplay(bridge)  ->  G2 panel
      \-> publish screenText()   ->  /ws/mux  ->  broadcast  ->  drawPanel()
  ```
  - The glasses app computes the screen through `screenText()` **once** and hands
    the same three strings to both the panel and the simulator's renderer. The
    mirror is therefore not a reproduction of the screen but **the screen**
  - Publishing hangs off `GlassesPlatform.render`, the one drawing entry point
    both platforms share, so every mode and every ring gesture rides along
    without being enumerated. A frame identical to the previous one is not sent
    (drawing runs every five seconds)
  - The server **holds the last frame**, so a viewer joining midway sees the
    current screen immediately rather than an empty panel
  - When the publisher's socket closes, **null is broadcast** and the mirror says
    `No device is connected`. A mirror that keeps showing the last frame is
    indistinguishable from a live screen holding still - the worst kind of
    ambiguity to discover in front of an audience
  - **Read-only**. A viewer pressing the ring would fight the wearer for the
    screen, so the ring buttons are disabled while mirroring. Driving the glasses
    from a laptop is a different feature
  - WS protocol: `glasses-screen` (publish / broadcast), `subscribe-glasses-screen`
    / `unsubscribe-glasses-screen`, with a zod schema validating the payload size
    too

## [0.2.59] - 2026-07-27

### Fixed
- **Glasses: the previous page's last line reappeared when paging** (#557): it
  advanced six lines while showing seven, so every page's last line came back as
  the next page's first. It was meant as carried context and instead read as "the
  page did not advance", leaving the reader to work out which of the seven lines
  they had already seen (ehpk v0.1.36)
  ```
  before: p1 = 1-7, p2 = 7-13, p3 = 13-19   <- lines 7 and 13 appear twice
  after:  p1 = 1-7, p2 = 8-14, p3 = 15-21
  ```
- **Glasses: the body container's padding differed per screen** (#557): the wrap
  width in `metrics.ts` is one number, and five screens declared three different
  paddings. The list used 4 (560px inside, wrapping 4px early), conversation /
  voice / overlay used 6 (556px, correct), and **the choice screen used 8 (552px,
  wrapping 4px late, so the device re-wraps)**. On the choice screen alone, the
  fragmented lines the wrap rules exist to prevent kept appearing. All screens
  use padding 6 now
- **The simulator's line advance was 28px** (#557): LVGL's line height is
  **27px**. By the seventh line it was off by a quarter of a line, and the whole
  block sat 1px low. The coordinates are derived from the container definitions
  and `metrics.ts` now, leaving no hand-copied constant to drift
- **The simulator drew separators the device does not have** (#557): rules under
  the header and above the footer, while all three containers have
  `borderWidth: 0` and the panel has nothing. They were decoration to separate
  the three zones, and a lie on a screen claiming to draw what the device draws

## [0.2.58] - 2026-07-27

### Fixed
- **Glasses: character widths are measured in real pixels** (#554): **the G2's
  font is not monospaced**. A space is 5px, `i` is 4px, `a` is 12px, `W` is 16px,
  CJK is 20px, and the line height is 27px. The old model ("52 columns, CJK at
  1.857x") was close on average and drifted per string, and right-aligned padding
  (that is, spaces) was counted at twice its real width - so a header clock of
  `linux` + spaces + `10:25` reached **293px of 568px**. It was not "failing to
  reach the top right corner"; it was stopping in the middle of the panel. After
  the fix it lands at 563-567px (ehpk v0.1.35)
  - Adopted the official **[@evenrealities/pretext](https://www.npmjs.com/package/@evenrealities/pretext)**
    (MIT, no dependencies, same maintainer as the SDK). It embeds the G2
    firmware's LVGL font metrics and reproduces kerning, the three-level font
    fallback and LVGL's own per-glyph rounding `(adv + kern + 8) >> 4`
  - Added `metrics.ts` as the shared measurement layer for `types.ts` /
    `display.ts`. Container sizes are derived from LVGL's real numbers (at a
    27px line height a **36px header holds exactly one line**, and an overflowing
    line takes the clock off the panel with it)
  - `advance(prev, ch)` is the per-pair kerning delta. Summing character by
    character matches `getTextWidth`'s whole-string width with **0px of error**,
    so line breaking stays a single pass. Kinsoku, dropping the space at a wrap
    point and counting `...` inside the truncation budget are all preserved
  - `charWidth` / `displayWidth` / `PANEL_WIDTH` / `LINE_WIDTH` / `CJK_RATIO` are
    gone
  - Cost: +40KB gzipped (the ehpk goes from about 50KB to about 90KB). A sweep
    over 218 pages of real data shows zero panel-width overflows, zero 7-line
    overflows and zero header wraps
- **The simulator's drawing matches the device font's character** (#554): it drew
  in a monospaced font, which squeezed ASCII horizontally almost everywhere
  against the device's narrow advances (space 5px, `i` 4px). Switched to a
  proportional sans, taking the mean error against device advances from **4.22px
  to 1.07px**

## [0.2.57] - 2026-07-27

### Added
- **Glasses: a clock at the right end of the header** (#551): `HH:MM` at the
  right of the conversation screen's title row. The request was "the time is
  welcome whenever it is visible", so it appears on every screen - list,
  conversation, choice, voice and overlay (`glasses/src/display.ts`, ehpk
  v0.1.34)
  ```
  linux                                          09:56
  ```
  - The column count is **52**, the same as the body. The header's own padding
    fits 53, but an overflow makes the container wrap and the clock leaves the
    36px box, so one column is held back
  - Right alignment **truncates**. A CJK title is 1.857 columns with a fraction,
    and rounding pushed a third of a column past the right edge
  - A long title is cut rather than pushing the clock out. Being readable at a
    glance is the clock's whole purpose, so a fixed position wins
  - **No timer**: `sessions-updated` redraws every five seconds, so the minute
    never goes stale. Only the choice screen updated the body alone and froze its
    clock, so it updates the header too now

### Fixed
- **The simulator's character placement was several columns off** (#551): it
  placed whole strings using the browser's metrics and drifted by several columns
  per line (the device's ASCII advance is 10.69px against the browser's 9.5px;
  CJK is 19.85px against 19px). It surfaced when right-aligned content appeared
  nowhere near the right edge. It now advances character by character on the
  device's measured column pitch (`glasses/src/debug-ui.ts`). Glyphs the width
  table misreads (emoji, box drawing) are also squeezed into the device's cell
  width so they cannot overlap their neighbor

## [0.2.56] - 2026-07-27

### Fixed
- **Glasses: a table collapsed into `[table]` and lost its contents** (#547): the
  marker conveyed nothing beyond "there was a table" while discarding the cells
  you wanted to read. An agent's tables are nearly always short key/value pairs,
  readable at 52 columns as one `cell | cell` record per line. Only the
  `|---|---|` separator row is dropped (`glasses/src/types.ts`, ehpk v0.1.33)
  ```
  before: [table]
  after:  item | version
          CC Hub | v0.2.55 (updated in production)
          G2 glasses app | v0.1.32 (Beta on EVEN Hub)
  ```
- **Glasses: punctuation left alone at the start of a line / words split oddly**
  (#547): the 52-column wrap had no kinsoku, so a sentence ending near the end of
  a line left its full stop alone at the head of the next. Added line-start
  kinsoku (closing punctuation and brackets), line-end kinsoku (opening
  brackets), and a rule against splitting short English words. All three **push
  to the next line** rather than overflowing - the column width here is an
  approximation of measured hardware, and an overflowing line gets re-wrapped by
  the G2's own container, returning to the state being avoided. A word no split
  can fit on one line (a URL, a long path) is split anyway, since the reserved
  columns would buy nothing
- **Glasses: unexplained spaces inside a sentence** (#547): when a wrap landed
  exactly on the space between words, that space stayed at the head of the next
  line. A space marks "the break is here", and the newline already does that job.
  Indentation coming from a real newline is preserved
- **Glasses: a truncated tool line wrapped again into a two-character fragment**
  (#548): `clipToWidth` appended `...` **after** the width check, so the result
  was one column over. The detail cap was also a fixed 44, unrelated to the
  `[Bash] ` label or the `A> ` prefix. Both `...` and the prefix are in the
  budget now
  ```
  before: A> [Bash] sed -i "s#^const LINE_WIDTH = 52 .*#cons
          t ...
  after:  A> [Bash] sed -i "s#^const LINE_WIDTH = 52 .*#c...
  ```
- **Glasses: a multi-line command ate three of the seven lines** (#548): a
  heredoc came through with its newlines intact, against the design's "one call,
  one line". It is folded to a single line before clipping
- **Glasses: a recap took six of seven lines** (#548): `recapBlockLines` counted
  its cap in **logical lines**. A recap normally arrives as one sentence with no
  newlines, so it sailed past the two-line cap and then wrapped to five or six,
  leaving one line for the conversation it was supposed to introduce. The body's
  seven-line cut counted logical lines too, leaving room for a wrapped paragraph
  to spill quietly past the bottom of the container. Both count display lines now
- **Glasses: the session list's columns did not line up** (#548): `>[!] name` and
  `  name` started three columns apart, which is hard to scan. The badge width is
  fixed so names start at the same place

### Added
- **Tests for the glasses workspace** (#547, #548): it was `"test": "echo 'no tests'"`.
  22 cases now pin kinsoku, the absence of column overflow, characters surviving
  a re-wrap, each table pattern, clipped lines fitting the panel with their
  prefixes, and the recap and body line caps (`bun test`)

## [0.2.55] - 2026-07-27

### Fixed
- **Glasses: scrolling back through a conversation snapped to the newest within
  seconds** (#545): `maybeRefreshConversation` calls `loadConversation` on every
  terminal output and session push (throttled to 3s), and `loadConversation` reset
  `conversationOffset` and `conversationPage` to 0 at the end. So a refresh did
  not only fetch new messages - it **sent a reader back to the top every three
  seconds**. Refreshes are held while scrolled back (`glasses/src/controller.ts`,
  ehpk v0.1.32). Returning to the newest resumes live updates, so the normal case
  (watching new messages arrive) is unaffected

## [0.2.54] - 2026-07-27

### Added
- **The simulator can actually record from the microphone** (#542): until now
  `startMicCapture` only returned `true` and `transcribeAudio` only returned the
  text box's contents, making **the one feature that talks to Groq the one
  feature that could not be tested**. It records from the browser microphone at
  16kHz mono and sends the same 16-bit PCM the G2's SDK produces to the same
  `/api/glasses/stt` (`glasses/src/debug-ui.ts`). The server runs identical code
  either way, so this exercises the real path rather than a mock. Typing into the
  text box still skips recording (for trying the confirm-and-send flow alone)
- **The simulator's background can be replaced without a query parameter** (#542):
  a file picker, a URL field, and drag and drop anywhere on the page. A pasted
  URL is remembered in localStorage; an opened file is not (a blob URL dies with
  the page). `?bg=` still wins when given

### Changed
- **Glasses: show what a tool call actually did** (#543): the conversation screen
  showed a tool call as `[tools] Bash` and repeated calls were indistinguishable
  (four lines of a seven-line page spent saying nothing). The cause was that
  `toolUse` carries `input` and nothing read it. Each tool now shows a meaningful
  argument (`glasses/src/types.ts`, ehpk v0.1.31)
  ```
  before: A> [tools] Bash / A> [tools] Bash / A> [tools] Read
  after:  A> [Bash] check what toolUse carries
          A> [Bash] check toolUse.input against real data
          A> [Edit] .../src/types.ts
  ```
  - Bash takes `description` then `command` (a human-written sentence of intent
    reads better than a shell line that needs decoding), file tools take the
    path, Grep/Glob the pattern, Task the description, WebFetch/WebSearch the URL
    or query, and an unknown tool its first string argument
  - Each line is clipped to 44 columns with CJK measured at its real width
    (1.86 columns). A run of calls stops at four lines plus a remainder count, so
    the assistant's own words are not pushed out
  - **Tool results** also arrived as raw output with newlines and could fill a
    page on their own. They are folded to one line before clipping

### Fixed
- **The simulator overflowed a phone screen** (#542): the panel is a fixed
  576x288 (that is the hardware) and its right edge was cut off on a narrow
  screen. It scales to the available width now (`scale(0.62)` at 412px, so the
  whole display is visible and nothing runs off screen). The canvas keeps its
  real resolution, so the type is as coarse as the device's - the whole thing
  simply gets smaller

## [0.2.53] - 2026-07-27

### Changed
- **Draw the glasses simulator as what the wearer sees** (#539): the simulator
  drew a black rectangle, which is not what someone wearing the device sees. The
  display adds light to clear glass; the room ahead stays visible and the text
  sits on top of it
  - **A photo of a meeting behind the HUD** (`glasses/public/scene-meeting.jpg`),
    with the room dimmed just enough for the green to win. `?bg=<image URL>`
    swaps in any image, and a CSS-drawn room is the fallback when the photo
    cannot be fetched
  - **The sense of resolution matches the device**: the type is drawn on a real
    576x288 canvas and quantized to the panel's 16 levels (measured: alpha 0, 17,
    34, ... 255). The browser's text rendering is far finer than the hardware and
    was flattering the design into a quality the wearer never sees
  - **Two builds**: `bun run build` (`--mode device`) excludes `public/` and
    emits the `dist` for the ehpk, while `bun run build:web` emits `dist-web`
    with the photo for serving. The device has no simulator, and bundling a 79KB
    photo takes the ehpk from 46KB to 125KB
  - Background photo:
    [Unsplash](https://unsplash.com/photos/a-group-of-people-sitting-around-a-conference-room-LJ8vdm37J7Y)
    (by Walls.io, Unsplash License - commercial use allowed, no attribution
    required)
- **Glasses: the API usage readout left the top of the screen** (#540): it hit
  `/api/dashboard` every five seconds for the header, parsed 17KB and used one
  number. The server caches that value for 60 seconds, so eleven times out of
  twelve it was pure waste. "12% used" prompts the wearer to do nothing and took
  8 of the header's 52 columns (`CC Hub API:12% 3/7` -> `CC Hub 3/7`)

### Fixed
- **The glasses never sent a WebSocket ping** (#540): `glasses/src/ws-client.ts`
  had no ping at all, leaving the glasses silent while every other client sent
  one. The server's 60-second zombie sweep caught it, so **the glasses spent
  their entire life disconnecting and reconnecting every 90 seconds**, dropping
  relay pushes each time. Fixed to ping every 15 seconds, and the server log
  confirms the cycle has stopped
- **The glasses' drawing overlapped itself** (#540): `render()` fired
  `updateDisplay` without awaiting it, so a batch of `sessions-updated` messages
  ran several SDK page rebuilds concurrently. Drawing is serialized now, and
  frames arriving mid-draw collapse into the latest state (an intermediate frame
  would be overwritten anyway)
- **Crash reporting for the glasses** (#536, #540): a WebView has no console we
  can read, so an exception only made the app die quietly. Startup traces,
  uncaught exception and promise rejection handlers, and a 30-second heartbeat
  now go to `/api/logs`. **The "starts, dies seconds later" symptom itself is
  unexplained** (it happens on every version and predates these changes), but the
  next time it happens there will be a stop time and a last known state

## [0.2.52] - 2026-07-27

### Fixed
- **The service worker intercepted `/glasses`** (#536): in a browser that already
  had CC Hub's service worker, opening `/glasses` showed CC Hub itself rather
  than the glasses simulator (the title said "CC Hub" and not one simulator
  element was present). vite-plugin-pwa's `navigateFallback` answers every
  navigation with the precached `index.html`, so `/glasses` - served by the
  backend rather than being an SPA route - was taken by the fallback. The prefix
  is in `navigateFallbackDenylist` now and passes through
  (`frontend/vite.config.ts`)
  - It does not reproduce in a fresh browser profile (requests reach the network
    only while no SW is registered). v0.2.51 was verified in exactly that state,
    so it first appeared in a real user's environment
  - **It only takes effect once the new service worker activates**. With
    `registerType` at `'prompt'`, already-open clients keep the old worker until
    the update is approved

## [0.2.51] - 2026-07-26

### Added
- **CC Hub serves the glasses simulator at `/glasses`** (#534): checking the
  glasses display meant putting the device on. A browser simulator existed but
  had to be started by hand (vite 8391), and its drawing was a second
  implementation of the layout that had drifted from the device - no 52-column
  wrap, no 7-line limit, pages split every 300 characters rather than by line,
  its own separators. Quoting a screen from that quotes something the glasses
  never showed
  - **It draws through the device's own output**: `screenText()` returns the
    strings for the three frames the G2 is about to draw (header, body, footer),
    and both the real drawing path and the simulator go through it
    (`glasses/src/display.ts`). Wrapping, the line limit and pagination cannot
    drift. The two fixed footers are constants for the same reason. 113 lines of
    hand-written drawing were deleted (`glasses/src/debug-ui.ts`)
  - **Always reachable**: mounted at `/glasses` and embedded in the binary
    alongside the frontend (`scripts/generate-static-assets.ts`,
    `backend/src/index.ts`). Anyone running CC Hub can open it without the
    device. The ehpk needs a root base path, so it is a separate build
    (`build:web`, `base=/glasses/` -> `dist-web`) and the device bundle is
    unaffected
  - **`paginateSingleMessage` returns the original text unwrapped when it fits in
    seven lines** - an assumption that surfaced here. It held because the G2's
    container wraps on its own, and a `white-space: pre` panel has no such
    container. It goes through `wrapForPanel()` and the same width math now
  - **CJK width is asymmetric**: the G2 measures CJK at 1.857 columns while a
    browser's monospaced font draws exactly 2.0, so one font size cannot be
    accurate for both. It follows the wider one so a full line of Japanese fits
    the panel (an ASCII line stops a little short of the right edge)
  - The screen names went into the implementation (**list** / **conversation** /
    **interrupt** / **choice** / **voice**). A copy button takes the whole screen
    as framed text so a report does not have to be retyped. Arrow keys, Enter and
    Backspace map to ring gestures

## [0.2.50] - 2026-07-26

### Added
- **Glasses: send uncaught errors and startup milestones to CC Hub's log**
  (#532): the glasses run inside a WebView with no console we can read, so an
  uncaught exception only made the app die quietly with nothing left behind.
  v0.1.25 was reported as "starts for a moment, then dies", and there was no
  console, no crash log and no server-side record to chase it with. Before
  anything else the app now installs `error` / `unhandledrejection` handlers,
  `.catch`es each SDK drawing call individually, and records startup milestones
  (`glasses/src/main.ts`, `reportLog` in `glasses/src/api.ts`, ehpk v0.1.26).
  Until the server URL is known everything is buffered, and then it is sent to
  `/api/logs` (the existing unauthenticated browser-log endpoint, which also
  reaches journalctl). Render traces stop after the first five - sending one per
  frame would itself become a new failure
  - **This instrumentation did not reproduce the crash**: the only difference
    from the reported build is the measurement code, and no `uncaught`, no
    `unhandled rejection` and no `updateDisplay failed` was recorded - it reached
    `startup complete`. So this change is not an explanation and not a fix. It is
    evidence for the next time
  - The `.catch`es on the drawing path are worth keeping regardless. An
    unhandled rejection there kills the app silently by any other means

## [0.2.49] - 2026-07-26

### Added
- **The dashboard can be opened from the workspace list on a phone** (#530): on a
  phone the only ways in were the terminal screen's top bar and the file browser,
  so with no session open there was no route at all. `WorkspaceList` has long
  accepted `onToggleDashboard` and drawn a button in its header (left of the
  search icon), and the desktop `Ctrl+B` modal (`SessionModal`) showed it. The
  mobile list overlay simply never passed the prop; now it does
  (`frontend/src/App.tsx`)
  - The mobile dashboard overlay's stacking also went from `z-50` to `z-[70]`.
    The list overlay is `z-[60]`, so without that it opened behind the list.
    Closing it returns to the list

## [0.2.48] - 2026-07-25

### Added
- **The glasses follow the session open on the phone in your hand** (#528): the
  glasses used to pick a session on their own, so replying to an agent meant
  hunting for the session with the ring first - even when the same session was
  already open on the phone in your hand. `sessions-updated` now carries `focus`
  (the session a visible client opened most recently) and the glasses follow it
  (`ClientFocus` in `shared/types.ts`, `computeClientFocus` in
  `backend/src/routes/terminal-mux.ts`, `followFocus` in
  `glasses/src/controller.ts`, ehpk v0.1.25). The phone picks the session, and
  the ring is left for replying
  - **Focus is taken when a session is opened**, not when something is typed.
    Watching is the primary use, and no input happens at all during it
  - **Conflicts between devices are resolved by visibility**: rather than a fixed
    priority, `client-info` reports `document.visibilityState` and resends it on
    every `visibilitychange` (`frontend/src/hooks/useMultiplexedTerminal.ts`). A
    phone in a pocket and a sleeping tablet drop out, and the device in your hand
    wins. Among several visible candidates, last writer wins
  - **With every device hidden, no focus is broadcast**: the follower keeps its
    previous view (putting the phone away must not blank the glasses). The
    glasses' own connection is identified by its relay subscription and excluded
    from the election (otherwise following feeds back into electing)
  - **Following pauses while sending or deciding**: not in voice, choice or
    overlay. A reply has to reach the destination shown in the header, and the
    phone moving on must not rewrite it. In the session list only the cursor
    moves; opening a conversation stays a deliberate tap
  - A focus change is broadcast immediately rather than waiting for the 5-second
    push (measured at 26ms). Following five seconds late is worse than not
    following
  - The desktop/tablet path (`DesktopLayout.tsx`) never sent `client-info`, so it
    does now (mobile's `TerminalPage.tsx` already did)

### Fixed
- **The glasses SDK was stuck at 0.0.9**: `@evenrealities/even_hub_sdk` in
  `glasses/node_modules` was still 0.0.9 while `package.json` / `bun.lock`
  pointed at 0.0.12. `AudioInputSource`, which voice input uses, does not exist
  in 0.0.9, so the build breaks in that state. `bun install` resolved it

## [0.2.47] - 2026-07-25

### Changed
- **Workspace card: panes nest under the tab they belong to** (#526): an expanded
  workspace card listed tabs and panes as sibling sections separated by a rule.
  herdr's model is `workspace > tab > pane` and the backend only returns the
  active tab's panes, so there was no way to read that the panes on screen belong
  to the tab just above them, and switching tabs silently swapped a list below
  that looked unrelated. Panes are indented under their tab now, drawing the
  hierarchy as it is (`frontend/src/components/WorkspaceList.tsx`). The
  expand/collapse chevron doubles as the active marker (only the active tab can
  show panes, so picking a collapsed tab switches and expands it), which leaves
  one meaning per dot in a list (it used to be "active or not" on a tab row and
  "agent state" on the pane row right beneath). A single-tab workspace still
  shows a flat pane list
  - The "Tabs" section heading is gone and "+ New tab" is a full-width row at the
    end of the tree, at the same `min-h-11` as every other row (it was about 20px
    before, under the tap-target standard adopted in #513)
  - **Tabs gained a hover ✕**: closing was long-press only and `onContextMenu` is
    preventDefault-ed, so there was no way to close one with a mouse
  - `Tab recipes` -> `recipes`: herdr labels a tab with its number until it is
    renamed, so the "Tab" prefix only means something for a numeric label
  - Fixed missing i18n on the count badges (a hardcoded English `{n} panes`, and
    English word order in the tab count)
  - A pane's `active` pill became `focused` (the tab's active pill is gone, and
    the remaining one means "the focused pane"). The pane recap went from amber
    to zinc (amber was the same color as the "waiting for input" status two lines
    above)

### Fixed
- **A long-press timer was stranded by a session push** (#526): the long-press
  timer on tab and pane rows was a local variable in a `map` callback and so was
  rebuilt on every render. The session list re-renders on the server's 5-second
  push, and one landing mid-press replaced the DOM handler with a new closure
  (whose timer is null), so lifting the finger did not cancel it and the close
  dialog appeared afterwards. `PaneRow` / `TabRow` were extracted and use a ref

## [0.2.46] - 2026-07-25

### Fixed
- **Glasses relay channel: fix the lifecycle of an agent-written waiting item**
  (#504, #524): a decision request posted by an agent with
  `cchub glasses --kind waiting` was mishandled on two paths. (1) The backend's
  `exitBlocked` **deleted a waiting item with no paneId as soon as any unrelated
  pane in the same session left blocked** (a `--session` post carries no paneId,
  so an unanswered "shall I deploy?" could vanish silently). Only
  auto-detected items follow herdr's blocked epoch now; an agent-written item
  follows its own lifecycle (answered -> dismissed)
  (`backend/src/services/glasses-relay.ts`). (2) In the glasses app an answered
  agent-written item stayed in the banner (an auto item is cleared when its pane
  leaves blocked, and an agent-written one has no blocked epoch to clear it). A
  successful choice or voice answer removes the item explicitly (an optimistic
  local remove plus a server dismiss, so it does not come back on reconnect)
  (`glasses/src/controller.ts`, ehpk v0.1.24). Regression tests added

## [0.2.45] - 2026-07-25

### Added
- **Glasses relay channel v1: only what needs a decision reaches the G2** (#504,
  #522): when an agent stops for input (a permission prompt or AskUserQuestion)
  while you are away from the PC, the question and its choices appear on the G2
  automatically and can be answered on the spot with the ring (swipe to select,
  tap to confirm) or by voice.
  - Baseline layer (auto): a per-pane `agent_status` diff tracker over herdr
    detects the transition into blocked, and the backend assembles the question
    line and numbered choices with `readPaneText`. No summarizing, only a
    display-width clamp (`backend/src/services/glasses-relay.ts`)
  - Agent-written: the `cchub glasses "<text>" --kind waiting|info --choices "a,b"`
    CLI and the glasses-relay skill let an agent post a short note that needs a
    decision (`backend/src/commands/glasses.ts`, `.claude/skills/glasses-relay/`)
  - Presence gate: assembly and delivery happen only while something is
    subscribed to `subscribe-glasses-relay`; otherwise only state is tracked (at
    zero extra cost). The snapshot on subscribe assembles the current blocked set
    lazily
  - Replies: a choice key goes through `POST /api/sessions/:id/panes/input` with
    a paneId, and free text goes voice -> STT ->
    `POST /api/sessions/:id/prompt` (with an optional `paneId`). Clearing the
    item after an answer happens automatically when blocked ends
  - Glasses app: restructured into an explicit state machine around the relay
    queue as the central model (session_list / conversation / choice / voice /
    overlay), with a proactive waiting overlay and a browser debug simulator
    (`glasses/src/controller.ts`, `relay-queue.ts`, `debug-ui.ts`)
- **Device feedback folded in** (verified in Beta as glasses v0.1.20-0.1.23): the
  question cap dropped to 120 columns, AskUserQuestion's filler choices ("Type
  something." / "Chat about this") were removed, tool calls on the conversation
  screen fold into one `[tools] Bash x2, Edit` line, Markdown markers are
  stripped from conversation text (code folds to `[code]`, tables to `[table]`),
  and a recap block heads the conversation screen (Claude's away_summary, or the
  last message for other agents - which is what finally gave kimi sessions, whose
  history cannot be read, a summary at all)

## [0.2.44] - 2026-07-25

### Fixed
- **The update dialog's buttons were hard to tap** (#513): checked at a real
  phone width (459x1019), the buttons were 42x25 and 74x25 CSS px, far under the
  44px touch-target guideline. `px-3 py-1.5 text-xs` became
  `min-h-11 px-4 text-sm`, taking them to 53x39 and 89x39. Still rem-based, so
  they follow the UI scale setting (`frontend/src/components/UpdatePrompt.tsx`)
- **A test that would break CI permanently with the passage of time** (#517):
  `UsageHistoryService`'s test seeded history with the literal date
  `2026-07-17T00:00:00.000Z`. `recordSnapshot` prunes snapshots older than eight
  days, so past 2026-07-25 00:00 UTC the seed was deleted before the append and
  every PR from then on would fail (v0.2.43's release CI passed at day 7.86 and
  it broke a few hours later). The kind of failure a diff cannot explain, so the
  seed is relative to now (one day ago)
  (`backend/src/services/__tests__/usage-history-legacy.test.ts`)

### Added
- **Mobile and tablet widths run in CI** (#518): investigating why phone / tablet
  / desktop kept diverging turned up three categories: (1) `App.tsx`'s mobile
  branch is a 305-line independent JSX tree where the terminal, session list,
  dashboard and keyboard are all different components from desktop's, (2) there
  are 30 `isTablet ?` ternaries in PaneContainer and 18 in DesktopLayout, and (3)
  even shared components were never looked at at those widths. On top of that
  **CI had never run playwright at all** (`test.yml` covered lint / typecheck /
  unit tests / build), and `playwright.config.ts` had a single Desktop Chrome
  project, so mobile width had never been checked once. Added three projects -
  `responsive-desktop` / `responsive-tablet` / `responsive-mobile` - and
  `tests/e2e/responsive/`, which stubs all of `/api` through `page.route` so
  neither the backend nor herdr is needed, plus a `responsive` job in CI. It
  checks that the app shell mounts, that **the intended layout tree is what
  renders** (via a new `data-layout` attribute - the device decision depends on
  `screen`'s shorter side and touch support rather than viewport width alone, so
  without it the matrix could exercise the same layout three times), that no
  horizontal scrolling appears, and the minimum tap-target height at touch
  widths. The existing specs assume a real herdr session, so they stay
  desktop-and-local-only through `testIgnore`. The tap-target check found three
  existing violations on arrival; they are recorded with their DOM paths in
  `KNOWN_TOO_SMALL` and split out into #514
  (`frontend/playwright.config.ts`, `tests/e2e/responsive/`,
  `.github/workflows/test.yml`)

## [0.2.43] - 2026-07-25

### Changed
- **A release to verify the frontend auto-update flow in production**: no code
  changes, only a version bump. It exists to check in the field whether the
  machinery added in 0.2.40-0.2.42 - detect a new version, show a confirmation
  dialog, activate the waiting service worker on approval and reload - fires for
  **a release that is nothing but a version bump**. Embedding the version in the
  bundle in 0.2.41 means the bundle hash changes even with no code change, so the
  service worker update runs

## [0.2.42] - 2026-07-25

### Fixed
- **The waiting service worker never activated, so the update dialog never
  appeared** (#510): releasing v0.2.41 and checking it in production showed the
  new worker installing correctly and precaching the new build, and then
  **staying `waiting` for as long as a tab was open**. Navigating to
  `about:blank` to drop the clients activated it instantly, which identified
  `skipWaiting()` - embedded in the worker by `registerType: 'autoUpdate'` - as
  ineffective under client control. 0.2.40's detection waited on
  `controllerchange`, so with no swap the dialog could never appear. Switched to
  `registerType: 'prompt'`, which deliberately keeps the worker `waiting` and
  gives it a `SKIP_WAITING` message handler, and replaced the custom code with
  vite-plugin-pwa's own `registerSW`. `onNeedRefresh` detects a waiting worker
  (including one left over from a previous visit), and on approval
  `updateServiceWorker(true)` sends `SKIP_WAITING`, activates it and reloads.
  Registration is the app's job now, so `injectRegister: null`, and the update
  check script in `index.html` became redundant and was deleted (`register()`
  itself fetches `sw.js` every time) (`frontend/vite.config.ts`,
  `src/hooks/useServiceWorkerUpdate.ts`, `index.html`)
- **No service worker was being registered at all** (#510):
  `virtual:pwa-register` dynamically imports `workbox-window`, which was not a
  dependency, so the bare specifier stayed unresolved and registration failed
  wholesale (`TypeError: Failed to resolve module specifier 'workbox-window'`).
  vite-plugin-pwa also swallows that error unless `onRegisterError` is passed, so
  it went quiet with nothing in the console and no SW anywhere. Added
  `workbox-window` as a dependency and wired `onRegisterError` so it can never
  fail silently again. The previous `autoUpdate` plus injected script used plain
  `navigator.serviceWorker.register` and needed no `workbox-window`, which is why
  this never surfaced (`frontend/package.json`)

## [0.2.41] - 2026-07-25

### Changed
- **The release version is embedded in the frontend bundle** (#508): nothing in
  the bundle referenced the version, so a backend-only release produced a
  byte-identical frontend artifact. `sw.js`'s precache manifest then matched the
  installed one, no service worker swap happened, and clients kept talking to a
  new server on an old build. CC Hub shares its WS protocol types between
  frontend and backend through `shared/types.ts`, so that skew can do real harm.
  The root `package.json`'s `version` is injected through vite's `define` so the
  bundle hash tracks the release, which precaches a new build every time and
  makes the dialog added in 0.2.40 fire reliably. The startup log carries the
  version too, so `/tmp/cc-hub-browser.log` - the only handle when debugging from
  a phone or tablet - says which build is running. The trade-off is that a
  backend-only fix also shows "a new version is available"; preventing protocol
  skew wins (`frontend/vite.config.ts`, `src/main.tsx`)

## [0.2.40] - 2026-07-25

### Fixed
- **Every release required clearing the browser cache by hand** (#506): the
  embedded static serving in the distributed binary returned only
  `Content-Type` and no `Cache-Control`, so the browser's heuristic caching took
  over. The blockage had two stages: (1) a stale `index.html` kept referencing
  the previous version's hashed assets, and (2) **`sw.js` itself came from the
  HTTP cache**, so the `registration.update()` that `index.html` calls on every
  load could not see the new precache manifest. workbox serves `index.html`
  **from the precache** through `NavigationRoute`, so a new version could never
  appear unless the SW updated. Now `/assets/*` (Vite content-hashed and
  immutable) returns `public, max-age=31536000, immutable`, and everything else
  (`index.html` / `sw.js` / `registerSW.js` / icons / the SPA fallback) returns
  `no-cache, must-revalidate`. The SPA fallback (returning `index.html` for an
  unknown route such as `/dashboard`) is distinguished from a real asset hit so
  it is not cached under the requested path. Development (`bun run dev`) goes
  through a different `serveStatic` branch and is unaffected
  (`backend/src/index.ts`)

### Added
- **Detect a new version and ask before updating** (#506): the SW uses
  `registerType: 'autoUpdate'` (`skipWaiting()` + `clientsClaim()`), so the
  worker swaps itself as soon as a new build is precached while the open page
  keeps running the old bundle. Reloading a terminal unasked is rude, so a "new
  version available" bar appears at the bottom of the screen and reloads **only
  when "Reload" is pressed**. Dismissing with "Later" continues on the old bundle
  and it reappears on the next release. Detection subscribes to
  `controllerchange` **at module evaluation time** (`index.html` calls
  `registration.update()` on load and the bundle is 2.3MB, so the worker can
  claim before React mounts and the event would be missed). It also re-checks
  `sw.js` when the tab becomes visible and every 30 minutes, so a tablet left
  open still notices. The first `controllerchange` from claiming on a first visit
  is swallowed (it means "an SW is taking over", not "a new release"). It mounts
  next to `<App />` in `main.tsx`, so no per-layout wiring is needed for mobile /
  tablet / desktop. `z-10010` keeps onboarding and the floating keyboard (both
  `z-10000`+) from stealing the click
  (`frontend/src/components/UpdatePrompt.tsx`,
  `hooks/useServiceWorkerUpdate.ts`)

## [0.2.39] - 2026-07-23

### Fixed
- **A systemd user service's missing PATH made hooks fail with `command not
  found`** (#499): the watcher unit starts the server through `zsh -lc` (a login
  but **non-interactive** shell), and `zsh -lc` reads `.zshenv`/`.zprofile` but
  **not `.zshrc`**. The `~/.local/bin` (`rtk`/`herdr`/`claude`) and `~/bin`
  (`cchub`) that the user's `.zshrc` adds to PATH were missing, so child
  processes spawned by the herdr server (resumed agents, Claude Code hooks) could
  not resolve `cchub`/`rtk` and hit `command not found`. It was hard to see
  because `.cargo/bin` arrives through `.zshenv` and only the `.zshrc` additions
  were absent. `cchub setup` runs from an interactive terminal, so its
  `process.env.PATH` already reflects `.zshrc`; a new `buildServicePath()` takes
  that, guarantees `~/.local/bin` and `~/bin` at the front, and bakes it into
  `Environment=PATH=` in both the cchub and herdr systemd units (deduplicated,
  with a fallback for an empty PATH and `%` escaped as `%%`). It applies when
  `cchub setup` is re-run (`backend/src/commands/setup.ts`, with a new
  `setup-service-path.test.ts`)

### Changed
- **G2 glasses ehpk built as v0.1.19** (#503): the EVEN G2 app including
  0.2.38's voice input, rebuilt as `out.ehpk` (`glasses/`)

## [0.2.38] - 2026-07-23

### Added
- **Voice input on the G2 glasses** (#500): a voice mode for replying or sending
  a prompt to a Claude Code session hands-free through the glasses' microphone.
  The EvenHub SDK only hands over raw PCM, so STT happens on the server: a new
  `POST /api/glasses/stt` wraps 16kHz mono PCM into a WAV, forwards it to **Groq
  `whisper-large-v3-turbo`** (`language=ja`) and returns the transcript. The API
  key never leaves the server. On the glasses, `audioControl(true, Glasses)`
  plus the PCM from `onEvenHubEvent` accumulate, and on a non-waiting session's
  conversation screen a tap starts recording, another stops and transcribes, and
  a confirmation sends it (bracketed paste plus Enter through
  `/sessions/:id/prompt`). Measured at about 0.35s for a Japanese command. The
  EvenHub SDK went 0.0.9 -> 0.0.12 and evenhub-cli 0.1.11 -> 0.1.13
  (`backend/src/routes/glasses.ts`, `glasses/src/{api,display,main}.ts`)

## [0.2.37] - 2026-07-21

### Added
- **A dashboard toggle in the workspace list** (#497): a dashboard button in the
  header of the full-screen workspace list (`SessionModal`). Pressing it opens
  `DashboardPanel` as a right side panel while the workspace list shrinks to the
  remaining width with `flex-1` and moves left, so the two sit side by side
  rather than one hiding the other. Clicking again toggles it off and the list
  returns to full width. `WorkspaceList` gained `onToggleDashboard` /
  `dashboardOpen` props and only draws the button when they are passed, so the
  mobile direct-overlay path (which passes neither) is unchanged. Zoom is applied
  per column to avoid double-zooming the panel. Verified in dev: the button
  appears, the list stays two columns and moves left, and toggling off restores
  full width (`frontend/src/components/SessionModal.tsx`, `WorkspaceList.tsx`)

## [0.2.36] - 2026-07-21

### Added
- **The dashboard's Kimi tab shows OpenRouter spend in USD** (#494): Kimi K3 is
  pay-as-you-go through OpenRouter and only token counts were shown, so the
  actual amount was invisible. Two kinds of number are now distinguished -
  **estimated** (per window 24h/7d and per model: local `usage.record` token
  counts times OpenRouter's public prices, computed separately for prompt, cache
  read, cache write and completion) and **billed** (today, this week and this
  month plus the credit balance, from OpenRouter's `/api/v1/key` +
  `/api/v1/credits`). The alias-to-model resolution pricing needs (`k3` in
  `usage.record` -> `moonshotai/kimi-k3`) is read from `~/.kimi-code/config.toml`.
  No amount is shown for a non-OpenRouter provider, an unknown alias or a failed
  price fetch (`$0.00` reads as "free"). Estimates use rolling windows while
  OpenRouter's are calendar-bounded, so the two never match, and the UI says so

### Fixed
- **Desktop pane zoom ignored the server's `zoomedPaneId`** (#479): the
  herdr-based WS protocol carries zoom state as `zoomedPaneId` on the layout
  message, and mobile respected it while desktop alone discarded it in
  `onLayoutChange` and managed zoom from local state (justified by a comment
  written in the tmux control-mode era). When zoom was restored across a
  reconnect or reload, or another client zoomed, the display (not zoomed) and the
  real PTY size (zoom geometry) diverged. Desktop treats the server's
  `zoomedPaneId` as the single source of truth now: the zoom button only sends an
  explicit intent, and the state flips when the server's layout push confirms it.
  The optimistic set plus an inline 300ms delayed resize/refetch workaround
  collapsed into one effect reacting to a server-confirmed zoom change
  (re-reporting the client size and refetching the viewport of panes revealed by
  unzooming). Verified in dev: zoom survives a reload, zoom syncs both ways
  between two clients, and closing a pane while zoomed falls back correctly
  (`frontend/src/components/DesktopLayout.tsx`)

### Changed
- **Removed the tmux-era respawn / break-pane UX and the pane-dead event**
  (#478): herdr has no concept of a pane outliving its process (tmux's
  `remain-on-exit`) - measured on herdr 0.7.4, a pane disappears from `pane.list`
  the moment its process exits, taking the workspace with it if it was the last
  one - and neither its CLI nor its socket API has anything like respawn. Even
  so, `respawnPane` / `breakPaneToNewSession` threw unconditionally while the WS
  schema, the mux dispatch, the REST endpoint (501) and the dead-pane overlay
  were all wired up, and `pane-dead` had inverted meaning (it fired on a normal
  external close, and the overlay it was supposed to drive could never appear
  because the pane left the layout at the same moment). The WS message types
  (client `respawn-pane`, server `pane-dead`) and their zod schemas, the mux
  dispatch, `POST /:id/panes/respawn`, `HerdrControlSession`'s listener
  machinery, the frontend's `deadPanes` state, overlay and respawn wiring, and
  the locale keys left unused were removed end to end (-224 lines). Reviving an
  agent is covered by the existing resume paths (`POST /:id/resume`, resume from
  history, herdr's `resume_agents_on_restore`). The glasses never referenced
  these messages and are unaffected. Verified in dev: exiting a shell makes the
  pane disappear naturally with no overlay

## [0.2.34] - 2026-07-20

### Changed
- **The frontend identifies sessions by a `peerId:id` composite key throughout**
  (#487): session ids are herdr workspace names and collide across peers, so
  0.2.33 was a stopgap that recorded the peer intent at selection time and
  re-resolved it on every id lookup. The identifier itself is a composite key
  now, and the pane tree (`PaneNode.sessionKey`), the active session, the list of
  open sessions and the localStorage persistence all hold `peerId:id`. It is
  split back into a bare id just before it goes onto a WS subscribe or a REST
  path, so the server protocol is unchanged. Same-named local and peer sessions
  can now be **open at the same time**, and `resolveSessionPeer` and the intent
  persistence (`cchub-desktop-session-peer`) are gone. Existing localStorage is
  migrated automatically once, on first load

## [0.2.33] - 2026-07-20

### Fixed
- **A peer's terminal would not open when a local session had the same name**
  (#486): session ids are herdr workspace names and collide across peers, so a
  bare id lookup resolved to the first match in the merged list (the local
  session). The peer intent recorded at selection time now drives the WS
  connection, the remote-control mode's REST operations, the image upload target
  and the file viewer resolution through one path (`resolveSessionPeer`: intent
  -> open session -> merged list). Mobile propagates peerId into TerminalPage
  too. Deleting and changing the theme take an explicit peerId now, so they
  cannot operate on a same-named local workspace by mistake

## [0.2.32] - 2026-07-20

### Added
- **Todo-list tool calls render as a checklist in the conversation view** (#483):
  the input of TodoWrite (Claude) / TodoList (Kimi) / update_plan (Codex) is
  drawn as a graphical checklist rather than raw JSON. Done is a green check with
  a strikethrough, in progress is a blue dot with emphasis, pending is a gray
  circle, and the section title carries progress as `(done/total)` and is
  expanded by default. Input that does not parse as a todo shape, and every other
  tool, keeps the JSON view

## [0.2.31] - 2026-07-20

### Changed
- **The history facet sidebar puts the period filter on top and scopes the other
  facets by it** (#474): the options and counts for project / agent / branch /
  peer are computed from the sessions inside the selected period (today, 7 days,
  30 days). Choosing "today" shows only values with activity in that window, with
  counts to match. A selected value that falls outside the period stays in the
  list at zero so it can be unchecked in place

## [0.2.30] - 2026-07-19

### Added
- **A Kimi workspace card shows "the last answer" in the recap slot** (#473):
  Kimi has no equivalent of Claude's away_summary, so the last assistant text in
  the session's wire.jsonl (think parts excluded, truncated to 500 characters) is
  returned as `ccRecap`. The card's recap display is agent-agnostic so no
  frontend change was needed, and the title/first-prompt line is hidden while it
  shows, exactly as with Claude. It applies to kimi sessions whose native session
  id can be resolved

## [0.2.29] - 2026-07-19

### Added
- **Kimi Code CLI is supported as a fourth agent provider** (#472): Kimi joins
  the agent picker when creating a workspace. herdr detects the kimi process at
  runtime and `cchub setup` also runs `herdr integration install kimi`, so the
  native session id link and the pane indicator work as they are. It reads
  `state.json` / `wire.jsonl` under `~/.kimi-code/sessions` for the active
  session's thread metadata (title, first prompt, token usage), the history
  project list, search and the conversation view, and resumes from history with
  `kimi --session '<id>'`. Hook notifications need only `cchub notify` registered
  under `[[hooks]]` in `~/.kimi-code/config.toml`, since the payload is
  Claude-compatible snake_case
- **A Kimi tab on the dashboard**: `usage.record` entries in wire.jsonl are
  aggregated across every session (sub-agents included) to show 24h/7d token
  usage, turn counts and a per-model breakdown (there is no rate-limit window
  data locally, so totals are all it can show)

## [0.2.28] - 2026-07-19

### Added
- **Remote-control mode (desktop only)** (#470): an Unplug toggle in the header
  stops xterm's live drawing (the WS subscribe into PaneController), leaving the
  local herdr client in possession of the terminal while CC Hub is used as a
  remote for the workspace list plus focus / split / close / prompt / Files /
  Dashboard / Chat. While it is on, pane operations and Chat sends go over REST
  (the mux WS refuses operations on a session it has not subscribed to). The
  xterm area is replaced by a placeholder with a link into Chat. Persisted in
  `cchub-remote-control` localStorage (off by default) and reflected in other
  tabs immediately through the storage event. Not available on tablet or mobile,
  and no backend changes

## [0.2.27] - 2026-07-19

### Changed
- **The session modal's redundant "Sessions" heading is gone** (#468): the
  workspace/history tabs already act as the heading, so the "Sessions" title row
  was removed and the segmented tabs (workspaces / history) merged into one row
  with search, + and x. The top tightens up and the list area grows upward.
  `WorkspaceList` is shared by desktop / tablet / mobile, so all three get it

## [0.2.26] - 2026-07-19

### Changed
- **A recap is shown per pane in a multi-pane / multi-tab workspace** (#466):
  following #463, which moved model/ctx/mem onto panes, the recap (away summary)
  does the same. The card header used to show the recap of one representative
  pane, which was ambiguous with several agent panes. Each Claude pane row now
  carries its own recap, but only with multiple panes or tabs (`getSessionById`
  is cached and cheap). The ordinary single-pane single-tab case keeps the header
  recap (`PaneInfo.recap` / `recapAt` added)

## [0.2.25] - 2026-07-19

### Fixed
- **`cchub setup` adapts its agent-integration checks to the environment**: it no
  longer runs herdr integration or the Codex hook migration against an
  uninitialized or absent Claude Code / Codex, and shows an appropriate warning
- **`cchub setup`'s messages are i18n-aware**: Japanese or English according to
  the `LC_ALL` / `LC_MESSAGES` / `LANG` locale
- **A new tab could not be created in a single-tab workspace** (#462): the tab UI
  (the list plus "+ New tab") only appeared with two or more tabs, and the
  backend only returned `tabs[]` when `tab_count > 1`, so an ordinary single-tab
  workspace had no route to creating its second. `tabs[]` / `activeTabId` are
  always returned now (without adding a `tab.list` RPC), "New tab" was added to
  the workspace long-press menu, and "+ New tab" appears inline when expanded

### Changed
- **model/ctx/mem are shown per pane in a multi-pane / multi-tab workspace**
  (#463): the card header's model/ctx%/mem were for one representative pane and
  were ambiguous with several panes or tabs. They move to each agent pane row,
  but only with multiple panes or tabs (Claude takes ctx/model from its own
  `.jsonl`; any agent pane takes mem from its pid). The ordinary single-pane
  single-tab case keeps the header display (`PaneInfo.metrics` added)

## [0.2.24] - 2026-07-19

### Added
- **Workspace tabs (herdr's workspace > tab > pane as three levels)** (#455,
  #456, #457): CC Hub had no concept of a tab, so a workspace with several tabs
  created by `herdr tab` had every tab's panes mixed flat into one screen, losing
  each tab's proportions and zoom and breaking the display. The control session
  now **draws only the active tab** and follows tab switches with
  `workspace.get`'s `active_tab_id` as the authority (it never mixes another
  tab's panes, and it does not end the session when the active tab is empty but
  other tabs remain). **Tabs are nested under each workspace in the session
  list**, where a tap switches, "+ New tab" creates and a long press closes
  (desktop / tablet / mobile alike). `SessionResponse.tabs[]` / `activeTabId` are
  exposed, with WebSocket (`select-tab` / `create-tab` / `close-tab`) and REST
  (`POST /:id/tabs/{select,create,close}`) to match

### Changed
- **Internal, API and frontend naming aligned from "Session" to "Workspace"**
  (#454, #458, #460): one CC Hub session is exactly one herdr workspace. The
  backend's types and methods moved to workspace vocabulary and `/api/workspaces`
  was added as the canonical path (the old `/api/sessions` is **kept as an
  alias**, so the `cchub send`/`peek` CLI, peers and the glasses keep working
  unchanged). The frontend moved to `/api/workspaces` and the list header, create
  button and similar labels now say "workspace". Agent conversation history
  (`/api/sessions/history`) is a different concept and stays
  - Note: an updated frontend calls `/api/workspaces` on peers too, so a peer
    that has not been updated can 404 temporarily (updating the fleet resolves
    it through the alias)

## [0.2.23] - 2026-07-19

### Fixed
- **A deleted session's old terminal lingered and produced a control-stream error
  when a session of the same name was created** (#452): deleting a session now
  notifies connected clients so the old xterm and pane cache are discarded at
  once. herdr's immutable workspace ID distinguishes the old and new instances of
  a name, and a newly created session always re-subscribes to a new control
  stream. This also prevents an old deferred cleanup from deleting a same-named
  session that was created since

## [0.2.22] - 2026-07-19

### Fixed
- **Opening one session on two devices flickered continuously** (#450): a tablet
  and a phone showing the same session sent their own container sizes at each
  other, and the shared session size bounced back and forth. Changed to
  active-client-owns-size: only the active device (the one that typed last, or
  claimed control with a tap) drives the size, and an inactive device's resize is
  recorded without being applied, which ends the tug of war. **Tapping the screen
  claims control** (tap-to-resize), typing activates automatically, and
  disconnecting hands control to whoever is left. A single client behaves as
  before

### Changed
- **Per-client pane sizing (smallest-wins, phases 2/3) demoted to opt-in**
  (#450): 0.2.21 turned it on by default, and it letterboxed even the active
  device. The active-client approach above wins for the common case.
  `CCHUB_PER_CLIENT_SIZING=1` still enables it

## [0.2.21] - 2026-07-19

### Added
- **Per-client pane sizing on by default (phases 2/3/enable)** (#443, #444,
  #447): mobile and desktop declare each pane's drawing size demand, and **only
  when two or more clients show the same session at different sizes** the shared
  pane follows the smallest demand (tmux-style letterboxing, avoiding a
  last-writer fight). With a single client the old tree/zoom path is preserved
  exactly, so behavior is unchanged. Rounding differences within three columns
  are ignored, preventing a shrink right after a zoom and the resulting jitter.
  On by default; `CCHUB_PER_CLIENT_SIZING=0` disables it as an escape hatch

### Fixed
- **The dashboard's server information switched with the agent tabs** (#445):
  usage and daily activity became an "agent usage" section, while network latency
  and each peer's CPU/memory/disk became an always-visible "server status"
  section. Switching between Claude / Codex / Grok no longer hides the server
  status, and the tabs and sections gained accessibility attributes

## [0.2.20] - 2026-07-19

### Added
- **Groundwork for per-client pane sizing (phase 1, off by default)** (#441): a
  mobile client declares the size demand of the pane it is showing, and the
  server can hold and aggregate those per client. In the `CCHUB_PER_CLIENT_SIZING=1`
  diagnostic mode it only verifies equivalence with current sizing; real PTY
  sizing stays on the existing path, making this non-destructive

### Fixed
- **The conversation history of an open Codex session could not be shown**
  (#439): where the process name comes through as `node-MainThread`, or where a
  working directory has several histories, guessing the newest thread from the
  cwd could pick the wrong session ID. The agent kind and native session ID
  reported by herdr's `agent.list` are the only source of identity now, and the
  cwd fallback for Codex/Grok is gone. A single unfocused pane can also be
  selected, and the history button is safely disabled when no native ID has been
  reported
- **An explicit zoom/unzoom was treated as a toggle** (#441): `zoomed` was added
  to the `zoom-pane` Zod schema so an idempotent zoom intent from the client is
  not stripped

### Changed
- **Codex hooks consolidated into `~/.codex/hooks.json`** (#439): herdr's
  `SessionStart` and CC Hub's `Stop` / `PostToolUse:AskUserQuestion` live in the
  same JSON, and the duplicate hook definitions in `config.toml` are deleted
  during migration. `cchub setup` installs the herdr integration for both Claude
  and Codex, and preserves existing unknown hooks and `[hooks.state]`

## [0.2.19] - 2026-07-19

### Fixed
- **Reloading a phone while a multi-pane session was zoomed made the tab bar
  disappear** (#437): zoom is shared server state, and the protocol could only
  express it as a "1-leaf layout", indistinguishable from a genuinely
  single-pane session. On reload the server resent that 1-leaf initial layout,
  the client read it as "one pane", and the tab bar vanished, leaving no way to
  switch panes or unzoom. The layout is always sent as the full tree now, with
  zoom carried separately as `zoomedPaneId` metadata (the 1-leaf collapse in
  `toTmuxLayout` is gone, `computeRects` gained an `ignoreZoom` option, and
  `zoom-pane` carries an explicit `zoomed` intent). Mobile dropped its
  `isZoomedRef` guesswork and idempotently re-asserts zoom against the server's
  `zoomedPaneId`, and the tab highlight after a reload matches the pane the
  server restored. As a side effect, opening a session zoomed on a phone no
  longer collapses the split on desktop

## [0.2.18] - 2026-07-19

### Fixed
- **Codex usage was wrongly reported as having hit its limit** (#435):
  `credits.has_credits: false`, which means no purchased credits remain, was read
  as the plan's usage cap being reached, so "limit reached" appeared at 9% usage.
  Only the explicit `rate_limit_reached_type` Codex returns counts as reaching a
  limit now, and the measured usage is no longer overwritten to 100% by
  inference

## [0.2.17] - 2026-07-19

### Fixed
- **Stop the herdr agent-status watcher's resubscribe loop** (#433):
  `events.subscribe` was opening and closing about 2.5 times a second, burning
  CPU continuously even with cchub idle. herdr resends a snapshot of existing
  panes on every subscribe, and its replay buffer held a ghost `pane_created`
  (`w2N:p1` on this machine) that appears in none of `pane.list`,
  `workspace.list` or `pane.get` - which made "resubscribe -> snapshot resent ->
  resubscribe" self-sustaining. The resubscribe decision now comes from a set
  difference against `pane.list` (the truth) rather than from event payloads, so
  it only resubscribes when the pane set actually changed
  (`paneSetRequiresResubscribe`)

## [0.2.16] - 2026-07-19

### Changed
- **The jump menu of a multi-pane session moved under the pane** (#431): the jump
  menu on a remote-control session ("go to this terminal", "open in the Claude
  app") was per session card, which is ambiguous with several panes (claude +
  grok, say). Tapping a multi-pane card expands the pane list directly (tapping a
  pane row is what "go to" means), and "open in the Claude app" is nested
  directly under the bridged agent pane row. A single-pane session keeps the old
  menu

## [0.2.15] - 2026-07-19

### Added
- **Grok Build (xAI) supported as a third agent** (#426): Grok appears in the
  session creation UI, and process detection, resume (`grok --resume '<id>'`),
  history and search, the conversation view, token/model metrics and hook
  notifications all work as they do for Claude / Codex
  - Session store: scans `~/.grok/sessions/<URL-encoded cwd>/<uuid>/`
    (`summary.json` metadata, `chat_history.jsonl` conversation,
    `prompt_history.jsonl` first prompt, `turn_completed` token usage in
    `updates.jsonl`). Encoding is matched by `decodeURIComponent` on the
    directory name, which structurally rules out mismatches from re-encoding
  - Hook notifications: Grok reads `~/.claude/settings.json`'s hooks through a
    compatibility layer, so they fire with no configuration, but the stdin JSON
    is its own camelCase shape (`hookEventName: "stop"` / `sessionId` /
    `transcriptPath`) and is normalized to Claude's in `/api/notify`
    (`normalizeHookBody`, with a real captured payload as the fixture). Message
    generation for Grok transcripts (updates.jsonl) was added too
  - herdr does not support Grok, so the indicator is hook-based (the same way as
    Codex)
- **A Grok tab on the dashboard** (#429): xAI does not store rate-limit windows
  locally, so consumption is aggregated in place of a cycle percentage - 24h and
  7d token totals, turn counts, a per-model breakdown and a plan badge (a
  `*-free` model means Free). The tab bar was generalized to "list the providers
  that have usage data"
- **MIT LICENSE** (#428)

### Changed
- **Adding an agent is now a registry entry plus interface implementations**
  (#426): `AGENT_PROVIDERS` (shared/types.ts) gained `displayName` and a new
  `threadAgentOf()`. The backend routes loop over provider maps behind the shared
  `AgentThreadService` / `AgentHistoryProvider` interfaces
  (`services/agent-providers.ts`), removing about 20 hardcoded `=== 'codex'`
  branches. The frontend generalized `useCodexConversation` into
  `useThreadConversation(agent, ...)`, and badge colors were collected into
  `utils/agentDisplay.ts`
- **The model name in the session list moved into the agent badge** (#427): shown
  inside the badge as `Claude - Opus 4.8`, saving space on the row

## [0.2.14] - 2026-07-18

### Changed
- **The session list's `used` (cumulative tokens) was replaced by the model in
  use** (#424): almost nobody read the cumulative token count, so it was dropped
  in favor of the model the agent is currently using. For Claude, the
  `latestModel` already extracted from the `.jsonl` for the context calculation
  is exposed as `metrics.model` and shortened for display (`claude-opus-4-8` ->
  `Opus 4.8`, with the older `claude-3-5-sonnet-*` -> `Sonnet 3.5` handled too,
  and the full id in a tooltip). For Codex, the tail scan of the rollout that
  reads `token_count` also picks up the latest `turn_context`'s `payload.model`
  (for example `gpt-5.6-sol`) and shows it as is (`shared/types.ts`,
  `backend/src/services/session-metrics.ts`, `codex.ts`,
  `frontend/src/components/SessionList.tsx`, `frontend/src/utils/format.ts`)

## [0.2.13] - 2026-07-18

### Changed
- **Pane lifecycle events are filtered by workspace before reconciling**: each
  session subscribes to pane.created/closed/exited to reconcile its pane set, and
  herdr's lifecycle subscription **has no server-side filter** (confirmed on
  protocol 16) while the handler ignored the payload. So **one pane event in any
  workspace made every active session run a pane.list reconcile**. Investigation
  also measured that herdr **replays about 50 past events to a new subscriber** -
  so opening a session kicked off a burst of unrelated reconciles. The workspace
  on the received event is inspected now (`data.pane.workspace_id` for
  `pane_created`, `data.workspace_id` for `pane_closed`/`exited`; real payloads
  were captured as test fixtures) and anything outside this workspace is skipped.
  An event with no identifiable workspace still reconciles (fail open). Verified
  end to end against the device that an external split in our own workspace
  arrives as a layout push in about 180ms on a warmed subscription
  (`backend/src/services/herdr-client.ts`, `herdr-control.ts`)
  - A measurement found along the way: herdr **delays delivery by about four
    seconds right after a subscribe** (about 40ms once warm; identical over a raw
    socket without cchub, so it is herdr's own behavior)
- **Removed the tmux install from CI**: after the herdr migration nothing uses
  tmux at test time or run time. The last item of the tmux cleanup (#416,
  v0.2.11) (`.github/workflows/test.yml`)

## [0.2.12] - 2026-07-18

### Fixed
- **Pane divider dragging rebuilt around boundary semantics (verified on a real
  tablet)**: four resize defects fixed together. (1) **Drag tracking**: on a
  tablet one finger movement fires both pointer and touch events, rebuilding the
  pane tree twice per move, and the touch listener was re-registered on every
  move. Updates are collapsed to one per frame with rAF, the listener is
  registered once at drag start, and the final position is flushed on release.
  (2) **Violent oscillation with four panes**: `forceResize` on viewport arrival
  sent one pane's proposed size as the whole client's size, and the overall width
  ping-ponged between 38 and 151 (measured). forceResize is disabled with several
  panes. (3) **A drag not taking effect, or moving unrelated panes**: the old
  code sent every pane's rounded size on release, and the individual resize-pane
  messages fought over shared ancestor splits. A pane-size approach cannot
  express the outer divider of a same-direction nested split (h[h[A,B],C]) at
  all. A new `set-split-ratios` batch message (identifying each split by the
  lowest common ancestor of the leaves on either side) applies once, atomically,
  on release, while the drag itself is a local optimistic update with the server
  layout held back. `applyBoundaryDrag` stretches only the two neighbors of the
  boundary being moved and keeps every other pane's absolute size (as tmux does).
  (4) **Split ID collisions**: the frontend's split IDs came from coordinates
  (`split-${x}-${y}`), so a nested split sharing its parent's top-left corner
  (the left column of a 2x2, the inner left of four columns) had the same ID as
  its parent, and dragging the leftmost divider moved the root's
  (`frontend/src/components/DesktopLayout.tsx`, `PaneContainer.tsx`,
  `useMultiplexedTerminal.ts`, `shared/types.ts`,
  `backend/src/services/herdr-layout.ts`, `herdr-control.ts`,
  `backend/src/routes/terminal-mux.ts`)
  - The backend gained `PaneLayoutTree.setSplitRatio` (LCA identification plus
    clamping, seven unit tests) and a `setSplitRatios` batch (one applyLayout).
    An end-to-end run against real herdr and `/ws/mux` confirmed that a
    three-entry batch for a four-column arrangement applies as expected in a
    single layout push

## [0.2.11] - 2026-07-18

### Fixed
- **A multi-pane layout collapsed into one row when the backend rebuilt it**: a
  session's split tree belongs to CC Hub (herdr's grid cannot be resized
  headlessly), and its restore path (`setInitialPanes`) carried a tmux-era
  assumption and always rebuilt the panes as an evenly divided single row. So
  every time CC Hub recreated a `HerdrControlSession` - **after a backend restart,
  or on re-subscribing to a session past its 30-second grace period** - a 2x2 or
  L-shaped grid collapsed into one row, even though herdr still held the real
  layout. The actual split tree returned by herdr's `layout.export` (nested
  pane/split nodes with `direction`/`ratio`) maps almost one to one onto CC Hub's
  own `LayoutNode`, so it takes priority now and restores structure, split
  direction and zoom/focus. It falls back to the old flat chain only when the
  export cannot be fetched or its pane set does not match the real panes, so **the
  worst case is the old behavior** and a broken tree is never drawn. Verified on
  herdr 0.7.4 that an L-shaped workspace restores as
  `horizontal[leaf, vertical[leaf, leaf]]` (`backend/src/services/herdr-control.ts`,
  `herdr-layout.ts`, `herdr-client.ts`)

### Changed
- **Cleaned up dead code and stale wording left by the tmux -> herdr migration**:
  deleted the `HerdrControlSession.sendCommand` stub, which had no callers and
  only threw `not supported in herdr mode`. Renamed `terminal-mux.ts`'s
  file-local `tmuxService` (actually a `HerdrService`) to `herdrService`, and
  corrected comments that described current behavior in tmux terms ("tmux -CC
  subprocess", "tmux's pane size" and so on). Deliberate analogies such as the
  `%N` form and "tmux convention" stay, because they help. No runtime behavior
  change (`backend/src/routes/terminal-mux.ts`, `herdr-control.ts`)

## [0.2.10] - 2026-07-18

### Fixed
- **herdr's immediate agent-status updates had never once worked**: herdr pushes
  the moment an agent starts, finishes or blocks for input, and the lifecycle
  branch of that watcher (`herdr-agent-status.ts`) **had not fired once since it
  was written**. The UI silently fell back to the 5-second session poll. The
  cause is that herdr's event naming is asymmetric in three places (confirmed on
  herdr 0.7.4 / protocol 16): **subscription request types use dots**
  (`pane.created`; anything else is rejected as an `unknown variant`), **received
  lifecycle events are snake_case** (`pane_created`), and **received per-pane
  status is dotted** (`pane.agent_status_changed`). The watcher compared received
  event names against the dotted list, so a snake_case lifecycle event could
  never match, which meant (1) a pane created after startup never got its status
  subscription set up and (2) pane creation and destruction were not pushed
  immediately and waited the full five seconds. The docstring had designed for
  "a dropped event costs latency, not correctness", so a 100% drop rate was
  indistinguishable from normal operation and went unnoticed. Subscription
  requests keep their dots, and only the classification of received events
  normalizes `.` to `_` so both forms are accepted. Measured in dev: an immediate
  `pane_created` push went from about 2.5-3.5s (the poll interval) to 79-173ms,
  and a new pane's status change from "never arrives" to 46-183ms
  (`backend/src/services/herdr-agent-status.ts`)
  - The `pane.agent_status_changed` branch (the main feature) matched dots
    against dots and did work. Only the lifecycle branch was dead
  - Added unit tests for a pure function (`classifyHerdrEvent`) pinning both
    naming forms

## [0.2.9] - 2026-07-17

### Fixed
- **Every bit of rate control disappeared when the usage API failed**:
  `/api/oauth/usage` is rate-limited **per account**, so cchub's cache is the only
  thing standing between the dashboard's polling (every 30 seconds times the
  number of open clients) and a 429. That cache had a hole: the check was
  `if (this.lastSuccessfulResult && now - this.lastFetchAt < CACHE_TTL_MS)`, so
  **it never held without a successful result**, and `lastFetchAt` **was only
  updated on success**. A backoff was installed only for a 429. As a result,
  **any non-429 failure (a 500, a 401 while Claude Code refreshes its token, a
  network error) removed all rate control at once**, and every poll went straight
  upstream with neither a result to return nor a cooldown. The throttle
  disappeared **exactly when upstream was unhealthy and it was needed most**, and
  cchub could have produced a 429 itself. The attempt is stamped when it starts
  and gates on that, so the TTL is a floor between requests regardless of how the
  previous one ended (a 429 backoff still overrides it with a longer window)
  (`backend/src/services/anthropic-usage.ts`)
  - As a side effect this **absorbs #352's dedicated no-credentials cooldown** (a
    missing token is one more kind of attempt that returned nothing). Its field
    and timer are gone, one less piece of persistent state
  - `UsageLimitsStatus.lastFetchAt` was already documented in the type as "when
    the last attempt happened" while the implementation only set it on success.
    It now means what the type says, which also makes the UI correct while
    failing
  - For the record, the 429 observed on 2026-07-17 was not cchub's doing (it made
    two calls in twelve hours and backed off correctly both times). Another
    process on the same account exhausting the quota takes cchub down with it,
    and cchub's cache cannot control another process

### Changed
- **Removed the tmux remains the herdr migration left behind**: the old tmux
  service itself went in v0.2.0, and three kinds of residue stayed, one of which
  did real harm
  - **`install.sh` required tmux** - it exited 1 without it and pointed at
    `sudo apt install tmux`, while **checking for herdr not at all** (the thing CC
    Hub genuinely cannot run without). It demanded a package it does not use and
    said nothing about the one it needs, so it checks for herdr now
  - **Copy mode and the paste buffer were wired up but dead** - both are
    tmux-specific with no herdr equivalent, and the migration reduced them to
    `return false` / `return null` stubs with the wiring left live. `Terminal.tsx`
    made an HTTP round trip **every time the soft keyboard closed** to ask a
    question that always answered false, and the `q` it would have sent could
    never fire. Ctrl+C (with no selection) also fetched a buffer that was always
    null. Two stubs, two routes (`GET /:id/copy-mode`, `GET /clipboard`) and two
    call sites were deleted (**Ctrl+C behavior is preserved exactly** - the
    browser copy is still suppressed and the key reaches xterm as SIGINT)
  - **Names that had become lies** - `const tmuxService = new HerdrService()`,
    `tmuxSessions`, comments saying "if tmux did not report it" and so on were
    renamed to match reality
  - CHANGELOG, specs and poc are historical records and were not touched.
    `TmuxLayoutNode` and `%N` pane IDs are **a live wire format shared with the
    frontend and the glasses app**, and `tmuxSessionId` is a response field that
    also travels through peer resume, so all of those stay for now

## [0.2.8] - 2026-07-17

### Fixed
- **Sessions would not open after a herdr restart, and conversations were not
  restored (#407)**: after restarting the herdr server, sessions appeared in the
  list, and opening one gave a black "Connecting..." and
  `Failed to subscribe: herdr server is too old: pane.list returned no scroll state (protocol >= 16 / v0.7.3+ required)`.
  **A complete misdiagnosis that appeared even on the newest herdr (v0.7.4 /
  protocol 16)**, so following its advice fixed nothing. The cause was a
  deadlock of mutual waiting between cchub and herdr: a pane returns no `scroll`
  until it has a terminal runtime, a restored pane has no runtime until its agent
  is resumed, and herdr defers that resume "until a client connects with a
  non-zero size" (`pending_agent_resume_candidates()` returns immediately on a
  0x0 `terminal_area`). cchub decided a missing `scroll` meant an old server and
  refused to subscribe -> no size was ever attached -> the resume never fired ->
  no runtime, each side waiting on the other. A missing `scroll` is treated as
  the **normal transient state** "this pane has no runtime yet" now, falling back
  to the client's rows and continuing the subscribe. As a result **opening a
  session is enough for herdr to restore the original conversation**
  (`claude --resume <original conversation ID>`)
  (`backend/src/services/herdr-control.ts`)
  - Version-skew detection stopped guessing and consolidated onto the accurate
    source that already existed (HerdrUpdateService reading the real protocol
    number from `herdr status --json`, #393)
  - This deadlock predates v0.2.3 (back then it was a TypeError on
    `pane.scroll.viewport_rows` producing a silent "Failed to subscribe"). v0.2.3
    did not cause it, it only gave it the wrong name, and **native restore has
    most likely never once worked through cchub since the herdr migration
    (v0.2.0)**. That is why, even with `resume_agents_on_restore = true`, a
    manual `-r` from the history tab was the only way
  - Note that `herdr agent list` reports a pane with no runtime as "claude /
    idle" (it sets the state optimistically from the restore plan) while no real
    process exists. cchub looks at the real process and correctly reports
    `agent=None`
- **The session name was clipped in the mobile bottom bar**: `cchub-work-1`
  became `cchub-work-...`, and with several sessions open **there was no way to
  tell which one you were looking at**. The name was cut at a fixed
  `max-w-[84px]` while a `flex-1` spacer next to it wasted the room (empty space
  right beside the clipped text). The selector absorbs the slack instead of the
  spacer, so the name gets all the width the action buttons do not use, and it
  truncates only when it genuinely overflows the bar (`frontend/src/App.tsx`)

## [0.2.7] - 2026-07-17

### Changed
- **Session order has herdr as its single source of truth**: the order was held
  twice - cchub's own `sessionOrder` (in `session-metadata.json`, and in
  `peers.json` for cross-peer order) sat on top of herdr's workspace order.
  Reordering in one drifted from the other, and it had drifted in production (a
  session was first on the cchub side and fifth on herdr's). Both cchub stores
  were deleted and a drag writes straight to herdr's `workspace.move`.
  `listSessions()` already builds in `workspace.list` order, so the change was
  mostly the **removal** of two sorting layers (the server-side sort in
  `sessions.ts` and `sortByMergedOrder` in `useSessions.ts`), leaving one less
  piece of persistent state. Reordering in herdr's TUI now shows up in cchub, and
  the reverse (`backend/src/services/herdr.ts`, `routes/sessions.ts`,
  `services/session-metadata.ts`, `services/peer-registry.ts`, `routes/peers.ts`,
  `frontend/src/hooks/useSessions.ts`, `components/SessionList.tsx`)
  - `PUT /api/sessions/order` and `GET|PUT /api/peers/session-order` are gone,
    replaced by `POST /api/sessions/:id/move { index }`. A peer's session travels
    through `sessionFetch` to that peer's cchub and on to that peer's herdr
  - herdr's `insert_index` means "insert before the workspace currently at that
    index" and is evaluated while the moved workspace is still in the list. A
    move backwards lands exactly on the index while a move forwards lands one
    short, so it is corrected (measured on herdr 0.7.3/0.7.4)
  - **Order is grouped per peer** (between peers by the display order from
    `PUT /api/peers/order`, within a peer by that herdr's order). herdr only
    knows its own machine's workspaces, so a drag across a peer boundary has
    nowhere to be stored and is ignored. A session in `state: 'lost'` has no
    workspace and sorts to the end
  - On migration the existing cchub-side order is discarded and herdr's becomes
    authoritative (the dead `sessionOrder` key in `peers.json` is removed on the
    next save)

## [0.2.6] - 2026-07-17

### Fixed
- **Tapping an OS notification did not navigate to its session (#400)**: an
  existing window is now switched through a `postMessage` from the service worker
  without reloading the SPA, and a deep link is only opened when no window
  exists. The target is resolved from both Claude's `ccSessionId` and Codex's
  `agentSessionId`, and a session that is not open yet is added from the live API
  list and opened. The same navigation is wired into desktop/tablet's saved pane
  state, a remote peer's `peerId`, and ordinary browser notifications that do not
  use a service worker (`frontend/public/sw-notification.js`,
  `frontend/src/App.tsx`, `frontend/src/components/DesktopLayout.tsx`,
  `frontend/src/utils/notificationNavigation.ts`)

## [0.2.5] - 2026-07-16

### Added
- **The history facet sidebar can be resized by dragging**: a long project path
  was cut off at the fixed 240px and became indistinguishable. The handle at the
  sidebar's right edge drags with a mouse or touch between 180 and 480px (the
  list keeps at least 320px), and the width is saved to `localStorage`
  (`cchub-history-sidebar-width`) and survives a reload. The implementation
  follows FileViewer's existing resize pattern
  (`frontend/src/components/history/SessionHistoryV2.tsx`)

## [0.2.4] - 2026-07-16

### Added
- **Per-model usage limits (Fable and friends) appear on the chart**: Anthropic's
  `GET /api/oauth/usage` gained a `limits[]` array, and **a limit scoped to a
  specific model appears only there**. cchub only read `five_hour` /
  `seven_day`, so while the dashboard reported "plenty of room (68%)", Fable's
  weekly limit could already be at 100%, critical and in force, entirely
  invisible. Entries with a non-null `scope` (that is, per model) are extracted
  and overlaid as extra lines on the chart matching their `group` (`session` ->
  5 hours, `weekly` -> 7 days), with the percentage in the legend colored by
  Anthropic's own `severity`. It does not depend on the name `"Fable"` - whatever
  the API scopes becomes a line - so new models need no change. The cycle itself
  still comes from `five_hour` / `seven_day`, and an unexpected shape in
  `limits[]` cannot break the existing chart (every field is validated and an
  uninterpretable entry is discarded rather than guessed at). Per-model values
  are recorded in the usage history too, so the lines are real data rather than
  straight-line interpolation (snapshots from before this have no `scoped` key
  and are treated as "not measured", not as 0%)
  (`backend/src/services/anthropic-usage.ts`, `usage-history.ts`,
  `frontend/src/components/dashboard/UsageChart.tsx`, `UsageLimits.tsx`)
  - Right now the API only splits the weekly limit per model (the 5-hour one is a
    single line across all models). If scoped limits with `group: "session"`
    start appearing, they will show up on the 5-hour chart with no code change

## [0.2.3] - 2026-07-16

### Fixed
- **Remote log delivery failed wholesale with 401**: `remoteLogger.ts` posted to
  `/api/logs` with a plain fetch and no auth header, so in an environment with
  password auth no browser log ever reached the server and the console filled
  with 401 errors. The stored token (`cc-hub-token`) is attached as
  `Authorization: Bearer`, and after a 401 sending stops until the token changes
  (so a logged-out page does not fire a guaranteed-to-fail request on every
  console call) (`frontend/src/utils/remoteLogger.ts`)
- **A subscribe against an old herdr server failed with no explanation**: a
  server below protocol 16 (herdr v0.7.3) does not return `scroll` in
  `pane.list`, so reading `pane.scroll.viewport_rows` threw a TypeError and the
  browser received nothing but `Failed to subscribe` with a blank terminal (it
  really happened through a version skew where the server kept running the old
  build after `herdr update` / `brew upgrade`). It is detected at the subscribe
  entry point and throws an error carrying the remedy ("update herdr and restart
  the server"), the error detail is forwarded to the client, and the read-only
  viewport / peek paths no longer break on a missing `scroll`
  (`backend/src/services/herdr-control.ts`, `herdr-client.ts`,
  `backend/src/routes/terminal-mux.ts`)

## [0.2.2] - 2026-07-15

### Changed
- **The session indicator comes from herdr's agent detection (hooks no longer
  required, #390)**: the indicator used to build its state transitions from hook
  events (`PreToolUse`/`UserPromptSubmit` -> working, `Stop` -> done) with
  herdr's `blocked` correction layered on top. With hooks unconfigured, a missed
  event or an agent killed midway, that produced a **confidently wrong** display.
  herdr looks at the pane itself to decide the agent's state, so it is the source
  of truth now (measured on herdr 0.7.3 / Claude 2.x: `idle` before a turn,
  `working` during a response, `blocked` waiting on AskUserQuestion or a
  permission prompt, `done` after a response). An unknown state (including ones
  herdr may add later) is not guessed at and falls back to the hook state
  (`backend/src/routes/sessions.ts`, `backend/src/services/herdr.ts`)
- **The indicator is immediate**: it subscribes to herdr's
  `pane.agent_status_changed` and pushes the session list the moment the state
  changes (previously up to a five-second poll). The subscription is per pane
  (`pane_id` is required), so it is re-established as panes are created and
  destroyed. The watcher only decides **when to rebuild**, and the values still
  come from `pane.list`, so a dropped event costs latency rather than
  correctness (`backend/src/services/herdr-agent-status.ts`)
- **Only two hooks are needed now**: `Stop` (the notification body) and
  `PostToolUse`/`AskUserQuestion` (the question's tool name). **`PreToolUse` and
  `UserPromptSubmit` are unnecessary** and no longer warned about when absent
  (leaving them configured does no harm). `PreToolUse` spawns a `cchub notify`
  process on every tool call, so removing it saves that

### Added
- **herdr version-skew detection and a dashboard notice (#393)**: `herdr update`
  only replaces the binary while the running server keeps the old build. cchub
  spawns the herdr **binary** for pane control, so in between it is a new CLI
  against an old server, and the symptom shows up as "the terminal will not
  connect". It reads `herdr status --json` (which lists the on-disk binary and
  the running server side by side and returns herdr's own `restart_needed`) with
  a 30-second cache and warns on the dashboard when they differ. Output it cannot
  interpret (herdr not installed, a format change, unparseable) **degrades to no
  warning** (`backend/src/services/herdr-update.ts`)
- **An apply button on the warning**: `POST /api/herdr/apply-update`
  (authenticated) runs `herdr update` plus a supervised restart (systemd:
  `systemctl --user restart herdr`; launchd: `launchctl kickstart -k`). A failed
  update does not proceed to the restart. It runs **only when the user presses
  it** and is never called from the `cchub update --auto` timer. When herdr runs
  outside systemd/launchd the button is not offered and instructions are shown
  instead. The warning text spells out the cost of a restart (every pane's PTY is
  recreated; agent conversations restore automatically but a running command is
  lost)

## [0.2.1] - 2026-07-15

### Fixed
- **`herdr command not found` under systemd / launchd made startup fail (a
  v0.2.0 regression)**: the service's `ExecStart` is `zsh -lc` (a
  non-interactive login shell, so no `.zshrc`), which leaves herdr's official
  install location `~/.local/bin` out of PATH, so startup failed and entered a
  restart loop even with herdr installed and running. The herdr binary is
  resolved once through `$HERDR_BIN` -> PATH -> the known install locations
  (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`), and every
  later herdr invocation (the startup check, the server autostart, a pane's
  control stream, `cchub setup`'s provisioning) uses the absolute path
  (`backend/src/services/herdr-client.ts`)

## [0.2.0] - 2026-07-15

The terminal backend moved wholesale from tmux to **herdr**. **herdr is now
required**, and existing tmux sessions do not carry over (migration steps below).

### Changed
- **The terminal backend moved from tmux to herdr**: a session maps to a herdr
  workspace and a pane to a herdr pane, and terminal I/O goes through the herdr
  server's NDJSON socket API (`~/.config/herdr/herdr.sock`). A
  `herdr terminal session control` runs per pane, passing input through as raw
  bytes (base64) and receiving output as `terminal.frame`. tmux's octal decoding,
  layout string parsing and `send-keys` escaping constraints are gone, and mouse
  SGR, bracketed paste and escape sequences pass through intact
  (`backend/src/services/herdr-client.ts`, `herdr-control.ts`, `herdr.ts`)
- **Sessions are independent of CC Hub restarts**: sessions live inside the herdr
  server process, so restarting or updating cchub no longer kills them. The herdr
  server also restores workspaces and agent conversations through
  `resume_agents_on_restore`
- **CC Hub owns the split layout**: herdr's grid cannot be resized headlessly, so
  CC Hub owns the split tree (ratios and pane rectangles) and sizes each pane's
  PTY absolutely (`backend/src/services/herdr-layout.ts`)
- **Session identity uses herdr's native agent session id**: sessions are matched
  by the Claude session ID reported by `agent.list`, which removes the mix-ups
  that happened when several sessions shared a directory (it used to fall back to
  path matching)
- **`cchub setup` provisions herdr**: the systemd user unit / launchd plist,
  `~/.config/herdr/config.toml` (`resume_agents_on_restore` + `pane_history`) and
  `herdr integration install claude` are set up automatically (existing
  configuration is never overwritten)
- **herdr's version and protocol are checked at startup**: an unverified protocol
  logs a warning

### Added
- **The indicator's `waiting_input` is corrected from herdr's agent status**: a
  pane's `blocked` state is reflected even where no hook arrives, such as waiting
  on a permission prompt

### Removed
- **All tmux code**: `tmux-control.ts` / `tmux.ts` / `pane-viewport.ts` /
  `viewport-cursor-policy.ts` / `tmux-layout-parser.ts` / `tmux-octal-decoder.ts`
  and their tests
- **`cchub tui` (embed-tui)**: it used tmux directly as its rendering backend, so
  it went with the herdr migration (the whole `tui/` workspace was deleted)
- **Pane respawn and copy-mode**: herdr has no equivalent

### Fixed
- **Corruption from UTF-8 split across chunks**: the socket's NDJSON reader was
  unified into one streaming-safe implementation (emoji and Japanese no longer
  break at a packet boundary)
- **Dropped and reordered input**: everything goes through a single control
  stream's stdin per pane, which guarantees ordering. Sending with no control
  stream returns an error rather than reporting success
- **Multi-line prompts to the Claude / Codex TUI**: sent as a bracketed paste,
  with the submitting `\r` delayed 80ms into a separate chunk (in the same chunk
  the TUI swallows the newline)
- **A blank screen after resuming from history required a reload**: switching
  sessions discarded the viewport delivery registrations wholesale. Also fixed a
  zombie control session surviving a workspace deletion and breaking the resume
  of a session with the same name
- **"No conversation found" on resume**: the working directory degrades to `~`
  after Claude exits, so the cwd recorded in the conversation log (`.jsonl`) is
  preferred when restoring
- **Scrolling blocked by alt-screen detection**: the shell's echo line right
  after a resume was misread as alt-screen; the heuristic is looser and
  self-corrects as the scrollback grows
- **Pane drag-resize snapping back / splits fighting**: absolute sizes and
  duplicate leaves are handled in the layout tree
- **Read-only REST taking over a pane**: `cchub peek` and viewport snapshots are
  pure RPC, and a control stream starts only on a WebSocket subscribe or on input
  (lazy controllers)
- **The metadata store is separate from the tmux version's**: split into
  `herdr-session-metadata.json` / `herdr-last-known-sessions.json` so it does not
  collide with the tmux version sharing `~/.cc-hub`

### Notes
- **Migration**: install herdr with `curl -fsSL https://herdr.dev/install.sh | sh`
  (or `brew install herdr`), then re-run `cchub setup` on each machine after
  `cchub update`. Existing tmux sessions do not carry over, so reach a stopping
  point first
- **Known limitation**: scrollback is capped by herdr's 1000-line `pane.read`
  limit (awaiting offset support upstream)
- **Updating herdr**: `herdr update` (which only replaces the binary) followed by
  `systemctl --user restart herdr`. Do not use `--handoff` under
  systemd/launchd (it hands over to a new server outside the supervisor)

## [0.1.192] - 2026-07-14

### Fixed
- **`cchub tui` (the binary) exited immediately after starting**: embed-tui's
  `main()` returned as soon as setup finished, so through the CLI path
  (`await runTui()` -> `process.exit`) the whole process ended at once (since
  v0.1.189). It never surfaced under `bun run dev:tui`, where the event loop
  stays alive. `main()` now waits until it ends (`q` / Ctrl-C -> cleanup)
  (`tui/src/embed/embed-tui.ts`)

## [0.1.191] - 2026-07-13

### Added
- **Split panes in `cchub tui`**: every pane of the selected session is composed
  onto one screen following the tmux layout (with vertical and horizontal
  rules). Clicking moves pane focus, the wheel is routed to the pane under the
  mouse, and **a right-click menu in the terminal area offers split vertically /
  split horizontally / close pane** (a split inherits the original pane's cwd,
  and the last pane cannot be closed) (`tui/src/embed/embed-tui.ts`)
- **A dashboard panel in `cchub tui`**: the sidebar's `dash` button or the `D`
  key overlays Claude/Codex usage bars (5h/7d with status colors), today's
  activity, system metrics and disk. The data comes from the server's
  `/api/dashboard` through the same path statusline.sh uses (self-signed HTTPS
  allowed, logging in with the `cchub` password from the Keychain for a Bearer
  token) and refreshes every five seconds while shown. With no server it
  degrades to an error message (`tui/src/embed/dashboard.ts`)

### Changed
- **`cchub tui`'s rendering engine became a resident tmux control-mode client**:
  instead of forking `tmux` every frame (5-20ms per call on macOS), commands are
  piped into a resident `tmux -C attach` (sub-millisecond). Event-driven redraws
  using `%output` as the dirty signal, a per-line diff cache, a roughly 30fps
  rate limit and Synchronized Output (DEC 2026) removed the sluggishness and
  flicker while scrolling or streaming (`tui/src/embed/tmux-ctl.ts`,
  `tui/src/embed/embed-tui.ts`)
- **Void filling on the normal screen (padFill)**: for non-alt-screen TUIs such
  as Claude Code, the blank space below the cursor row is trimmed and scrollback
  is prepended to fill the screen (the same approach as the web UI's
  PaneViewport)

### Fixed
- **Horizontal trackpad scrolling opened the pane menu by mistake**: SGR wheel
  events (buttons 64-67) are excluded from click detection (`66 & 3 === 2`
  matched a right click). Also fixed a hole where a wheel event with the menu
  open counted as a click
- **Cursor flicker while drawing**: cursor visibility (DECTCEM) is toggled only
  on a state transition, and the cursor position is restored to the pane after
  the sidebar's periodic refresh
- **Width of rules and block characters**: they were treated as full-width (2)
  and are width 1, which fixes the misaligned right-hand rules in menus and bars

## [0.1.190] - 2026-07-10

### Added
- **A detail panel for the selected session in `cchub tui` (embed-tui)**:
  following the web version, the bottom of the sidebar shows the selected
  session's **recap / branch / tokens / ctx%**. The server writes them from
  `buildSessionsList` into the `@cchub_recap` / `@cchub_branch` / `@cchub_tokens`
  / `@cchub_ctx` tmux user options (the same dedupe / fire-and-forget approach as
  `@cchub_state`), and embed-tui reads them straight from tmux with
  `list-sessions -F` (no HTTP, and it degrades to hiding them when the server is
  not running) (`backend/src/services/tmux.ts`, `backend/src/routes/sessions.ts`,
  `tui/src/embed/embed-tui.ts`)
- **Clickable action buttons in the sidebar**: `[ + New ]` and `[ History ]` on
  the second row open the create file manager and the history panel by mouse (the
  `n` / `H` keys still work)

## [0.1.189] - 2026-07-10

### Changed
- **`cchub tui` moved wholesale to a custom fullscreen TUI (embed-tui)**: the
  previous `cchub tui` - built on Ink, a client of the server API, handing off to
  `tmux attach` - was replaced by embed-tui, which **uses tmux only as a backend
  (PTY and terminal rendering) and draws the entire UI itself**. A left sidebar
  and the selected session's real terminal (`capture-pane`) are drawn on one
  screen, with input forwarded through `send-keys`. It does not go through the
  server API, so it works with the CC Hub server down. It has mouse support
  (selection, focus, width dragging, closing a session from the right-click
  menu), a framed file manager for creating sessions, and **resume from history**
  (reading `~/.claude/projects` directly, then `claude -r`, on the `H` key)
  (`tui/src/embed/embed-tui.ts`, `tui/src/embed/history.ts`)

### Removed
- **The whole old Ink TUI**: `tui/src/index.ts`, `components/`, `hooks/`, `api/`,
  `sidebar/mouse-sidebar.ts`, `tmux/attach.ts,send.ts` and their tests, the tmux
  config's F10/F11/F12 and status button bindings, and the CLI's
  `cchub tui --popup` / `--sidebar`. The ink/react dependencies were dropped from
  tui as well

## [0.1.188] - 2026-07-10

### Added
- **An experimental custom fullscreen TUI (embed-tui)**: a new local TUI started
  with `bun run dev:tui-embed`. It uses tmux only as a backend (PTY and terminal
  rendering), draws the whole UI itself and talks to tmux directly rather than
  through the server API. It has a custom sidebar on the left and the selected
  session's real terminal on the right (`capture-pane -e -p` drawn into its own
  area), input forwarding (`send-keys -H`), a focus model (Enter for the
  terminal, Ctrl-B for the list), status dots (`@cchub_state`), custom titles
  (read straight from `~/.cc-hub/session-metadata.json`), sidebar width
  adjustment (`[` and `]` plus dragging the divider), a framed file manager UI
  for creating sessions (direct fs access, mouse-driven), a right-click context
  menu for closing a session, and scrolling (normal screen through the tmux
  history offset, alt-screen by forwarding the wheel, with momentum floods rate
  limited) (`tui/src/embed/embed-tui.ts`)
- **A dev harness that runs from source without a release**: the sidebar launch
  command can be replaced through `CCHUB_SIDEBAR_CMD`, and `scripts/dev-tui.sh`
  (`bun run dev:tui-live`) runs the TUI from source

### Changed
- **Removed references to another product's name from the code**: comments, CLI
  help and scripts use neutral wording (`backend/src/cli.ts`,
  `backend/src/services/tmux.ts`, `tui/src/tmux/attach.ts` and others)

## [0.1.187] - 2026-07-07

### Changed
- **The sidebar is clickable (Ink -> raw terminal)**: Ink has no mouse support,
  so the always-on sidebar's contents moved from React/Ink to raw terminal
  drawing. SGR mouse mode (`\x1b[?1006h`) is enabled directly, the mouse events
  tmux forwards are parsed, and **clicking a row switches to that session**
  (a herdr-like "click on the left, the right switches"). Keyboard control
  (up/down, j/k, Enter, q), the status dots and the 2.5-second live refresh all
  remain. The old Ink sidebar (`Sidebar.tsx`) was deleted
  (`tui/src/sidebar/mouse-sidebar.ts`)

## [0.1.186] - 2026-07-06

### Fixed
- **A react/react-dom version mismatch made the app impossible to start**: the
  lockfile had react@19.2.6 against react-dom@19.2.4 (since the tui scaffold
  right after v0.1.166), and reinstalling dependencies or triggering vite's dep
  re-optimization produced a white screen with "Incompatible React versions".
  Both are 19.2.7 now (`frontend/package.json`, `bun.lock`)
- **The frontend's `bun:test` types resolved only by accident through an import
  chain into the backend**: `@types/bun` was added to the frontend explicitly and
  `types: ["bun"]` set in its tsconfig (the same pattern as backend/tui)

### Changed
- **Dead code removed (a knip sweep)**: unused exports, functions, types, files
  and dependencies were deleted across every workspace (31 files, -525 lines).
  `ConversationMessage` / `ToolUseInfo` / `ToolResultInfo` / `ToolResultImage`,
  duplicated in `session-history.ts`, were consolidated into `shared/types.ts`.
  The unused `hono` and `sharp` dependencies were removed from the frontend, and
  about 20 symbols used only within their file were un-exported (#379)

## [0.1.185] - 2026-07-04

### Added
- **A herdr-like default layout (the left sidebar opens automatically on entry)**:
  entering a session through `cchub tui` opens a 34-column session-list sidebar
  on the left (the herdr-style "list on the left, work on the right"). It is
  drawn by a component built for narrow widths (one session per row:
  `> dot session-name`), it does not open a second one if a sidebar already
  exists, and focus stays in the work pane. Switching through the popup grows a
  sidebar in the destination too. `CCHUB_TUI_SIDEBAR=0` (or `off` / `false`)
  disables it (`tui/src/components/Sidebar.tsx`, `tui/src/tmux/attach.ts`,
  `tui/src/index.ts`)

### Changed
- **The always-on sidebar narrowed from 48 to 34 columns**: closer to herdr's
  slim sidebar, with a compact display built for it (one row per session rather
  than a card) (`tui/src/tmux/attach.ts`, the F10 binding in
  `backend/src/services/tmux.ts`)

## [0.1.184] - 2026-07-03

### Fixed
- **The mouse stopped working entirely in terminal clients**: the web UI (tmux
  -CC control mode) runs `set-option -t <session> mouse off` on connect to avoid
  triggering copy-mode, and that override stayed on the session after the web
  client disconnected, killing the mouse (click selection, boundary dragging, the
  wheel) for local terminal clients attached to the same tmux session.
  `TmuxControlSession.destroy()` clears the override with `set-option -u` so it
  falls back to the global `mouse on` (`backend/src/services/tmux-control.ts`)

## [0.1.183] - 2026-07-03

### Added
- **herdr-style agent status dots in the tmux status bar**: for a session entered
  through cchub, the agent's state appears as a colored dot in the status bar
  (working / waiting for input / done / idle). The session list processing pushes
  the hook-based state into the `@cchub_state` tmux user option only when it
  changes (dedupe, fire and forget), and `attachStatusRight`'s `#{@cchub_state}`
  draws it (`backend/src/services/tmux.ts`, `backend/src/routes/sessions.ts`,
  `tui/src/tmux/attach.ts`)
- **An always-on session sidebar (`cchub tui --sidebar` / no-prefix F10)**: a
  48-column live session list lives as a pane on the left edge. Pressing Enter
  runs `switch-client` without closing the sidebar and grows one in the
  destination session too, which gives the herdr-like feeling that "the list is
  on the left wherever you go". The sidebar marks its own pane with
  `@cchub_sidebar=1` to avoid being created twice, and `q` closes it
  (`tui/src/index.ts`, `tui/src/tmux/attach.ts`, `backend/src/cli.ts`)

### Changed
- **`cchub tui`'s help is grouped, with a legend for the status dots**: the flat
  key list is grouped into navigation / session actions / while attached /
  history and other, with the dot legend alongside. The App's footer hint also
  varies by situation (normal / exit confirmation / help)
  (`tui/src/components/Help.tsx`, `tui/src/components/App.tsx`)

## [0.1.182] - 2026-07-02

### Added
- **Hand scrolling over to a TUI on the alternate screen**: Claude Code (v2.1.172+)
  and Codex draw their TUI on the terminal's alternate screen, which has no tmux
  scrollback, so cchub's "scroll up to walk the tmux history" produced nothing at
  all. On an alt-screen pane (detected through `modes.altScreen` on each viewport
  frame), instead of intercepting the scroll to walk the tmux scrollback, **SGR
  mouse wheel events (button 64 up / 65 down) are sent to the pane** so the app
  scrolls its own transcript. Wheel, touch and momentum all funnel through
  `flushPendingScroll`, so the branch lives there, with a per-flush cap guarding
  against a touch-momentum flood. Returning to live by tapping has no tmux offset
  to use, so it sends Ctrl+End to jump the app's transcript to the bottom. A
  normal-screen pane keeps the existing tmux-scrollback behavior (#373,
  `frontend/src/components/Terminal.tsx`)

## [0.1.181] - 2026-06-21

### Fixed
- **The Claude TUI's cursor drifted off the input line**: recent Claude Code
  leaves a blank line under the mode-hint footer, so the number of lines
  `padFill` prepends (filling the void at the bottom of a pane with scrollback)
  is now always at least one. The cursor correction `computeCursorPadShift`
  subtracted 2 from the prepend count (`prependCount - 2`), which floated the
  cursor up to two rows above the input box, onto a blank line or the frame. It
  now shifts down by exactly the number of prepended lines
  (`Math.max(0, prependCount)`) (#371,
  `backend/src/services/viewport-cursor-policy.ts`)

## [0.1.180] - 2026-06-20

### Fixed
- **New files did not appear in an expanded directory in the file browser**: the
  file browser cached each expanded directory's contents in a `dirContents` Map
  and never invalidated it, and the reload button only refetched the root level
  through `listDirectory`, so a file or directory created inside an expanded
  folder (or at the root after the first load) never appeared. `FileBrowser`
  gained a `refreshSignal` prop: bumping it refetches every expanded directory in
  the background, and re-expanding shows the cache while refetching behind it.
  The reload button bumps `refreshSignal` in addition to refetching the root, so
  the whole tree updates at once (#369,
  `frontend/src/components/files/FileBrowser.tsx`,
  `frontend/src/components/files/FileViewer.tsx`)

## [0.1.179] - 2026-06-11

### Changed
- **The Model Usage panel is limited to the last 30 days**: it used to show
  `stats-cache.json`'s undated totals, which could only ever be all-time. It
  aggregates `~/.claude/projects/*/*.jsonl` transcripts directly now, filtering
  by `timestamp` to the last 30 days for per-model tokens. Files whose mtime
  predates the cutoff are skipped and the result is cached with a 5-minute TTL.
  The heading became "Model Usage (last 30 days)" (#367,
  `backend/src/services/stats-service.ts`,
  `frontend/src/components/dashboard/ModelUsageChart.tsx`)
  - Note: numbers aggregated straight from jsonl do not match Claude Code's own
    totals exactly (they do not reproduce its deduplication), but the relative
    breakdown within the period is accurate

## [0.1.178] - 2026-06-11

A batch of fixes for problems found in a full review (issues #346-#355).

### Security
- **Arbitrary file read through /api/notify**: the unauthenticated
  `POST /api/notify` used the request body's `transcript_path` for an unvalidated
  file read (whose contents were then broadcast in fragments to every client).
  Symlinks are resolved with `realpath` and only paths under `~/.claude` /
  `~/.codex` are allowed (#347, `backend/src/routes/notify.ts`)
- **A missing check on /files/changes**: `GET /files/changes/:sessionWorkingDir`
  alone lacked the `isAllowedSessionDir` guard. It has the same 403 guard as the
  other file endpoints now (#349, `backend/src/routes/files.ts`)
- **Timing-attack hardening on authentication comparisons**: JWT signature
  verification (`verifyToken`) and the server password comparison use a SHA-256
  digest plus `crypto.timingSafeEqual` for a constant-time comparison (#353,
  `backend/src/services/auth.ts`, `backend/src/routes/auth.ts`)

### Fixed
- **A leak when the WS disconnected mid-subscribe**: if the WS closed while
  `handleSubscribe` / `handleSubscribeConversation` were awaiting, the
  `TmuxControlSession`'s client count was over-counted (leaving the tmux -CC
  process resident) and `ConversationWatcher` leaked an FSWatcher. The
  disconnection is detected after the await completes and rolled back (#346,
  `backend/src/routes/terminal-mux.ts`)
- **False pane-dead notifications**: `%window-renamed [dead]` notified every known
  pane as dead, so in a multi-pane setup live siblings and panes in other windows
  were shown as dead. Panes are tracked per window now: a single pane notifies
  synchronously, and with several panes `list-panes` identifies the ones that
  actually died (#348, `backend/src/services/tmux-control.ts`)
- **`cchub notify -p` failed to deliver**: with an explicit port the dev port
  became `https:false`, so it never reached a server listening over HTTPS and
  failed silently. It always sends over https now (#350,
  `backend/src/commands/notify.ts`)
- **`cchub send` corrupted its payload**: combining `--base64` with `--submit` /
  `--newline` mixed VT escapes into the base64 string and broke decoding. The
  combination is rejected before execution (#351,
  `backend/src/commands/send.ts`)
- **Pointless disk I/O in the usage fetch**: with no credentials the cache did
  not hold and the credentials file was re-read on every dashboard poll. Added a
  no-credentials cooldown (60s) (#352,
  `backend/src/services/anthropic-usage.ts`)
- **Missing listener/timer cleanup in the frontend**: App.tsx re-registering its
  resize listener on every render, duplicate `subscribe-conversation` messages
  and uncleared timers in InputBar / Terminal, fixed together (#354,
  `frontend/src/App.tsx` and others)
- **usage-history discarded the legacy format**: contrary to its comment,
  `getHistory` threw away the legacy `{snapshots:[...]}` shape as `[]`. It reads
  `parsed.snapshots` now (#355, `backend/src/services/usage-history.ts`)

## [0.1.177] - 2026-06-10

A security and stability release (issues #331-#337 together).

### Security
- **Arbitrary path access through git-changes / git-diff**:
  `GET /api/files/git-changes/:workingDir` and `git-diff/:workingDir` passed a
  client-supplied path to `git -C` unvalidated, exposing the status and diff of
  any git repository on the host. They have the same `isAllowedSessionDir` guard
  as `/files/list` and `/files/read`, and git-diff's untracked fallback read
  gained `../` escape prevention (#337, `backend/src/routes/files.ts`)

### Fixed
- **A zombie control-session registration made reconnection impossible**:
  `getOrCreateControlSession` registered before calling `start()`, so a failed
  spawn left a broken entry and that session could not recover until a restart.
  A failure rolls back through `destroy()` now (#331,
  `backend/src/services/tmux-control.ts`)
- **A tmux -CC process leak when a mux subscribe failed**: an exception in
  `handleSubscribe` did not roll `addClient()` back, and the over-counted clients
  meant the grace period never started. The catch now removes the listener,
  deletes the subscription and calls `removeClient()` (#332,
  `backend/src/routes/terminal-mux.ts`)
- **Lost updates and data loss in session metadata**: persisting the theme, title
  and display order used a non-atomic overwrite with an unserialized
  read-modify-write, so a concurrent update could be lost and a crash mid-write
  could destroy all the metadata. peer-registry's pattern was generalized into
  `utils/storage.ts` (`atomicWriteFile` + `createMutationLock`) and applied
  (#333, `backend/src/services/session-metadata.ts`, `sessions.ts`)
- **An fs.watch leak in ConversationWatcher**: re-entering `start()` overwrote
  the old watcher without closing it, leaking it and potentially delivering the
  wrong file's conversation. `start()` closes the old watcher first (#334,
  `backend/src/services/conversation-watcher.ts`)
- **History search ignored its limit and read everything into memory**:
  `searchSessions`'s early exit did not work inside `Promise.all`, so one search
  started a scan of every JSONL at once. It delegates to the serial
  `searchSessionsStream` now, and `searchInSessionFile` scans line by line
  through readline (#335, `backend/src/services/session-history.ts`)
- **usePeers multiplied its 5-second polling**: a `setInterval` was created per
  hook instance, so `/api/peers` was polled N times over for N consuming
  components. Changed to a single module-level timer (reference counted) with
  in-flight coalescing, which also fixed a setState after unmount (#336,
  `frontend/src/hooks/usePeers.ts`)

## [0.1.176] - 2026-06-10

Improved the dashboard's Model Usage display and deleted unused cost estimation
code.

### Fixed
- **Raw model IDs appeared in Model Usage**: display-name formatting was
  hardcoded for opus/sonnet, so `claude-haiku-4-5-20251001` and friends wrapped
  as raw IDs. Generalized to any family ("Haiku 4.5", "Fable 5" and so on;
  `backend/src/services/stats-service.ts`)
- **The file-service test failed on macOS**: the `/var` -> `/private/var` symlink
  made `validatePath`'s realpath output differ from the expectation. The test's
  `testDir` is resolved through `realpath` (`backend/tests/unit/file-service.test.ts`)

### Changed
- **Model Usage chart improvements**: sorted by usage descending, a wrapping
  legend, a per-family color palette assigned cyclically (so a new model needs no
  code change), and legend numbers on the same basis as the bars (in + out +
  cache read) with a percentage added
  (`frontend/src/components/dashboard/ModelUsageChart.tsx`)
- **Dead code removed**: the unused `PRICING` table, `getCostEstimates()`, the
  `CostEstimate` type, `DashboardResponse.costEstimates` and the i18n
  `costEstimate` label. Real cost calculation is handled by `AnthropicModels` +
  `SessionMetricsService`

## [0.1.175] - 2026-06-09

Fixed Shift+Tab on the soft keyboard.

### Fixed
- **Shift+Tab did nothing on the soft keyboard**: the `TAB` key lives in the
  action bar and sends `onSend("\t")` directly through `ActionButton`, so it
  ignored the shift modifier and always sent a bare `\t` (hex `09`). The
  Shift+Tab -> VT back-tab (CSI Z, `\x1b[Z`) handling in `sendKeyPress` could
  never be reached and was dead code. `ActionButton` sends CSI Z for shift+TAB
  now (so Claude Code's auto-mode / plan-mode / accept-edits cycle works), and
  the label shows the shifted form while shift is held
  (`frontend/src/components/Keyboard.tsx`)

## [0.1.174] - 2026-06-07

Two pane-operation fixes in the session list.

### Fixed
- **Panes were unreachable with two panes**: tapping a multi-pane remote-control
  session (one with a `bridgeSessionId`) in the session list expanded only the
  jump menu, putting the pane list beneath it (focus / close / split per pane)
  out of reach. Both are expanded now (a regression from `41637d3`;
  `frontend/src/components/SessionList.tsx`)
- **A pane could not be closed in a multi-window session**: the "never close the
  last pane" check counted only the current window's panes through
  `tmux list-panes -t <id>`, so a session made of several windows (one pane each)
  was wrongly counted as 1 and close was rejected with a 400. It counts the whole
  session's panes with `-s` now (`backend/src/routes/sessions.ts`)

## [0.1.173] - 2026-06-06

Added a popup sidebar to `cchub tui`, so the session list can be summoned
instantly even while attached.

### Added
- **TUI: popup mode (`cchub tui --popup`)**: a one-shot mode invoked from tmux
  `display-popup`. Enter runs `tmux switch-client` and exits, so the popup closes
  itself (`tui/src/index.ts`, `tui/src/tmux/attach.ts`)
- **A tmux F11 binding (no prefix)**: shows the session list as a popup sidebar,
  50 columns wide and full height. It ships in `CCHUB_TMUX_CONFIG` and is sourced
  automatically when the server starts (`backend/src/services/tmux.ts`)
- **A tmux F12 binding (no prefix)**: detach-client (returning to the cchub TUI
  list) was added to `CCHUB_TMUX_CONFIG` too. It used to be set per attach
  through `preAttachCommands`; now it is always on at the server level
- **A clickable status-bar button**: while attached through the cchub TUI,
  status-right shows a clickable `#[range=user|sessions,reverse] cchub` button
  that opens the same popup as F11. A `MouseDown1Status` `if-shell` filter keeps
  other status clicks unaffected (`attachStatusRight` in
  `tui/src/tmux/attach.ts`, `backend/src/services/tmux.ts`)

### Notes
- The popup binding calls the `cchub` binary through PATH, so F11 and the click
  button only become available automatically on hosts that applied this release
  with `cchub update`
- The existing F12 behavior (back to the list) is unchanged

## [0.1.172] - 2026-06-06

Better tap targets in the mobile file viewer footer, plus an architecture
documentation update.

### Fixed
- **Mobile: the file viewer footer's buttons were small and awkward**: row 1's
  icon buttons (back / upload / hidden files / download / close) were enlarged to
  match the session bar below (`p-1.5` -> `p-2.5`, icons 16px -> 20px), and the
  tabs and Source/Preview became `text-sm`. To keep the width in check the title
  was narrowed from 120px to 84px, with no overflow confirmed on a device
  (`frontend/src/components/files/FileViewer.tsx`)

### Changed
- **architecture: reflect the file viewer de-monolithing (#311-#314)**: added the
  new `FileContentView` / `ChangesView` components and the `useViewerSettings` /
  `usePinchZoom` / `useScrollRatio` / `useViewHistory` hooks, and updated the
  descriptions and parent-child relationships of FileViewer / CodeViewer /
  DiffViewer / MarkdownViewer (`architecture.json`, `architecture.html`)

## [0.1.171] - 2026-06-05

File viewer work (phases 1-4): de-monolithing and de-duplication through shared
code, plus peer support for Markdown images, a binary display guard and i18n
wiring.

### Changed
- **File viewer: extracted shared viewer hooks and utilities (#311)**: the
  word-wrap and font-size settings, pinch zoom, scroll position restoration and
  syntax highlighting copy-pasted across CodeViewer/DiffViewer/MarkdownViewer are
  now shared (`useViewerSettings` / `usePinchZoom` / `useScrollRatio` /
  `utils/highlight`). As a side effect they became consistent: DiffViewer gained
  font size and pinch, and the word-wrap default is the same in all three
  (`frontend/src/hooks/`, `frontend/src/utils/highlight.ts`,
  `frontend/src/components/files/`)
- **File viewer: FileViewer.tsx de-monolithed (#312)**: the 1681-line monolith
  was broken up and the duplicated wide/mobile JSX removed. The rendering switch
  was collected into `FileContentView`, `ChangesView` / `useViewHistory` /
  `file-types` were separated out, and `FileViewer.tsx` shrank to orchestrating
  layout and state (`frontend/src/components/files/`,
  `frontend/src/hooks/useViewHistory.ts`)
- **File viewer: hardcoded strings wired to i18n keys (#314)**: scattered
  Japanese/English UI strings all go through `t()` and the missing keys were
  added to ja/en. `useTranslation` was added to FileBrowser / CodeViewer /
  DiffViewer / MarkdownViewer / ImageViewer / PromptComposer
  (`frontend/src/components/files/`, `frontend/src/i18n/locales/`)

### Fixed
- **File viewer: images inside Markdown did not show for a remote peer (#313)**:
  `MarkdownViewer.resolveImageSrc` hardcoded `/api/files/raw` and produced
  404/401 on a peer session, so `filesApiBase` (`/api/peers/<id>/files`) is
  passed in and used to resolve them
  (`frontend/src/components/files/MarkdownViewer.tsx`, `FileContentView.tsx`)
- **File viewer: prevented base64 dumps of non-image binaries (#313)**: PDFs,
  zips and the like flowed into CodeViewer as base64; they are replaced by a "no
  preview" placeholder with a download link
  (`frontend/src/components/files/FileContentView.tsx`)

## [0.1.170] - 2026-06-05

Fixed trackpad scrolling turning into input-history navigation after attaching
with `cchub tui`.

### Fixed
- **`cchub tui`: trackpad scrolling after attach became Claude Code's input
  history navigation**: the web UI (`tmux -CC`) sets `mouse off` per session when
  it attaches, so a later `tmux attach` from `cchub tui` finds the session still
  in mouse off. On the alternate screen the host terminal (iTerm, Terminal.app)
  converts the wheel into up/down keys, and Claude Code (Ink) picked those up as
  history navigation. `cchub tui` sets `set-option mouse on` before attaching and
  restores the original value after detaching, so while attached tmux routes the
  wheel to copy-mode scrolling and the host terminal stops converting wheel to
  arrows (`tui/src/tmux/attach.ts`)

## [0.1.169] - 2026-06-05

Mobile web UI: easier to hit icons in the session action bar.

### Fixed
- **Mobile: the session action bar (overlayBar) icons were hard to tap**: the tap
  area grew from about 40px to about 44px (iOS's recommended minimum) and the
  icon color brightened (zinc-500 -> zinc-300) for legibility. To keep the width
  in check the right-hand actions became `shrink-0` and the session name's
  maximum width went from 140px to 84px (`frontend/src/App.tsx`)

## [0.1.168] - 2026-06-04

`cchub tui` improvements: a card-based list, vertical scrolling, a one-key way
back and sending `/compact`.

### Added
- **`cchub tui`: the session list is card-based**: each session is drawn as a
  framed card showing its state, agent, context usage (ctx%), elapsed time,
  current task (paneTitle), working directory, pane count and token count (more
  information than before). The whole thing sits inside an outer frame with the
  shortcuts always visible in the footer (`tui/src/components/SessionCard.tsx`,
  `App.tsx`)
- **`cchub tui`: vertical scrolling (a window that follows the selection)**: it
  draws as many cards as fit the terminal height, and moving the selection to an
  edge with the arrow keys shifts the window so it actually scrolls (with the
  remaining counts shown above and below). It used to draw every card, so
  anything off screen was simply invisible (`tui/src/components/SessionList.tsx`)
- **`cchub tui`: `c` sends `/compact` to the selected session**: a session whose
  context has grown can be compacted from the list (bracketed paste plus Enter
  for a reliable submit) (`tui/src/tmux/send.ts`)

### Fixed
- **`cchub tui`: no way back to the list after entering a session**: without
  knowing tmux's detach (prefix+d) there was no way back, so a prefix-free return
  key was registered (F12 -> detach-client) and while attached the status bar
  always says F12 returns to the cchub list (the original status-right is
  restored afterwards). The list and the help mention F12 too
  (`tui/src/tmux/attach.ts`)
- **`cchub tui`: the screen size did not follow the terminal on entry**: the
  entered session is set to `window-size latest` so it follows the size of the
  terminal that entered it

## [0.1.167] - 2026-06-04

Added `cchub tui`, a local-only terminal UI. It lists sessions on a running CC
Hub server, enters them and searches history from the terminal without opening a
browser.

### Added
- **Added the CC Hub TUI (`cchub tui`) (#306)**: a new `tui/` workspace (Ink +
  React on Bun). It runs as a **client with a running CC Hub server as its data
  source**, reusing the existing APIs (`/api/sessions`, history search,
  lifecycle). Entering a session does not send the terminal screen over the
  network; it hands off to a native `tmux attach` (and when nested inside
  `$TMUX`, TMUX is stripped from the child environment before attaching).
  Features: the session list (status indicators, agent, working directory, pane
  count), history search (streamed over SSE) -> resume -> enter, creating a
  session (agent plus working directory), closing one (with a y/n confirmation),
  resuming, and help (`?`). Local only (no other peers), TLS verification is
  skipped for HTTPS on localhost (a Tailscale certificate), and auth is
  zero-config (a local token is self-issued from the data dir's `jwt-secret`). A
  terminal without raw mode support (through a pipe or a wrapper) exits with a
  clear explanation. It is bundled into the single `cchub` binary through
  `bun build --compile` and lazily loaded only when `cchub tui` runs, so the
  server path is unaffected. Designed through Spec Kit (spec -> plan -> tasks ->
  analyze) before implementation (`specs/002-cchub-tui/`, `tui/README.md`). 56
  tui and 258 backend tests, 82.56% line coverage (`tui/`,
  `backend/src/cli.ts`, `backend/src/commands/tui.ts`, `scripts/build.sh`)

### Changed
- **Spec Kit updated to v0.8.19 and the constitution revised to v1.6.0 (#305)**:
  spec-kit moved from the version used at init to the latest (the
  `.claude/commands/speckit.*` dotted form became `.claude/skills/speckit-*`
  hyphenated skills). The constitution's principle III, "Web-First
  Architecture", was revised to conditionally allow local, non-web interfaces
  (TUI/CLI) that complement rather than replace the web (`.specify/`,
  `.claude/skills/`, `.specify/memory/constitution.md`)

## [0.1.166] - 2026-05-31

Fixed "Open in the Claude app", added in v0.1.165, not appearing or not opening
on mobile.

### Fixed
- **"Open in the Claude app" did not work on mobile (#303)**: mobile uses a
  different layout from desktop/tablet (`App.tsx`'s overlayBar / `openSessions`),
  and `bridgeSessionId` was never passed into it and no button existed there
  (v0.1.165 only covered the `DesktopLayout` + `PaneContainer` path). On top of
  that, the windowFeatures string in
  `window.open(url, "_blank", "noopener,noreferrer")` made mobile Safari treat it
  as a popup and block it. `bridgeSessionId` was added to `App.tsx`'s
  `OpenSession` type, `apiToOpenSession` and the mobile live-update merge, and an
  "Open in the Claude app" icon button was added to the mobile terminal toolbar
  (overlayBar). A shared `openClaudeAppSession()` utility standardizes on
  `window.open(url, "_blank")` (no features string) plus `opener=null`, replacing
  the inline implementations in `SessionList` / `PaneContainer`. Verified on a
  device (a 390x844 mobile viewport) that both the toolbar and the list's tap
  menu open the right URL (`frontend/src/App.tsx`,
  `frontend/src/utils/claude-app.ts`, `frontend/src/components/SessionList.tsx`,
  `frontend/src/components/PaneContainer.tsx`)

## [0.1.165] - 2026-05-31

Added a way to jump from a Remote Control session to the matching cloud session
in the Claude app.

### Added
- **"Open in the Claude app" (#301)**: for a session with Remote Control
  enabled, the matching cloud session (`https://claude.ai/code/<bridgeSessionId>`)
  can be opened in the Claude app or a browser. The backend reads
  `~/.claude/sessions/<pid>.json` to map Claude Code's `sessionId` (the .jsonl
  UUID) to its `bridgeSessionId` (`session_...`) and attaches `bridgeSessionId`
  to each session in `buildSessionsList()` (on an exact `sessionId` match only; a
  cwd fallback was rejected to avoid mismatching). Sessions without Remote
  Control active do not get one. Two places in the UI: (1) **tapping** a session
  with a bridge in the session list shows a **menu** offering "go to this
  terminal" or "open in the Claude app" (without a bridge it goes straight there
  as before), and (2) an "open in the Claude app" icon button in the
  **terminal's pane header** (only for an active session with a bridge, on both
  desktop and tablet). The URL goes through `encodeURIComponent`. Added
  `ExtendedSessionResponse.bridgeSessionId?` and the
  `session.openInClaudeApp` / `session.goToTerminal` i18n keys (en/ja)
  (`backend/src/services/claude-code.ts`, `backend/src/routes/sessions.ts`,
  `shared/types.ts`, `frontend/src/components/SessionList.tsx`,
  `frontend/src/components/PaneContainer.tsx`,
  `frontend/src/components/DesktopLayout.tsx`)
  - Known limitation: Claude Code has no native app deep link yet (issue
    #48220), so on mobile a tap currently opens claude.ai/code in the system
    browser. If a `claude://` scheme arrives, only the URL needs changing

## [0.1.164] - 2026-05-31

The session history UI was rebuilt. The old UI, which walked a project
hierarchy, became a flat virtualized list across every project with a facet
filter sidebar. It fixes "hard to survey, hard to search" and shows each
session's latest recap preview. History loading also went from over 10 seconds
to about 0.8. Every PR was adversarially reviewed and verified in dev on a real
browser (agent-browser).

### Added
- **V2 history view: a virtualized flat list plus a facet sidebar (#290-#296,
  #298)**: the old click-through hierarchy is gone and every project's sessions
  are merged into a single list sorted by `modified` descending. It is
  virtualized with `@tanstack/react-virtual`, with date bucket headers (today /
  yesterday / this week / earlier) inserted inline. The left sidebar (a bottom
  drawer at narrow widths) offers facet filtering by project / agent / branch /
  period (OR within an axis, AND across axes, with counts), plus selection chips
  and a clear button. Incremental search is supported (the existing SSE search,
  debounced 150ms). Gated on localStorage through `useHistoryV2Flag`, on by
  default (opt out with `"false"` in `cchub-history-v2`). The responsive switch at
  `SIDEBAR_MIN_WIDTH=760` uses a callback ref so it survives the loading early
  return (`frontend/src/components/history/SessionHistoryV2.tsx`,
  `HistoryFacetSidebar.tsx`, `HistoryFacetDrawer.tsx`, `HistoryActiveChips.tsx`,
  `VirtualizedHistoryList.tsx`, `HistoryRowV2.tsx`,
  `frontend/src/utils/historyBuckets.ts`, `historyFacets.ts`,
  `frontend/src/hooks/useFlatHistoryItems.ts`, `useHistoryActions.ts`,
  `useHistoryV2Flag.ts`)
- **A latest-recap preview per session (#291, #292)**: the tail of the `.jsonl`
  is read with `readLastLines` and the most recent recap extracted by the pure
  function `parseRecapFromLines` (truncated to 300 characters, with pending reset
  on `away_summary`). `HistorySession` gained `lastPrompt` / `recap` / `recapAt`
  and `PeerHistoryProject` gained `cwdKey`. The V1 list also gained the amber
  recap line, and the displayed prompt prefers "the last prompt entered"
  (`lastPrompt`) with the old `firstPrompt` as a fallback (`shared/types.ts`,
  `backend/src/utils/read-last-lines.ts`, `backend/src/utils/recap-scanner.ts`,
  `backend/src/services/session-history.ts`,
  `backend/src/services/codex-history.ts`,
  `frontend/src/components/SessionHistory.tsx`)

### Fixed
- **History loading hung for over 10 seconds on an offline peer (#299)**: the
  peer fan-out in `/api/peers/history/projects` waited out an offline peer's
  5-second timeout inside `Promise.all`, so the whole history tab took more than
  ten seconds to load. `peerRecentlyFailed` (a 60-second cooldown) skips recently
  failed peers, and `peerFetch` accepts a short `timeoutMs` (2.5s). Measured:
  over 10 seconds to about 783ms (`backend/src/routes/peers.ts`,
  `backend/src/services/peer-auth.ts`)
- **The V2 list showed a time that disagreed with its sort (#296)**: the list
  sorts by `modified` descending while each row displayed `recapAt`, so a session
  with an old recap (six days apart in practice) contradicted the ordering. Rows
  display `session.modified` now
  (`frontend/src/components/history/HistoryRowV2.tsx`)

### Changed
- **`getProjectSessions`'s N+1 I/O runs in parallel (#291)**: the sequential
  per-session `.jsonl` reads became a `Promise.all`, and the `tail` subprocess
  was replaced by `readLastLines(500)`. Search results arrive in SSE order, so
  they are explicitly sorted by `modified` descending before bucketing to avoid
  duplicated bucket headers and key collisions
  (`backend/src/services/session-history.ts`,
  `frontend/src/components/history/SessionHistoryV2.tsx`)

## [0.1.163] - 2026-05-30

Two display bugs in the dashboard's usage-limit graph.

### Fixed
- **The usage graph appeared to decrease midway and started from the middle of
  the cycle (#288)**: the 7-day line was drawn descending (`18 -> 7 -> 8 -> ...`)
  and nothing was drawn in the left half. The Anthropic API returns the new
  `resetsAt` even for snapshots from the previous cycle across a reset boundary,
  so matching on `resetsAt` cannot exclude the old cycle and the drop pattern in
  utilization is the only signal. A pure function `filterToCurrentCycle()` was
  added to `shared/usage-cycle.ts` (it finds the last drop greater than
  `CYCLE_DROP_TOLERANCE=2` in chronological order and returns everything after
  it), and `UsageChart` filters through it and prepends a `(cycleStart, 0%)`
  anchor when the first sample is more than 2% into the cycle. No monotonic
  envelope - the raw data is drawn correctly. Ten unit test cases added
  (`shared/usage-cycle.ts`, `frontend/src/components/dashboard/UsageChart.tsx`)
- **The "now" and "reset" labels overlapped on the usage graph (#287)**: within
  28px of the chart's right edge the labels collided and became unreadable.
  Inside that threshold they merge into a single "now / reset" label, and near
  either edge the textAnchor switches to start/end dynamically
  (`frontend/src/components/dashboard/UsageChart.tsx`)

## [0.1.162] - 2026-05-30

17 confirmed medium findings from a multi-agent review of the whole codebase,
fixed across 14 PRs: 2 security, 2 auth bypass, 2 peer routing, 2 silent message
loss, 2 concurrency/race, 3 resource leak, 4 correctness. The four principal
findings (#259/#260/#261/#263) were verified in a real browser through
agent-browser; the rest through unit tests, lint and typecheck.

### Security
- **Removed `allow-same-origin` from the HTML preview iframe's sandbox (#261)**:
  `<iframe sandbox="allow-scripts allow-same-origin">` against a same-origin
  blob: URL is the combination MDN forbids, and arbitrary previewed HTML could
  steal the JWT with `window.parent.localStorage.getItem('cc-hub-token')`. It is
  `sandbox="allow-scripts"` only now, forcing a unique opaque origin
  (`frontend/src/components/files/HtmlViewer.tsx`)
- **Integrity verification in `cchub update` (#255)**: the old implementation
  fetched the release asset and renamed it, checking neither checksum nor
  signature nor magic bytes. The release workflow generates `SHA256SUMS`, and
  `cchub update` requires the file and verifies the ELF/Mach-O magic, the
  Content-Length and the SHA-256 so it can abort right before `rename()`. Eleven
  cases in `backend/src/commands/__tests__/update-integrity.test.ts`
  (`backend/src/commands/update.ts`, `.github/workflows/release.yml`)

### Fixed
- **FileViewer's upload/download/raw failed silently with 401 under password auth
  (#259, #260)**: `handleUploadFiles` called `fetch` directly, and `<a href>` /
  `<img>` / `<video>` / `<audio>` opened `/api/files/raw|download` with no Bearer
  header. A new `useAuthBlobUrl` hook fetches a raw URL through authFetch into a
  blob URL injected as the src, downloads go authFetch -> Blob ->
  `URL.createObjectURL` -> anchor click -> revoke, and uploads use authFetch
  (`frontend/src/hooks/useAuthBlobUrl.ts`,
  `frontend/src/components/files/FileViewer.tsx`)
- **The respawnPane REST fallback after a WS reconnect, SessionList's pane
  actions and the confirmation dialog ignored peer routing (#256, #258)**: all of
  them always hit the hub origin with no auth header, producing a 401 under
  password auth or hitting the wrong session id on another machine for a peer
  session. `useMultiplexedTerminal` gained `peerApiBase` and routes the fallback
  through authFetch or the peer URL plus token, and
  `SessionList.handlePaneAction` and the confirmation dialog go through
  `sessionFetch` (`frontend/src/hooks/useMultiplexedTerminal.ts`,
  `frontend/src/components/SessionList.tsx`,
  `frontend/src/components/DesktopLayout.tsx`,
  `frontend/src/pages/TerminalPage.tsx`)
- **ChatComposer / FloatingKeyboard lost a message when sending failed (#263,
  #264)**: `sendTerminalInput` / `onSend` return false while the WS is down, and
  the textarea was cleared regardless, so anything sent during a reconnect window
  vanished silently. The return value is captured and the field is cleared (and
  `addToHistory` called) only on success. Verified in a real browser by patching
  `WebSocket.prototype.readyState=CLOSED` through agent-browser
  (`frontend/src/components/chat/ChatComposer.tsx`,
  `frontend/src/components/FloatingKeyboard.tsx`)
- **A subscribe became a no-op after the glasses' WS reconnected (#265)**:
  `onclose` did not clear `subscribedSession`, so the `subscribe(sessionId)`
  after reconnecting hit the dedup guard and the viewport stopped. `onclose`
  resets it to `null` (`glasses/src/ws-client.ts`)
- **A cancellation race in `useCodexConversation` (#257)**: the shared
  `cancelledRef` was reset to false by the next effect run, so a late response
  from thread A overwrote thread B's messages. Replaced by a per-effect
  `let cancelled = false` (`frontend/src/hooks/useCodexConversation.ts`)
- **rAF and WebGL reload timer leaks in Terminal (#262)**: the three
  requestAnimationFrames (momentum scroll, touch coalescing, wheel flush) and the
  WebGL context-loss `setTimeout` were not cancelled on cleanup, so an old
  closure fired `scrollBy` / `setState` at a new terminal on a sessionTheme
  change or session switch. All of them are cancelled now
  (`frontend/src/components/Terminal.tsx`)
- **Three long-lived Maps in ClaudeCodeService grew without bound (#249)**:
  `sessionDataCache` / `pathResultCache` / `ttySessionCache` used their TTL only
  to decide reuse and never evicted. A static `evictAndCap` helper runs a TTL
  sweep plus a 1000-entry cap (FIFO) before every `cache.set`. Five test cases
  added (`backend/src/services/claude-code.ts`)
- **The `stateOverrides` Map grew without bound through the unauthenticated
  `/api/notify` (#254)**: an arbitrary `session_id` could create an entry that
  lived 24 hours, which makes a flood DoS possible. Format validation with
  `/^[A-Za-z0-9._-]{1,128}$/`, a 500-entry cap (FIFO) and a TTL sweep before
  insertion (`backend/src/routes/notify.ts`)
- **A concurrent-mutation TOCTOU on `peers.json` (#251)**: peer fetches fanned
  out with `Promise.all` completed into concurrent
  `recordPeerSuccess/Failure` load-mutate-save cycles that overwrote each other
  and lost `lastSeenAt` or a fresh wsToken. A module-level promise queue
  serializes every mutator, and saving uses a temp file plus an atomic rename.
  Two test cases added (`backend/src/services/peer-registry.ts`)
- **Claude project dir name generation broke on paths containing dots in
  `session-metrics` / `file-change-tracker` / `conversation-watcher` /
  `codex-history` (#252)**: four files each did `replace(/\//g, '-')` while
  Claude Code collapses both characters with `[/.]/g`. Metrics and friends failed
  silently on paths like `github.com/m0a/cc-hub`. A shared
  `claudeProjectDirName` helper was extracted into utils and all five callers
  (claude-code included) now use it. Four test cases added
  (`backend/src/utils/claude-project-path.ts` and others)
- **Insufficient validation and clamping of Range requests on `/files/raw`
  (#253)**: with no bounds checks, `bytes=10000-20000` against a 905-byte file
  returned a bogus 206 whose false Content-Length hung keep-alive clients. Bun's
  `Response(file.slice(...))` also discarded the slice bounds in transport and
  streamed the whole file chunked, so the Content-Length did not match either. A
  416 or a clamp plus reading the slice through `arrayBuffer()` makes the real
  transport consistent. Five cases verified with curl in dev
  (`backend/src/routes/files.ts`)
- **Pane misattribution from allowing the SEP sentinel ('||~~||') in a session
  name (#250)**: `tmux list-panes` output was split on `||~~||` into nine fields,
  and a session name containing the sentinel shifted every field so panes were
  registered against another session. `CreateSessionSchema.name` is constrained
  by `/^[A-Za-z0-9._-]+$/`, and the parser defensively validates paneId with
  `/^%\d+$/` and drops malformed rows (`shared/types.ts`,
  `backend/src/services/tmux.ts`)

## [0.1.161] - 2026-05-30

Nine Critical/High vulnerabilities found by a multi-agent review of the whole
codebase. Every fix has unit tests and was verified in dev both as a regression
and as an attack.

### Security
- **Removed the hardcoded public constant used as the JWT signing key (#230,
  Critical)**: `JWT_SECRET` was set on no deployment path and fell back to the
  public constant `development-secret-change-in-production`, so anyone could
  forge a token and bypass `CCHUB_PASSWORD` authentication entirely. A random
  32-byte secret is generated at startup and persisted in the data dir (0600),
  and the usable default is gone (`backend/src/middleware/auth.ts`,
  `backend/src/index.ts`)
- **tmux command injection (RCE) through the WebSocket control path (#231,
  Critical)**: `/ws/mux` interpolated `paneId` / `cols` / `rows` into tmux
  control-mode commands unvalidated, so a `paneId` containing a newline could
  inject arbitrary tmux commands (that is, host RCE). Every frame is validated
  through `MuxClientMessageSchema` (zod) and each command sink gained
  `assertPaneId` and integer guards (`shared/types.ts`,
  `backend/src/routes/terminal-mux.ts`, `backend/src/services/tmux-control.ts`,
  `backend/src/services/pane-viewport.ts`)
- **Arbitrary file read/write from trusting a client-supplied base in the file
  routes (#232, Critical)**: `/list` / `/read` / `/raw` / `/download` / `/upload`
  trusted the client's `sessionWorkingDir` as the base, so
  `base=/etc&path=/etc/passwd` and similar could read or write any file outside
  the session sandbox. `sessionWorkingDir` is checked against a real live
  session's working directory by realpath before use
  (`backend/src/routes/files.ts`)
- **Path traversal in session-history (#233, High)**: `projectDirName` /
  `sessionId` were joined under `~/.claude/projects` unvalidated, so `../../../etc`
  (percent-encoded to bypass the router constraints too) could list arbitrary
  directories and read `*.jsonl`. Flat-segment validation was added
  (`backend/src/services/session-history.ts`)
- **Shell injection through the resume sessionId (#234, High)**: `sessionId` went
  into an interactive shell as a bare string in `claude -r <id>`, so
  `x; rm -rf ~ #` executed arbitrary commands. Constrained by `SessionIdSchema`
  and quoted in `agentResumeCommand` (`shared/types.ts`,
  `backend/src/routes/sessions.ts`)
- **SSRF through peer URLs (#235, High)**: `PeerCreateSchema.url` accepted any
  scheme and host, and the stored URL was fetched server-side with credentials,
  so a peer pointing at loopback, `169.254.169.254` or RFC1918 gave SSRF. https
  is required and non-local is enforced (with the Tailscale ranges allowed) on
  every outbound peer fetch (`backend/src/services/peer-url.ts`,
  `backend/src/services/peer-auth.ts`, `backend/src/routes/peers.ts`,
  `shared/types.ts`)

### Fixed
- **A reconnect storm in the ping keepalive (#236, High)**: with no terminal
  selected (`sessionId=""`) the ping was dropped by the subscription gate and no
  pong came back, so it disconnected and reconnected about every 25 seconds.
  `ping` is handled before the gate (`backend/src/routes/terminal-mux.ts`)
- **The peer file proxy did not forward Range or conditional headers (#237,
  High)**: media on a peer host could not be seeked and large files transferred
  in full. `Range` / `If-Range` / `If-None-Match` / `If-Modified-Since` are
  forwarded upstream (`backend/src/routes/peers.ts`)
- **History search failed silently under password auth (#238, High)**: search
  used a raw `EventSource`, which cannot send an Authorization header, so a 401
  turned into a silent "no results". It uses `fetch` plus `ReadableStream` to
  attach the Bearer and parses the SSE by hand, and an AbortController also
  resolves the old EventSource leak (`frontend/src/hooks/useSessionHistory.ts`)

## [0.1.160] - 2026-05-24

### Fixed
- **The void at the bottom of the viewport spreading across the screen (a
  v0.1.159 regression, plus the real root cause)**: v0.1.159's fix was wrong in
  principle - it missed that `cs.sendCommand`'s return value carries no trailing
  `\n` artifact, and popped genuine trailing blank lines, making things worse.
  Investigation then found a deeper bug: `TmuxControlSession.processRawLine`
  early-returned on an empty `Buffer`, so **literal blank rows inside a
  `capture-pane -p` response disappeared entirely at the parser layer** (a
  55-line capture shrinking to 32, for instance). Downstream, `pane-viewport.ts`
  saw the shortened response and padFilled `''` at the bottom, so the void
  appeared to grow as you scrolled. The real fix is that `processRawLine` pushes
  a blank line into `currentOutput` only while inside a `%begin`/`%end` block.
  v0.1.159's `parseCaptureOutput` change was reverted back to `split('\n')`.
  Verified in dev against four panes at offsets 0..500 - trailing void = 0 at
  every offset (`backend/src/services/tmux-control.ts`,
  `backend/src/services/pane-viewport.ts`,
  `backend/src/services/__tests__/tmux-control-serialize.test.ts`)

## [0.1.159] - 2026-05-24

### Fixed
- **The void area at the bottom of the viewport varied with the scroll offset**:
  `pane-viewport.ts`'s padFill logic (both `captureScrollback` and the scrolled
  mode's pad capture) stripped trailing visually-blank rows from the pad capture
  with repeated `pop`s, so on a pane whose scrollback contains blank lines (a dev
  server log has one every other line) `prepend` never reached `padNeeded` and
  the later `lines.push('')` filled the **bottom** of the rendered viewport with
  void. The parity of content and blank lines changes with the scroll offset, so
  the void appeared to vary between zero and a few lines. The fix replaces it
  with a simple `parseCaptureOutput()` helper that pops only the single trailing
  `\n` artifact tmux capture-pane always adds, preserving genuine blank lines in
  the scrollback. In a simulation, one line of void at odd offsets before the fix
  became zero at every offset after (`backend/src/services/pane-viewport.ts`,
  `backend/src/services/__tests__/pane-viewport-capture.test.ts`)

## [0.1.158] - 2026-05-24

### Fixed
- **Root cause of `cchub send --submit` pasting a long payload (over about 300
  bytes) into the input box without submitting**: the old approach of appending
  `\r\r` failed when the TUI decided a large input batch was an auto-paste and
  absorbed the trailing CR into the paste, leaving the body unsubmitted. It wraps
  the payload in explicit bracketed paste markers now
  (`\x1b[200~${payload}\x1b[201~\r`), which submits reliably regardless of size
  (the same approach already established for `/api/sessions/:id/prompt`). A flush
  with an empty payload (`cchub send <target> "" --submit`) still works. Verified
  against the Claude TUI in dev at 507 bytes, 43 bytes and the flush case
  (`backend/src/commands/send.ts`)
- The CLI help and the `cchub-send` skill docs follow the new behavior (submits
  regardless of length; the workaround needed up to v0.1.157 is gone)
  (`backend/src/cli.ts`, `.claude/skills/cchub-send/SKILL.md`)

## [0.1.157] - 2026-05-24

### Fixed
- **Better `detectedState` accuracy for `cchub peek` / `cchub send --wait`**:
  scenarios previously misread as `idle` are correctly `processing` now -
  `(esc to interrupt)` truncated to `esc to int...` in a narrow pane (<=60
  columns), `Press up to edit queued messages` while Claude is busy, extra
  information after a trailing `tokens...)`, and the spinner marker (the marker +
  verb-ing + ellipsis structure). Spinner verbs change from release to release,
  so the match is structural rather than by verb. A past-tense spinner line stays
  idle (`backend/src/services/pane-viewport.ts`)

### Docs
- **Field learnings folded into the `cchub-send` skill**: even a single line with
  no newlines is treated as a bracketed paste past 500 bytes, so `--submit`'s
  `\r\r` is absorbed and the text stays in the input box (confirmed on a device
  with a single 979-byte line). It now states that a long send should generally
  use `--submit --wait` to confirm the submit. Also added `cchub peek`'s
  stdout/stderr output format, a workaround for `curl | python3` truncating under
  rtk, and how to dismiss the TUI rating overlay with `cchub send "0"` (no
  newline) or Esc (`.claude/skills/cchub-send/SKILL.md`)

## [0.1.156] - 2026-05-23

### Fixed
- **The tmux viewport's cursor correction was reorganized around session
  metadata**: the corrections scattered through `pane-viewport.ts` were extracted
  into `viewport-cursor-policy.ts`, and the footer-specific cursor policy is used
  only when `agent=currentCommand` is `codex`. Shells keep the padFill-based
  correction while being lightly clamped so the cursor cannot pass the last
  visible line, which suppresses the blank-line drift seen with some shells
  (`backend/src/services/pane-viewport.ts`,
  `backend/src/services/viewport-cursor-policy.ts`,
  `backend/src/routes/terminal-mux.ts`, `backend/src/routes/sessions.ts`)

## [0.1.155] - 2026-05-23

### Fixed
- **Shift+Tab did nothing on the software keyboard**: `sendKeyPress` in
  `Keyboard.tsx` had no case for Shift+Tab, and the fallback produced
  `"\t".toUpperCase()` = `"\t"`, dropping the shift and sending a plain Tab. It
  returns `\x1b[Z` (CSI Z, the VT back-tab xterm sends for Shift+Tab) following
  the same pattern as the existing Shift+Enter branch, so Claude Code's
  "shift+tab to cycle" (auto-mode / plan-mode / accept-edits) works from the
  virtual keyboard on mobile and tablet (`frontend/src/components/Keyboard.tsx`)

## [0.1.154] - 2026-05-23

### Fixed
- **A tmux pane on macOS suddenly showing one or two lines of CSV, or losing
  spaces mid-sentence**: `TmuxControlSession.sendCommand`'s `pendingQueue` was
  shared by several callers on one session (the live WebSocket viewport plus
  `cchub peek` / `cchub send --wait`), so the `pendingQueue.splice` on a
  10-second timeout shifted the FIFO and a `display-message` metadata reply (for
  example `277,74,2,70,0,0,8452` = `cols,rows,cx,cy,cflag,alt,hist`) was mistaken
  for a later `capture-pane` reply and drawn as the pane's contents. Writes to
  stdin are serialized through a `commandTail` promise chain so a command only
  goes out after the previous one settles, and a timeout (extended to 30s) now
  `destroy()`s the whole session rather than splicing a single pending entry.
  Silent corruption from a late reply is eliminated
  (`backend/src/services/tmux-control.ts`,
  `backend/src/services/__tests__/tmux-control-serialize.test.ts`)

## [0.1.153] - 2026-05-23

### Added
- **`cchub peek` / `cchub send --wait` can inspect a peer pane's state**: a way
  to answer "did it arrive? is it stuck on a permission prompt?" after sending to
  a peer, without opening the UI. It captures the pane viewport and heuristically
  classifies it as `idle` / `processing` / `permission_prompt` /
  `ask_user_question` / `unknown`. `POST /api/sessions/:id/panes/input` gained
  `{wait, waitMs, lines}` (returning a viewport after sending), and a new
  `GET /api/sessions/:id/panes/:paneId/viewport` backs peek. On the CLI side:
  `cchub send --wait/--wait-ms/--lines` and a new
  `cchub peek <peer>:<session>:<paneId>`. The classification lives in
  `detectPaneState()` in `backend/src/services/pane-viewport.ts` (processing from
  `(esc to interrupt)` or the `tokens)` spinner, permission_prompt from
  `Do you want to ...?` / `Yes, and don't ask again`, idle from the spinner
  markers or an empty input box, and so on). The cchub-send skill docs were
  updated too (`backend/src/cli.ts`, `backend/src/commands/send.ts`,
  `backend/src/routes/sessions.ts`, `backend/src/services/pane-viewport.ts`,
  `.claude/skills/cchub-send/SKILL.md`)

## [0.1.152] - 2026-05-22

### Fixed
- **The file browser said "Access denied" on a remote peer session**: FileViewer
  always called the hub's `/api/files/*`, so when a pane was connected to Claude
  Code on a remote peer the hub could not see that peer's filesystem and returned
  403. A new general proxy at `/api/peers/:peerId/files/*` streams
  `list / read / raw / changes / git-changes / git-diff / language / download /
  upload / images` through to the peer's `/api/files` (bypassing `peerFetch`'s 5s
  timeout so binary streaming is not cut off). The frontend switches the URL
  prefix through `useFileViewer(sessionWorkingDir, peerId?)`, and both
  `DesktopLayout` and `App.tsx` (the mobile path) remount FileViewer on the
  `{ dir, peerId }` pair. The mobile path also gained a peerId fallback lookup
  from `apiSessions`, so it resolves to the peer URL even in the moment right
  after a reload when `openSessions` does not yet contain the peer session
  (`backend/src/routes/peers.ts`, `frontend/src/hooks/useFileViewer.ts`,
  `frontend/src/components/files/FileViewer.tsx`,
  `frontend/src/components/DesktopLayout.tsx`,
  `frontend/src/components/PaneContainer.tsx`, `frontend/src/App.tsx`)
- **DesktopLayout dropped peerId when merging propSessions with apiSessions**:
  where a pane's sessionId existed only in `apiSessions` (right after a reload,
  before it joins `openSessions`), `sessions.find(...).peerId` was undefined and
  image uploads and FileViewer URLs went to the local hub. The merged result
  always carries `peerId: apiSession.peerId ?? propSession.peerId`
  (`frontend/src/components/DesktopLayout.tsx`)

## [0.1.151] - 2026-05-22

### Fixed
- **Attaching an image did not work on a remote peer's session**: an image upload
  always saved to the hub's `/tmp/cchub-images/` and sent that path to the tmux
  pane. With the pane connected to Claude Code on a remote peer, that peer cannot
  see the hub's disk, so it became "file not found". A new
  `POST /api/peers/:peerId/upload/image` proxies the multipart body to the peer
  that owns the active pane, saves into that peer's `/tmp/cchub-images/` and
  returns a peer-local path. The focused pane's peerId is propagated through
  `useSessions` -> `OpenSession` -> `Terminal` -> `InputBar`, and it is also
  passed to `DesktopLayout`'s paste and file-pick paths and to the mobile
  Terminal (`TerminalPage`) (`backend/src/routes/peers.ts`,
  `backend/src/routes/upload.ts`, `frontend/src/utils/upload-image.ts`,
  `frontend/src/components/InputBar.tsx`, `frontend/src/components/Terminal.tsx`,
  `frontend/src/components/DesktopLayout.tsx`,
  `frontend/src/pages/TerminalPage.tsx`)

## [0.1.150] - 2026-05-22

### Added
- **Multi-server support on the dashboard**: a `ServerInfo` card per registered
  peer, each polling its own CPU / memory / disk / swap / load. A new
  `usePeerServerMetrics` hook calls `/api/peers/:peerId/dashboard` every 30
  seconds. Throughput measures the browser's own WS byte counts, so it is shown
  on the local card only and suppressed on remote ones
  (`frontend/src/components/dashboard/PeerServerCard.tsx`,
  `frontend/src/hooks/usePeerServerMetrics.ts`, `backend/src/routes/peers.ts`,
  `backend/src/routes/dashboard.ts`)

### Changed
- **The connected-device count is deduplicated**: the `connectedClients` badge
  returned the number of WebSocket connections (so several tabs in one browser,
  and reconnects, counted separately). The frontend persists a UUID in
  `localStorage` and sends it on the mux WS URL as `?deviceId=...`, and the
  backend counts unique deviceIds. Several tabs on one device count once, and
  another device or browser counts separately (`frontend/src/utils/device-id.ts`,
  `frontend/src/hooks/useMultiplexedTerminal.ts`, `backend/src/index.ts`,
  `backend/src/routes/terminal-mux.ts`)

## [0.1.149] - 2026-05-22

### Fixed
- **A v0.1.148 regression froze every tmux session's indicator at `completed`**:
  removing the parent walk made `ccSessionId` null, so it could no longer be
  matched against a hook event's `session_id`. The parent walk is restored to
  obtain `ccSessionId` for hook matching, and to prevent leakage the recap
  fields (`ccRecap` / `ccFirstPrompt` / `ccSummary`) are only shown when
  `ccSession.projectPath === currentPath` (`backend/src/services/claude-code.ts`,
  `backend/src/routes/sessions.ts`)
- **`pathToProjectName` did not replace `.` with `-`**: Claude Code converts both
  (`/Users/m0a/repo/github.com/m0a/cc-hub` ->
  `-Users-m0a-repo-github-com-m0a-cc-hub`) while cchub's `pathToProjectName` only
  replaced `/`, so a path containing a dot (`github.com` and the like) could not
  find its project dir and the parent walk shared an ancestor's session
  (`/Users/m0a`) across every pane. Both characters are replaced now
  (`backend/src/services/claude-code.ts`)

### Changed
- Added the multi-line paste submit behavior (even `--submit`'s two trailing CRs
  may not leave paste mode) and the workarounds (send `\r` again separately, or
  `tmux send-keys Enter` on the receiving pane) to the `cchub-send` skill
  (`.claude/skills/cchub-send/SKILL.md`)

## [0.1.148] - 2026-05-22

### Fixed
- **Several tmux sessions shared one `ccSessionId` / `ccRecap` /
  `ccFirstPrompt`**: `getSessionForPath` / `getRecentSessionsForPath` walked up
  to `/` looking for a jsonl when the workingDir's project dir had none. In a
  "start Claude Code in `/Users/m0a`, then `cd <subdir>`" tmux pane, that
  returned the ancestor project's newest jsonl to every pane, leaking one recap
  across separate Claude Code sessions. The parent walk was removed in favor of
  an exact path match, and a pane with no jsonl returns `null` (showing nothing
  beats showing something wrong). The launchd and TZ-skew fallbacks are already
  covered by the existing `ptySessionId` / `tty-start-time` paths
  (`backend/src/services/claude-code.ts`)

### Changed
- Added "setting up a two-way conversation", "diagnosing a peer's hook
  configuration (`/api/notify/hook-status`)" and "how to use the `--submit` flag"
  to the `cchub-send` skill, and made pre-approving `Bash(cchub send:*)` an
  explicit required step (`.claude/skills/cchub-send/SKILL.md`)

## [0.1.147] - 2026-05-22

### Fixed
- **A new `claude` session (started without `-r`) had no `ccSessionId`, so
  immediate indicator updates and notifications did not work**: the final path
  fallback in `buildSessionsList` (`ccSessionsByPath.get(currentPath)`) required
  a `ptySessionId`, so a freshly started session (not `claude -r <uuid>`) always
  had `ccSessionId` undefined and `applyHookIndicatorUpdate` matched nothing even
  searching across peers. The `ptySessionId` requirement was dropped from the
  condition, and when `getSessionByTtyStartTime` returns null (it can fail on TZ
  skew) it unconditionally falls back to the newest `.jsonl` under the cwd
  (`backend/src/routes/sessions.ts`)

### Added
- **A `cchub send --submit` flag**: appends `\r\r` before sending. Claude Code's
  TUI does not submit input that entered paste mode with a single `\r` and
  requires two explicit Enters, so `--submit` rather than `--newline` is the
  reliable way to converse with Claude Code from `cchub send`
  (`backend/src/commands/send.ts`, `backend/src/cli.ts`)

## [0.1.146] - 2026-05-22

### Added
- **The `cchub send` CLI and the `POST /api/sessions/:id/panes/input`
  endpoint**: arbitrary bytes can be sent from the CLI into a tmux pane on a
  local or peer server. The form is
  `cchub send <peer>:<session>:<paneId> "text"`, where `<peer>` accepts `local`,
  a peer id or a nickname. `--stdin` reads the payload from stdin, `--newline`
  appends a CR (to make a shell or TUI submit), and `--base64` sends binary. When
  the peer requires authentication, the `wsToken` from `peers.json` is attached
  as a Bearer automatically (`backend/src/routes/sessions.ts`,
  `backend/src/commands/send.ts`, `backend/src/cli.ts`)
- Added the `cchub-send` skill, covering the target notation, when to use which
  flag, how to find a `paneId` and how to resolve common errors
  (`.claude/skills/cchub-send/SKILL.md`)

## [0.1.145] - 2026-05-22

### Changed
- **"Clear cache" became a full reset**: it used to unregister the service worker
  and delete the Cache API only, leaving IndexedDB, localStorage and
  sessionStorage behind, and `location.reload()` still allowed the memory cache,
  so a PWA could stay stuck on one version. The unified handling moved into a new
  `frontend/src/utils/nuke-cache.ts`, which deletes the SW, the Cache API,
  IndexedDB, localStorage and sessionStorage and then performs a cache-busted
  hard reload (`location.replace` with `?_nocache=<timestamp>`). Both the
  dashboard's "clear cache" button and the `Ctrl/Cmd+Shift+F5` shortcut run it
  (`frontend/src/components/dashboard/Dashboard.tsx`,
  `frontend/src/components/DesktopLayout.tsx`)
- Side effect: clearing localStorage also clears the auth token, so a fresh login
  is required

## [0.1.144] - 2026-05-22

### Fixed
- **Other peers' indicator state and OS notifications did not work**: a peer's
  `hook-event` (Stop / PreToolUse / UserPromptSubmit / PostToolUse) only arrived
  through the sharedWs of "the peer actively shown in the terminal", so other
  peers received neither notifications nor immediate indicator updates.
  `usePeerSessionsWatcher` receives hook-events on each peer's own WS and applies
  them immediately through `applyHookIndicatorUpdate` (which searches across all
  peers), firing the OS notification through `fireHookNotification`
  (`frontend/src/hooks/usePeerSessionsWatcher.ts`)
- Related: `applyHookIndicatorUpdate` went from hub-local only to searching
  across every peer (by the ccSessionId UUID)

## [0.1.143] - 2026-05-22

### Fixed
- **The peer sessions watcher's WS was cut every 60 seconds by the backend's
  zombie detection and fell into a retry loop**: the watcher introduced in
  v0.1.140 sent no pings, so the hub's `terminal-mux` (`PING_TIMEOUT_MS=60s`)
  judged it a zombie and it entered a close -> retry after 5s -> close cycle. It
  happened both against the Linux hub and against a Mac peer, and as a side
  effect the peer's terminal display stopped. The watcher pings every 25 seconds
  now (`frontend/src/hooks/usePeerSessionsWatcher.ts`)

## [0.1.142] - 2026-05-22

### Added
- **Cross-peer session reordering**: a new `/api/peers/session-order` (GET/PUT)
  stores a merged order of `${peerId}:${sessionId}` on the hub, so hub and remote
  peer sessions can be dragged into one combined order. The order is shared
  across devices (`backend/src/services/peer-registry.ts`,
  `backend/src/routes/peers.ts`, `frontend/src/hooks/useSessions.ts`,
  `frontend/src/components/SessionList.tsx`)

### Fixed
- Reordering used `session.id` alone as the `useSortable` / `SortableContext` id,
  so a tmux session with the same name on the hub and a peer (`cchub-work-1`, for
  instance) collided and broke the reorder. Made unique with a composite key
  (`${peerId}:${sessionId}`)

## [0.1.141] - 2026-05-22

### Fixed
- **Hub-local sessions disappearing while connected to a peer, fully resolved**:
  v0.1.140 moved the peer session list onto WS push, but the hub's own list still
  arrived only through `useMultiplexedTerminal`'s sharedWs (which follows the
  active session's peer), so with a Mac peer's session open the hub's
  sessions-updated never arrived and the Linux list went empty.
  `usePeerSessionsWatcher` now covers hub-local too, holding an independent WS to
  every peer including local. The sessions-updated dispatch in
  `useMultiplexedTerminal` was removed to avoid duplication
  (`frontend/src/hooks/usePeerSessionsWatcher.ts`,
  `frontend/src/hooks/useSessions.ts`,
  `frontend/src/hooks/useMultiplexedTerminal.ts`)
- Related: the two caches (`cachedSessions` / `cachedRemotePeerSessions`) were
  merged into the watcher's single `sessionsByPeer`, and `mergedSessions` /
  `updateSessions` were removed, simplifying useSessions

## [0.1.140] - 2026-05-22

### Changed
- **Peer session fetching moved from polling to WS push**: the 5-second
  `GET /api/peers/sessions` is gone; each remote peer's `/ws/mux` is held open
  and its `sessions-updated` push is subscribed to directly. This also fixes the
  hub's sessions-updated never arriving - and Linux's sessions vanishing from the
  screen - when the PWA is reopened on a peer session. The WS connections are
  persisted per peer, so switching peers does not leak
  (new `frontend/src/hooks/usePeerSessionsWatcher.ts`,
  `frontend/src/hooks/useSessions.ts`)
- **Shared peer WS URL helpers**: `peerHttpUrlToWsUrl` / `appendWsToken` moved
  into `frontend/src/services/peer-ws.ts`, unifying the three inline regexes in
  `useMultiplexedTerminal` / `usePeerConnection` / `usePeerSessionsWatcher`
  (new `frontend/src/services/peer-ws.ts`)
- The watcher reconnects with exponential backoff (5s up to a 60s cap),
  suppressing a connect loop against a permanently offline peer

## [0.1.139] - 2026-05-22

### Fixed
- **Non-ASCII characters in pane_title became `_` when started through launchd on
  macOS**: starting `cchub` through launchd on a Mac does not pass `LANG`/`LC_ALL`
  to child processes, so tmux ran in ASCII fallback mode and replaced non-ASCII
  characters such as Claude Code's spinner `⠐` (U+2810) with `_`. The paneTitle
  reaching the Linux hub through a peer therefore had the form `_ <topic>` and
  displayed with a `_` prefix. Every `Bun.spawn` call in
  `backend/src/services/tmux.ts` now passes `env: TMUX_ENV` (pinning LANG/LC_ALL
  to UTF-8), which guarantees UTF-8 output even through launchd
  (`backend/src/services/tmux.ts`)
- Related: the paneTitle-cleaning regexes in SessionList / App / PaneContainer /
  FileBrowser / FileViewer / hookNotification were unified to
  `[✳★●◆✻✽⏳⠀-⣿]\s*` so every frame of Claude's and Codex's spinner animation
  (U+2800-U+28FF) is stripped (`frontend/src/App.tsx`,
  `frontend/src/components/PaneContainer.tsx`,
  `frontend/src/components/SessionList.tsx`,
  `frontend/src/components/files/FileBrowser.tsx`,
  `frontend/src/components/files/FileViewer.tsx`,
  `frontend/src/utils/hookNotification.ts`)
- Related: the home-directory shortening regex was extended to handle
  `/(?:home|Users)/<user>` and collected into a shared utility
  `frontend/src/utils/path.ts` (`toHomeShortPath` / `stripHomeProjectPrefix`), so
  macOS `/Users/<user>` paths also shorten to a tilde and the seven inline
  regexes across `SessionList` / `PaneContainer` / `FileBrowser` / `FileViewer` /
  `hookNotification` go through one function (new `frontend/src/utils/path.ts`)

## [0.1.138] - 2026-05-21

### Fixed
- **Peer routing when resuming a lost session**: `SessionList.handleResume`
  called the local hub's `/api/sessions/history/resume` directly through
  `authFetch`, ignoring `session.peerId`. Resuming a lost session on a remote
  peer (a Mac, say) therefore tried to run `cd '/Users/m0a' && claude -r ...` on
  the hub (Linux) and failed with `cd: no such file or directory`. It goes
  through `sessionFetch(session, peers, ...)` now and POSTs directly to the
  owning peer's URL. The `createSession` path used when there is no
  conversationId carries `session.peerId` too, and an active session's
  `POST /:id/resume` was made peer-aware as well
  (`frontend/src/components/SessionList.tsx`)
- `SessionListProps.onSelectSession` / `onSelectPane` widened their argument type
  from `SessionResponse` to `ExtendedSessionResponse` so `peerId` propagates
  through the navigation after a resume and the following WebSocket subscribe
  points at the right peer (`frontend/src/components/SessionList.tsx`)

## [0.1.137] - 2026-05-21

### Added
- **Creating a session on a peer**: the new-session dialog gained a "server"
  selector, so a session can be created on a registered peer as well as the hub.
  With a peer selected, that peer's filesystem can be browsed in the same
  directory-picker UI as the hub's - tapping down into paths like
  `/Users/m0a` works (`frontend/src/components/SessionList.tsx`,
  `frontend/src/hooks/useSessions.ts`, `backend/src/routes/peers.ts`)
- **Multi-server support in the history list**: the History tab merges every
  peer's projects, with a peer nickname badge and a colored left border on each
  project and session. Expanding a project, showing a conversation and the resume
  button all route to the right peer's API. Search (SSE) stays hub-only for now
  (`backend/src/routes/peers.ts`, `frontend/src/hooks/useSessionHistory.ts`,
  `frontend/src/components/SessionHistory.tsx`)
- **Periodic polling in `usePeers`**: refetching `/api/peers` every five seconds
  means a peer stuck showing `offline` after a transient verify failure becomes
  selectable again once it is back (`frontend/src/hooks/usePeers.ts`)

### Fixed
- `POST /api/peers/history/:peerId/resume` collapsed the peer's status code into
  200/502, which broke special handling such as `duplicate_working_dir` (409).
  The peer's status passes through unchanged (`backend/src/routes/peers.ts`)

### Notes
- The file viewer, conversation viewer and session resume still have room for
  peer support (candidates for phase 4)
- Cross-peer search is hub-only as well; merging SSE streams is future work

## [0.1.136] - 2026-05-21

### Added
- **Multi-server support (phases 1 + 2)**: sessions from several cchub instances
  (peers) registered with the hub are merged into one screen, and selecting one
  switches the terminal WebSocket directly to that peer. A browser that knows one
  hub URL can drive every machine.
  - The hub gained a peer registry (`~/.cc-hub/peers.json`, mode 0600) with
    `GET/POST/PATCH/DELETE /api/peers` and the aggregate `GET /api/peers/sessions`
    (`backend/src/services/peer-registry.ts`,
    `backend/src/services/peer-auth.ts`, `backend/src/routes/peers.ts`)
  - A Servers tab in the dashboard panel allows adding a peer and editing its
    nickname, color or removal from both desktop and mobile
    (`frontend/src/components/PeerManager.tsx`,
    `frontend/src/components/DashboardPanel.tsx`, `frontend/src/App.tsx`)
  - Session cards show a peer nickname badge and a colored left border
    (`frontend/src/components/SessionList.tsx`)
  - `useMultiplexedTerminal` was refactored to accept a `peerWsBase`, switching
    the WS target according to the selected session's peer
    (`frontend/src/hooks/useMultiplexedTerminal.ts`,
    `frontend/src/hooks/usePeerConnection.ts`,
    `frontend/src/pages/TerminalPage.tsx`,
    `frontend/src/components/DesktopLayout.tsx`)
- **Peer discovery**: a "Discover" button on the Servers tab finds cchub
  instances on the Tailscale tailnet, and clicking one pre-fills the add-peer
  form. It always asks for confirmation first, so it cannot accidentally scan a
  corporate network (`backend/src/services/peer-discovery.ts`)
- **Adding a peer with auth disabled**: `/api/auth/required` is checked first so
  a peer running `cchub` without `-P` can still be added
  (`backend/src/services/peer-auth.ts`)

### Fixed
- `fetchAndOpenSession`'s useEffect depended on `createInitialSession`, which was
  recreated on every render, so the effect re-ran forever and rewound
  `activeSessionId` to the localStorage value. Stabilized with `useCallback`,
  with `t` reached through a ref, which fixes a peer session "snapping back to a
  hub session right after opening" (`frontend/src/App.tsx`)
- While connected to a peer, that peer's `sessions-updated` push overwrote the
  hub's merged list and rewrote `peerId` to `local`, flipping the WS target. A
  guard limits it to hub connections (`frontend/src/hooks/useMultiplexedTerminal.ts`)
- Mobile (TerminalPage) did not pass `peerWsBase` into
  `useMultiplexedTerminal`, so a peer session's terminal could not be opened from
  a phone. Wired the same way as desktop (`frontend/src/pages/TerminalPage.tsx`)
- Changing a peer session's theme or title, or deleting it, was pinned to the hub
  and 404ed; a `sessionFetch(session, peers, path, init)` helper routes it to the
  peer's URL and token (`frontend/src/services/peer-fetch.ts`,
  `frontend/src/hooks/useSessions.ts`,
  `frontend/src/components/SessionList.tsx`)

### Notes
- REST paths such as the file viewer, conversation viewer, session resume and
  session order remain pinned to the hub (they are not sent to a peer). Planned
  for phase 3
- Anyone logged into the hub can add or remove a peer (this assumes home use)

## [0.1.135] - 2026-05-20

### Changed
- **Deleting a session now only kills it, without removing it from the list**:
  deleting an active session kills tmux but keeps its entry in
  `last-known-sessions.json`, so it stays in the list as Lost. That makes
  continuing the conversation one tap on the resume button. To remove it from the
  list entirely, delete the Lost session again and it leaves last-known too
  (`backend/src/routes/sessions.ts`)
- The delete confirmation's warning matches the real behavior now ("this cannot
  be undone" became "the tmux session ends; it stays in the list as Lost and the
  resume button continues the conversation") and its tone moved from warning red
  to neutral (`frontend/src/App.tsx`, `frontend/src/components/SessionList.tsx`,
  `frontend/src/i18n/locales/{ja,en}.json`)

## [0.1.134] - 2026-05-20

### Fixed
- The mouse wheel and trackpad did not scroll the terminal and cycled Claude's or
  Codex's input history instead
  - Cause: when the active mouse protocol includes WHEEL, xterm.js forwards wheel
    events straight to the app (the Ink TUI), which treats them as up/down keys
  - Fix: `Terminal.tsx`'s wheel listener moved to the capture phase and added
    `stopPropagation()`, so it never reaches xterm.js's handler and only
    `scrollTerminal()` runs

## [0.1.133] - 2026-05-20

### Added
- `cchub update` supports GitHub token authentication, raising the
  unauthenticated 60/hour rate limit to 5000/hour
  - Detection order: the `GITHUB_TOKEN` env var, the `GH_TOKEN` env var, then the
    `gh auth token` subprocess
  - When authenticated it prints `Using GitHub token from {{source}}`
  - A 403 with `x-ratelimit-remaining: 0` is identified as a rate limit and shows
    the reset time and how to authenticate (`export GITHUB_TOKEN=<token>` /
    `gh auth login`)
  - With nothing configured it runs unauthenticated as before
    (`backend/src/commands/update.ts`, `backend/src/i18n/index.ts`)

## [0.1.132] - 2026-05-20

### Added
- **Codex support in the history tab**: a new `CodexHistoryService` reads the
  rollout JSONL under `~/.codex/sessions/**` and merges it into the same project
  buckets as Claude sessions. Each history row shows a `Claude` or `Codex` badge,
  and resuming switches between `claude -r` and `codex resume` by agent. Codex
  sessions are integrated across every endpoint - search (including the SSE
  stream), the conversation view and the project list
  (`backend/src/services/codex-history.ts`, `backend/src/routes/sessions.ts`,
  `frontend/src/components/SessionHistory.tsx`,
  `frontend/src/hooks/useSessionHistory.ts`, `shared/types.ts`)

## [0.1.131] - 2026-05-19

### Changed
- **Better readability in ConversationViewer**: tool results are expanded by
  default again (a one-line summary made results hard to read). The body color
  inside a collapsed block went from `zinc-500` / `th-text-secondary` to
  `zinc-300` / `zinc-200`, improving contrast on a dark background
  (`frontend/src/components/ConversationViewer.tsx`)

## [0.1.130] - 2026-05-19

### Changed
- **ConversationViewer redesigned**: a compact, terminal-like layout. Each turn
  has a 2px role-colored sidebar, a role label (uppercase, dim) and an indented
  body, with Claude in violet, Codex in cyan, User in blue, System in gray and
  Summary in amber. Tool calls, results and thinking are collapsed by default so
  a one-line summary keeps the whole thing surveyable
  (`frontend/src/components/ConversationViewer.tsx`)

## [0.1.129] - 2026-05-19

### Fixed
- **ConversationViewer's follow scrolling**: it forced a scroll to the bottom
  every time a message arrived during streaming, so scrolling up to read did not
  hold position. It behaves like the terminal now (follow only while at the
  bottom, stay put while scrolled up, resume following once back at the bottom).
  Internal state tracking and the external callback (keyboard control) were
  separated so `atBottomRef` is always current, and auto-scroll is gated on it
  (`frontend/src/components/ConversationViewer.tsx`)

## [0.1.128] - 2026-05-19

### Fixed
- **Resuming a lost session**: for a session restored as lost after a restart,
  overwriting the `last-known-sessions.json` snapshot every time could wipe
  existing values in a moment when `currentPath` and friends were temporarily
  unavailable, and the frontend's resume flow then fell to the active-session
  endpoint instead of the history API and got a 404. A fallback keeps the
  previous value when there is no new one (`backend/src/routes/sessions.ts`)

## [0.1.127] - 2026-05-19

### Added
- **The `cchub debug` CLI**: turns Bun inspector mode on and off for the
  production systemd user service only when needed. It writes the `BUN_OPTIONS`
  environment variable as a systemd drop-in
  (`~/.config/systemd/user/cchub.service.d/99-inspect.conf`), runs
  `daemon-reload` plus `restart`, and afterwards deletes the drop-in to return to
  normal
  - `cchub debug enable` - opens the Bun inspector on `0.0.0.0:9229`
  - `cchub debug disable` - closes it and returns to normal
  - `cchub debug profile [--seconds N]` - opens it for N seconds and disables it
    automatically (30s by default)
  - `cchub debug status` - shows the current inspector state
  - **Zero overhead when idle**: normal mode never opens the inspector port. A
    CPU profile or heap snapshot with JS function names and line numbers can be
    taken from Chrome DevTools (`chrome://inspect`) only when needed, without a
    chronic production footprint
  - Linux systemd user only (macOS launchd is not supported)

## [0.1.126] - 2026-05-19

### Added
- **Scrolling rebuilt**: the screen no longer freezes waiting for the server
  under server-side scrollback
  - A new `viewport-pseudo.ts`. `makePseudoViewport(viewport, delta)` shifts the
    current frame by delta lines and fills the exposed side with blanks. A cache
    miss in `scrollBy` / `scrollToLive` draws that pseudo frame immediately and
    overwrites it when the real one arrives, so the screen actually moves while
    waiting
  - A client-side viewport cache (`Map<offset, {viewport, historySize}>`, LRU of
    20 per pane). Scrolling back and forth over the same offset draws instantly
    with no server round trip. `historySize` is stored alongside so a tmux output
    that changes the history marks it stale automatically, and `layout-change`
    discards the whole cache
  - The scroll position indicator in the top right became `{ text, loading }`:
    blue `[N/M]` with a spinner while waiting, switching to yellow `[N/M]` when
    the real frame lands and fading after three seconds. How far you have
    scrolled, and whether the server has caught up, are both visible

### Fixed
- Continuous wheel or touch scrolling fired `scrollBy` more than 50 times a
  second, refetching a viewport and repainting the whole screen in VT each time,
  which looked like a fine tremor. Resolved with rAF coalescing (one scrollBy
  flush per frame)
- During fast scrolling several in-flight `request-viewport` responses arrived
  out of order and the screen briefly jumped back. A stale guard in
  `onPaneViewport` compares the current expected offset with the response's and
  skips the repaint on a mismatch (while still caching it)

## [0.1.125] - 2026-05-19

### Fixed
- **Chronic high CPU (73-108% on average) resolved**: the `sessions-push` hot
  loop ran a readdir plus stat plus content read over every jsonl on each cycle,
  and switching sessions in the UI respawned `tmux -CC attach` each time. Average
  CPU dropped from **77.6% to 23.4% (about 70% less)** over ten minutes of
  observation
  - `tmux-control.ts`: `GRACE_PERIOD_MS` back from 5s to 30s. It had been
    shortened to cut idle CPU and instead respawned `tmux -CC attach` on every UI
    switch, raising the load
  - `claude-code.ts`: `SESSION_DATA_CACHE_TTL` from 5s to 30s, which fixes it
    missing the cache every time by being in phase with the 5-second
    `sessions-push`. The mtime check remains inside, so freshness is preserved
  - `claude-code.ts`: added a `pathResultCache` (TTL 3s) that short-circuits the
    readdir plus full jsonl stat sweep in `getSessionForPath` /
    `getRecentSessionsForPath` / `getSessionByTtyStartTime` within one
    `sessions-push` tick

## [0.1.124] - 2026-05-18

### Fixed
- **EVEN G2 glasses integration restored**: it had not followed v0.1.121's
  protocol change (server-side scrollback) and the glasses client still depended
  on the old `request-content` / `initial-content` and binary `0x02` frames
  - The WebSocket messages were replaced with `request-viewport` / `viewport`,
    and the buffer is updated by `stripAnsi`-ing `viewport.lines` (the array of
    ANSI-bearing lines)
  - The now-unnecessary binary frame handler and the `resize 120x20` send were
    removed (a resize would overwrite the main UI's client size, and an
    observation-only client should not do that)
  - `requestContentAndWait` still works under the new protocol (it waits on a
    buffer diff)

## [0.1.123] - 2026-05-18

### Added
- **Server-side scrollback (reintroduced)**: tmux becomes the single source of
  truth for the visible region and the scrollback, and xterm.js is render-only.
  Reintroduced after fixing the mobile rendering regression from v0.1.121
  - The WebSocket `request-viewport` / `viewport` protocol: the client requests
    an arbitrary window by offset and the server returns those lines through tmux
    `capture-pane -S/-E`
  - Offset-based window retrieval is collected in `pane-viewport.ts`. An
    altScreen TUI (htop, vim, Codex) is left alone; only normal-screen inline
    TUIs and shells get scrollback padFill to remove the "void"
  - An initial viewport is delivered immediately on subscribe, removing the "gray
    canvas" race on mobile
  - Momentum scrolling was replaced by converting the scroll amount into an
    offset and asking tmux (xterm's own scrollback is 0)
  - Tapping the terminal or showing the soft keyboard forces a return to
    offset=0 (the live edge)

### Fixed
- A comprehensive fix for void areas
  - For an app such as the Claude TUI that does not paint the whole pane, the
    remaining trailing blank space is filled from the scrollback above so a full
    pane's worth of content is always shown
  - The same padFill applies while scrolling (so the void does not grow when the
    capture window straddles the visible region)
  - Where a shell puts its prompt on a blank line, trimming stops at the cursor
    row and the cursor follows padFill's shift downward (so it does not land on
    padded-in scrollback)
- Suppressed `client-size` jittering by one row on mobile and re-sending the
  viewport (a difference of one row is absorbed as noise)

### Changed
- Frame delivery based on `state-snapshot` / `state-diff` was dropped in favor of
  `viewport` alone (-481 lines of real code)
- The frontend's xterm scrollback is pinned to 0 (history is managed only by
  tmux)

## [0.1.122] - 2026-05-18

### Reverted
- v0.1.121 (server-side scrollback) was reverted completely, because of a serious
  regression where the xterm.js canvas turned gray on mobile and the terminal did
  not render
  - Functionally identical to v0.1.120 (two revert commits and nothing else)
  - v0.1.121's GitHub release and tag were deleted, and `cchub update` resolves
    v0.1.122 as the latest
  - Server-side scrollback itself will be revisited later, mobile behavior
    included

## [0.1.120] - 2026-05-18

### Added
- A UI scale setting on the dashboard (80% / 90% / 100% / 115% / 130%)
  - It scales Tailwind's rem-based elements (Dashboard / SessionList /
    FileViewer / icons) together through `<html>`'s `font-size`
  - xterm.js has its own font setting, so the terminal body is unaffected and can
    still be controlled independently with Cmd+= / Cmd+-
  - The setting persists in `localStorage['cchub-ui-scale']` and is applied early
    in `main.tsx` to prevent a flash of unstyled content

### Fixed
- Creating the welcome session failed with `cd '~' && claude` producing
  `cd: no such file or directory: ~`
  - Added an `expandHome()` helper that expands `~` / `~/...` to `homedir()`
    before `shellQuote` in `agentStartCommand` and the resume command

## [0.1.119] - 2026-05-18

### Fixed
- The terminal could not be scrolled while it was producing output (#166)
  - `term.scrollToBottom()` ran unconditionally after applying every
    state-snapshot, so under a 5/sec snapshot flow a user's scroll up was pulled
    back within 200ms
  - It checks `viewportY >= baseY` (pinned to the bottom) before applying, and
    auto-scrolls only when pinned

### Changed
- Much less CPU when receiving a `cchub notify` hook (#166)
  - `generateSmartMessage` did a `readFile` plus `split('\n')` over the active
    Claude transcript (several MB) every time; it reads only the trailing 256 KB
    through `Bun.file().slice()` now
  - The Hono request logger skips `POST /api/notify` (as it already skips
    `/api/sessions`)
  - cpu-prof measurement: `stringSplitFast` at 17.1% and the logger at 5.1%
    disappeared, an estimated 20% CPU reduction

## [0.1.118] - 2026-05-18

### Changed
- The per-pane state-snapshot emit cap moved from 100ms (10/sec) to 200ms
  (5/sec) (#164)
  - cchub CPU was still around 127% after v0.1.117, so the rate limit was
    doubled
  - The first snapshot after idle keeps its 50ms debounce, so typing latency is
    unchanged
  - Only continuous redraws (a spinner, a log tail) are capped at 5fps

## [0.1.117] - 2026-05-18

### Fixed
- state-snapshot sends fired continuously at up to about 20/sec per pane and
  cchub burned over 150% CPU (#162)
  - A hard rate limit of `SNAPSHOT_MIN_INTERVAL_MS=100` caps it at about 10/sec
    per pane even under continuous `%output`
  - The first snapshot after idle is still sent after a 50ms debounce, so typing
    latency is preserved
- The detailed `[mux] state-snapshot ...` logging moved behind `DEBUG_MUX=1`,
  reducing what is written to journald

## [0.1.116] - 2026-05-18

### Fixed
- Codex hook events were not reflected in CC Hub's session and pane indicators
  (#160)
  - Codex's `agentSessionId` is used as the hook override key, so `PreToolUse` /
    `Stop` and the rest reach both the session and the pane
  - Detection of the `cchub notify` configuration in `~/.codex/config.toml` /
    `~/.codex/hooks.json` was added
  - The policy of using the home directory's Codex hook configuration, with no
    repo-local Codex-specific copy, was written down

## [0.1.115] - 2026-05-17

### Added
- Enter and Esc key bindings in desktop selection mode (started by a long mouse
  press)
  - Enter: copy the selection to the OS clipboard and leave the mode
  - Esc: leave without copying

## [0.1.114] - 2026-05-17

### Changed
- The desktop session modal (Ctrl+B) and dashboard panel (Ctrl+Shift+B) are
  1.25x larger, which reads better on a high-DPI monitor such as a Mac's
  - Tablets are unaffected (no zoom is applied when `isTablet`)

## [0.1.113] - 2026-05-17

### Fixed
- The WebSocket could sit in `CONNECTING` for a long time, leaving "WebSocket
  connection error" plus "Connecting..." on screen with nothing usable
  - A 10-second connection watchdog force-closes the socket if `onopen` never
    fires, which starts the existing reconnect path
  - An OPEN socket whose `pong` has been missing for over 25 seconds is treated
    as silently dead and force-closed
  - The `window` `online` event force-closes a stale socket and reconnects
    immediately
  - On returning to the tab (`visibilitychange`), a `CONNECTING` state older than
    three seconds is force-closed and retried at once

### Changed
- The server WebSocket's `idleTimeout` went from 120 to 60 seconds, cleaning up
  dead sessions twice as fast

## [0.1.112] - 2026-05-17

### Fixed
- Terminal state-sync appeared to stall during continuous output (#154)
  - Snapshot scheduling on the `%output` trigger moved from debounce to throttle,
    so it updates regularly even where output never pauses (Codex's streaming
    output, a ticking clock)
  - Visible changes are delivered as a full `state-snapshot` to avoid diff
    application drift in xterm.js
  - After applying a full snapshot the viewport returns to the bottom, so the
    buffer is not updated while an old scroll position remains on screen
  - The policy of using `capture-pane -e -p` to capture the currently visible TUI
    screen, rather than `capture-pane -a`, was written down

### Docs
- Added `AGENTS.md` for Codex and other agents, standardizing on `CLAUDE.md` and
  `.claude/skills` / `.claude/commands` as the single source (#154)

## [0.1.111] - 2026-05-17

### Fixed
- Resolved the "black void" from the Claude TUI not drawing the bottom half of a
  pane (#152)
  - The server prepends recent scrollback to short `snap.lines` so the whole
    visible area carries information
  - `PadFillCache` caches per historySize, avoiding an extra tmux round trip on
    every tick
  - Trailing blank trimming was unified on `isVisuallyBlank` (a line of nothing
    but ANSI escapes counts)

### Changed
- The state-sync renderer was greatly simplified (#152)
  - `bottomAlignOffset`, diff offsets, the auto-scroll fallback and EXTRA pane
    inflation were withdrawn
  - A snap render writes every line top-aligned (the snap is canonical)
  - The Channel C dump simply reads `snap.rows` lines from `applied.baseY`
  - Diff: `+115 / -236`

### Docs
- The architecture documentation (architecture.json / .html) follows the move to
  state-sync plus scrollback prepend padding (#151)

## [0.1.110] - 2026-05-17

### Changed
- Terminal transport replaced from a byte stream by tmux canonical state sync
  (#149, #147 phase 2)
  - `tmux capture-pane -e -p`'s output is treated as canonical state and
    delivered to the client as a snapshot/diff
  - The scrollback delta rides along in the snapshot so the client can scroll
    history too
  - Channel C (drift detection) was adapted to the new approach (comparing the
    grid after applying state-sync against the canonical output)

### Fixed
- A stopgap for the bottom half of the screen being stuck as a "black void" in
  the Claude TUI
  - Server: no empty padding for trailing blank lines that `capture-pane` trims,
    and lines that are blank after ANSI stripping are trimmed as well
  - Client: snapshot.lines are drawn bottom-aligned in the xterm grid (the
    scrollback or the previous frame shows through at the top)
  - All of it marked TEMPORARY - removable once the Claude TUI uses the pane down
    to the bottom of the screen
- Panes stayed at their desktop size when accessed from mobile
  - `refresh-client -C` alone does not resize panes in a session with
    `window-size manual`, so `resize-window` is issued alongside it
  - Both tmux commands run in parallel through `Promise.all`, halving the resize
    latency

## [0.1.109] - 2026-05-16

### Added
- Channel C: drift detection between the client's xterm.js and tmux's internal
  state (dev only, #147 phase 1)
  - Enabled by starting the server with `CCHUB_SELF_VERIFY=1`
  - The client sends xterm's visible region to the server on a trigger
    (`resize-done` / `reconnect-done` / `output-idle` / `periodic`)
  - The server compares it against `tmux capture-pane -p` and appends the
    difference to `/tmp/cchub-drift.log` as JSON Lines
  - A complete no-op in production, with no user impact
  - It stays as the correctness oracle for the state diff sync that follows
    (#147 phase 2 onward)

## [0.1.108] - 2026-05-16

### Fixed
- The file list's scroll position reset when opening or switching files in the
  file view
  - Cause 1: `useFileViewer`'s `isLoading` flag was shared by `listDirectory` and
    `readFile`, so opening a file replaced FileBrowser with a "loading"
    placeholder and unmounted it
  - Cause 2: in the mobile single-pane layout, FileBrowser itself unmounted when
    `viewMode` switched to `'file'`
  - Fix: the placeholder shows only on the first directory load, and a `viewMode`
    switch toggles display so FileBrowser stays mounted and keeps its scroll
    position
- The currently open file is highlighted with a blue background and border so it
  is visually identifiable in the file view
  - Also fixed the highlight disappearing on the way back, because the popstate
    handler explicitly cleared `selectedFile` when returning to the browser view

### Added
- A file view regression test
  (`frontend/tests/e2e/file-viewer-selection.spec.ts`): scroll retention plus
  selection highlight in the desktop split layout, and scroll retention across a
  browser-to-file round trip on mobile

## [0.1.107] - 2026-05-15

### Fixed
- "The conversation cannot be shown" also appeared in the conversation view when
  choosing another session from the list (`handleSelectSession`) or selecting a
  pane directly (`handleSelectPane`)
  - v0.1.106 fixed only the three places in `fetchAndOpenSession`, and
    `OpenSession` is assembled in six places in total
    (`handleSelectSession` / `handleSelectPane` / `createInitialSession`), three
    of which were missing `agent` / `agentSessionId`
  - Every construction site was collected into an `apiToOpenSession()` helper,
    which prevents the same omission when a field is added to `OpenSession`

### Changed
- The nested if/else in `App.tsx`'s `fetchAndOpenSession()` was flattened with
  early returns and the duplicated "create initial session" else blocks unified
  (130 lines down to 66)

## [0.1.106] - 2026-05-11

### Fixed
- Opening the conversation view on a phone showed "the conversation cannot be
  shown / the session's agent information could not be retrieved"
  - Three places in `App.tsx`'s `fetchAndOpenSession()` assembled an
    `OpenSession` without the `agent` and `agentSessionId` fields
  - The API returned `agent: 'claude'` and the frontend discarded it, so
    `activeSession.agent` was undefined and ChatView showed the `missing-agent`
    error
  - On an unstable WebSocket the later sync path (the mobile `setOpenSessions`
    effect) did not run either, so the error became permanent

## [0.1.105] - 2026-05-09

### Added
- Instrumentation for end-to-end terminal latency measurement (for comparison
  against ssh+termux; no effect in production)
  - Started with `CCHUB_BENCH=1`, the backend logs the frame size, send duration
    and timestamp of every WebSocket send
  - The frontend exposes `window.__cchub_bench`: `start()` begins measuring and
    records the number of frames received, xterm.js parse time (P50/P95/max) and
    throughput
  - A `__BENCH_END__` marker in the incoming stream prints the aggregate report
    automatically through `console.table`
  - `scripts/prepare-bench-data.sh` generates four kinds of benchmark data
    (`/tmp/bench-{plain,color,jp,redraw}.txt`)

## [0.1.104] - 2026-05-09

### Fixed
- Pressing Resume on a lost session did not switch to the new tmux session
  - A `useCallback` closure searched a stale `sessions` array, so the session the
    resume API created was not found and navigation never happened
  - The session object is assembled directly from the API response and the lost
    session's metadata, and navigation happens immediately
- Fixed a regression in the active Resume badge condition for Claude sessions
  - `d4d570d` (the Codex MVP) mistook `!isClaudeRunning` for
    `!supportsConversationMetadata`, so the badge could never appear for Claude
  - The condition was rebuilt on agent process detection

### Added
- An estimated limit-hit time (`estimatedHitTime`) on the Codex usage dashboard
  - The same calculation as Anthropic's: when the current pace reaches 100%
  - When there is an estimate the status is raised to `danger`, and the chart's
    marker matches the wording

## [0.1.103] - 2026-05-08

### Fixed
- The Codex usage dashboard kept its exhausted state past the 5h cycle's reset
  time and continued to show a limit exceeded (#136)
  - The `credits.has_credits === false` exceeded override only applies while the
    5h cycle's `resetsAt` is in the future
  - After a reset the newest windowed rate limit wins, and an old no-credits
    event no longer returns the display to 100%
- The usage chart added an artificial 0% point at the cycle start, which drew a
  vertical spike in a cycle with little history (#136)
  - Only real samples are drawn, sorted chronologically

## [0.1.102] - 2026-05-08

### Fixed
- The Resume button on a lost session (one that disappeared from tmux after a
  restart) revived a Codex session as Claude (#134)
  - `LastKnownSession` gained `agentSessionId`, preserving the Codex thread id
    across a restart
  - Resuming selects the conversation id by `session.agent` (Codex ->
    `agentSessionId`, Claude -> `ccSessionId`) and passes it to
    `/sessions/history/resume`
  - The fallback when there is no conversation id also passes the original agent
    to `createSession` (it used to be pinned to claude)

## [0.1.101] - 2026-05-08

### Added
- A conversation history viewer for Codex sessions (#132)
  - The existing Terminal / Chat toggle in the pane header is enabled for Codex
    sessions
  - `~/.codex/sessions/.../rollout-*.jsonl` is read and converted into
    Claude-compatible `ConversationMessage[]`, with `user_message` /
    `agent_message` as text and `function_call` / `function_call_output` as
    toolUse / toolResult
  - The conversation is fetched and refreshed by HTTP polling (every five
    seconds), since Codex has no WebSocket hook
  - ConversationViewer's role label switches by agent ("Codex" on a Codex
    session)
- A `useAgentConversation` facade hook that unifies how each agent's conversation
  is fetched
  - Claude through a WebSocket stream, Codex through HTTP polling, an unknown
    agent through an explicit error
  - Adding an agent means adding a branch to the facade rather than touching
    ChatView

### Fixed
- DesktopLayout's session merge did not copy `agent` / `agentSessionId`, so a
  Codex session's conversation fell back to a Claude jsonl in the same cwd
- ChatView silently fell back to the Claude WebSocket when `agent` was
  unspecified; that is gone, and an unsupported agent shows a centered error
  message

## [0.1.100] - 2026-05-07

### Added
- Codex usage limits on the dashboard (#130)
  - The `rate_limits` inside the `token_count` events of
    `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` are read and drawn in the same
    chart shape as the Anthropic usage limits
  - `primary` / `secondary` are assigned to 5h/7d by `window_minutes` (under 24h
    counts as the short cycle)
  - `Claude` / `Codex` agent tabs at the top of the dashboard (shown only when
    both have data; with only one, that one is shown automatically)
  - The `UsageLimits` component was refactored for optional cycles and shows a
    placeholder for a cycle the plan does not support
  - plan_type is shown as a badge next to the heading (free, plus and so on)
- Detection of Codex hitting its rate limit (#130)
  - `credits.has_credits === false` raises a `rateLimitExceeded` flag, overrides
    the 5h cycle to 100% / exceeded and shows a red banner on the dashboard
  - This also handles OpenAI returning null for primary/secondary at the limit,
    which would otherwise make later rollout events display stale data

### Fixed
- Empty rate_limits events after a plan change (#130)
  - For example, the rollout right after upgrading free -> plus has null windows
    but an updated plan_type. The newest event with populated windows is tracked
    separately, so the graph data and the plan/credits data are obtained
    independently

## [0.1.99] - 2026-05-07

### Fixed
- Resuming a Codex session started it as a Claude session (#128)
  - `POST /sessions/:id/resume` and `POST /sessions/history/resume` were pinned
    to `claude -r`, so resuming a Codex session started claude
  - `AGENT_PROVIDERS` gained `resumeCommand`, and the command is composed through
    an `agentResumeCommand(agent, sessionId)` helper
  - Resuming an active session uses the agent detected in the tmux pane (with an
    override possible in the request body)
  - Resuming from history reads the request body's `agent` field
  - The frontend (App.tsx / SessionList.tsx) passes `session.agent` when calling
    the resume API

## [0.1.98] - 2026-05-07

### Added
- Codex (OpenAI) added as an agent provider (#127)
  - `agent: codex` can be specified when creating a session (claude by default)
  - An agent badge appears on the session list and metadata rows (lost sessions
    included)
  - Codex thread metadata (title, first prompt, git branch) is read from
    `~/.codex/state_5.sqlite` and displayed
  - Codex's context token usage is read by tailing the rollout file, matching
    Claude's metrics display
  - Duplicate detection was added for whether the same agent is already running
    in the same directory

## [0.1.97] - 2026-05-01

### Fixed
- Opus 4.5 / 4.6 / 4.7 were almost the same color in the Model Usage chart and
  could not be told apart
  - Opus 4.7 fell through `startsWith('Opus')` and got the same `bg-purple-500`
    as Opus 4.6
  - They are spread across hues now: Opus 4.5 `bg-fuchsia-500`, Opus 4.6
    `bg-violet-400`, Opus 4.7 `bg-indigo-500`

## [0.1.96] - 2026-05-01

### Fixed
- The session list's `ctx` indicator was always 100% (red) on macOS (#125)
  - `anthropic-models.ts` only read `~/.claude/.credentials.json`, so fetching
    `/v1/models` failed in newer Claude Code environments that store the token in
    the Keychain
  - As a result `contextMaxTokens` fell back to 200,000 and `contextPercent`
    saturated at 100 for a session whose real ceiling is much larger (Opus 4.7
    with a 1M context)
  - The file-then-Keychain token retrieval was collected into
    `utils/claude-credentials.ts` and is used by both `anthropic-models.ts` and
    `anthropic-usage.ts`
  - `anthropic-models.ts`'s User-Agent also became `cchub/<version>` (following
    the change made to `anthropic-usage.ts` in v0.1.93)
  - Linux already worked from `.credentials.json`, so its behavior is unchanged

## [0.1.95] - 2026-04-30

### Fixed
- The conversation history button was always disabled on macOS (#123)
  - `isClaudeProcess` did not recognize a Claude Code started from a non-standard
    path (`~/.local/bin/claude`, `/opt/homebrew/bin/claude` and so on), so the
    pane's `currentCommand` propagated as tmux's `pane_current_command` (a
    version number such as `2.1.123`)
  - `isClaudeProcess` now matches on the regex `/(?:^|\/)claude(?:\s|$)/`, which
    covers every pattern including a full-path launch
  - `buildSessionsList` uses the ps-based detection to normalize the pane-level
    `currentCommand` to `'claude'` too (it used to normalize only at the session
    level)
  - Linux behavior is unchanged (its `pane_current_command` already returns
    `claude` correctly)

## [0.1.94] - 2026-04-30

### Added
- Password storage in the macOS Keychain (#121)
  - The password passed to `cchub setup -P pass` is stored in the macOS Keychain
    (`service: cchub`) rather than embedded directly in
    `~/Library/LaunchAgents/com.cchub.server.plist`
  - Priority when `cchub` starts: the `-P` CLI argument, the `CCHUB_PASSWORD`
    environment variable, then the Keychain
  - The startup log says where the password came from (`(Keychain)` / `(env)`)
  - `cchub uninstall` removes the Keychain entry too
  - Existing installations remain compatible because the plist's `-P` is still
    used; migration to the Keychain happens automatically on the next
    `cchub setup -P pass`
  - Linux keeps the existing `EnvironmentFile` approach, as there is no reliable
    secret store for a headless service

### Fixed
- `cchub --help` always described `setup` as "systemd service setup"; it now
  says "Register service (systemd on Linux, launchd on macOS)"
- XML escaping was added to the launchd plist's string interpolation (so a
  password containing `<`, `>`, `&`, `"` or `'` cannot break the plist)

## [0.1.93] - 2026-04-30

### Fixed
- The session list's status display now works correctly on macOS (#119)
  - `/api/notify/hook-status` validates each of the four required events
    individually (Stop / PreToolUse / UserPromptSubmit /
    PostToolUse[AskUserQuestion])
  - The setup banner appears when anything is missing rather than only when
    nothing is configured
  - The setup prompt covers all four events and instructs Claude to preserve
    existing hooks such as `prompt-recorder.sh`
- The output of a manual `/recap` slash command reaches the session list
  - `readLastAwaySummary` was renamed to `readLastRecap`, and a
    `subtype:'local_command'` entry counts as a recap when the user entry right
    before it carries `<command-name>/recap</command-name>`
  - The newer of the automatic `away_summary` and a manual `/recap` wins
- Fixed `readLastLines` underestimating its buffer
  - It starts at 2KB per line rather than 200 bytes and retries at 4x when short
    (2K -> 8K -> 32K), falling back to reading the whole file
  - Claude Code's JSONL averages 2KB per line because of embedded tool results,
    so asking for `300` really read only about 28 lines
- `cchub status` crashed with `systemctl not found` on macOS
  - The OS is checked through `platform()`, and `darwin` uses
    `launchctl list com.cchub.server`, showing the PID and LastExitStatus

### Added
- Anthropic API usage fetch errors are shown on the dashboard
  - Messages per error kind (rate-limited / no-credentials / unauthorized /
    fetch-failed / unknown)
  - While rate limited, the cached value is shown with a
    `(showing cached value)` badge plus a countdown to the retry
  - The `Retry-After` header on a 429 is honored (clamped between 5 minutes and
    an hour)
- Support for reading the OAuth token from the macOS Keychain
  - Newer Claude Code stores credentials in the Keychain
    (`Claude Code-credentials`) rather than `~/.claude/.credentials.json`, so a
    fallback was added
- The `User-Agent` became `cchub/<version>` (the old `claude-code/2.0.32`
  impersonated Claude Code)
- DashboardPanel widens with the screen (xl: 420px, 2xl: 480px)

### Changed
- Added `.claude-user-prompts/`, `.playwright-mcp/` and top-level `*.png` to
  `.gitignore` (byproducts of local development)

## [0.1.92] - 2026-04-29

### Changed
- The conversation view's background follows the session theme color
  - The whole chat view (container, echo line, loading display) is colored to
    match the terminal background (pink / indigo / teal and so on)
  - It feels like one surface, and the theme follows a session switch

## [0.1.91] - 2026-04-29

### Added
- A conversation history view (chat mode) (#116)
  - A separate display mode replacing the terminal's xterm area with Claude's
    conversation history. `fs.watch` monitors the JSONL and updates in real time
    (150ms debounce)
  - The WebSocket protocol gained `subscribe-conversation` /
    `initial-conversation` / `conversation-update` / `unsubscribe-conversation`
  - A single icon toggle in the pane header switches terminal and conversation
    (enabled only while Claude is running)
  - The display mode is persisted per pane and per session in localStorage
    (surviving a split or a remount)
  - The "working" and "waiting for input" badges are unified on `indicatorState`
    (reflecting Claude's real state rather than the connection state)
- A lightbox for inline images
  - Images in the conversation and in tool results such as Read open full screen
    on a tap, and close on a background tap, the x button or Esc
- Font size adjustment in the conversation history
  - Pinch zoom or the font controls in the bottom left, persisted in localStorage
  - Only a small `Aa` trigger is shown normally, with the full controls appearing
    once it changes
- An input echo line
  - Characters sent from FloatingKeyboard / InputBar are shown prompt-style at
    the bottom of the conversation, so what is being typed is visible even when
    the destination (the terminal) is hidden
- An input form (desktop)
  - On a PC a textarea plus a send button appear below the conversation. Mobile
    reuses the Terminal InputBar and tablet the FloatingKeyboard

### Changed
- Higher information density in the conversation view (tighter message spacing,
  line height and margins throughout)
- The pane header's terminal/chat switch went from two icons to a single one
  showing the destination
- The close (x) and zoom buttons are hidden when there is only one pane
- Keyboard control while scrolling
  - Scrolling the conversation up hides the soft keyboard automatically to
    enlarge the visible area
  - Returning to the bottom shows it again (touch-driven with a 600ms cooldown,
    which prevents layout-shift oscillation)

## [0.1.90] - 2026-04-28

### Fixed
- The Copy Prompt button in FileViewer did not insert the prompt text into the
  input field on a mobile device (#114)
  - Restored the text injection path into InputBar, lost in the Terminal.tsx
    split refactor six weeks earlier
  - InputBar exposes `setText(text)` through forwardRef + useImperativeHandle

## [0.1.89] - 2026-04-27

### Changed
- The session card's recap text went from `text-zinc-400` (gray) to
  `text-amber-200` (pale amber), which reads better on a dark background and
  livens the card up
- The recap timestamp was nudged from `text-zinc-600` to `text-zinc-500`

## [0.1.88] - 2026-04-27

### Fixed
- `currentPath` / `panes` / `ccSummary` and others were missing from
  `/api/sessions`'s response on macOS (#110)
  - `ps -eo tty,args --no-headers` (GNU only) became `ps -A -o tty,args` with the
    header skipped in user space, which works on both BSD and GNU ps
  - `tmux list-panes`'s field separator changed from `\x1f` to the ASCII
    `||~~||` (working around 0x1f becoming `_` under macOS + Bun.spawn)

## [0.1.87] - 2026-04-27

### Changed
- The desktop header and pane header icons grew from 14-16px to 18px with padding
  from `p-1` to `p-1.5`, which is easier to see
- The pane header's title grew from `text-xs` (12px) to `text-base` (16px)

### Removed
- The yellow "clear cache and reload" button in the pane header (too easily
  confused with an ordinary reload)

## [0.1.86] - 2026-04-26

### Fixed
- A text file with an unknown extension could not be opened in the File Viewer
  and came back base64-encoded
  - A heuristic over NUL bytes and control characters decides, and anything
    text-like is returned as UTF-8
  - Binary files are still returned as base64

## [0.1.85] - 2026-04-26

### Fixed
- ConversationViewer showed "(no output)" when the Read tool returned an image
  - While parsing the jsonl, `type: "image"` blocks are extracted from a
    `tool_result`'s content array and the base64 image is shown inline

### Changed
- `formatRelativeTime` was collected into `frontend/src/utils/format.ts`,
  unifying the duplicate implementations in SessionList / SessionHistory /
  PromptSearch
- Relative times can be expressed in seconds (a `time.secondsAgo` key was added)
- Deleted the unused `UsageTracker` service, the `PromptSearch` component and the
  deprecated `getSessionIdFromTty` (-356 lines)
- The release skill moved to a PR-based flow, standardizing on a dedicated
  release branch (`release/vX.X.X`)

## [0.1.84] - 2026-04-25

### Fixed
- The bottom row buttons of the InputBar in Japanese input mode (history / file /
  clear / up / down / send) grew from `w-9` (36px) to `w-14` (56px)
  - They were hard to tap on a phone

## [0.1.83] - 2026-04-25

### Fixed
- Relative-path images (`![](docs/foo.png)` and the like) were broken in the File
  Viewer's Markdown preview
  - The `<img src>` was handed to the browser unchanged and resolved against the
    frontend's origin (`/docs/foo.png`), producing a 404
  - It is resolved relative to the Markdown file's directory and served through
    `/api/files/raw`
  - Absolute URLs (`http(s)://`, `data:`, `blob:` and so on) still pass through

### Added
- Screenshots in the README (a full tablet view, the session list, a mobile
  device) (`docs/images/`)

## [0.1.82] - 2026-04-25

### Changed
- The session list cards were compressed
  - The title and the path share a line (for example `home  /home/m0a`)
  - The recap timestamp (`2h ago` and the like) sits inline at the end of the
    recap text
  - The recap block's border, background and "RECAP" label were removed, leaving
    it flat
  - The last-prompt summary is hidden for a session showing a recap (the recap
    already contains it)

## [0.1.81] - 2026-04-25

### Added
- Claude Code's auto-recap (`away_summary`) appears on each session card in the
  list
  - The one-to-three sentence summary Claude Code generates automatically three
    minutes after the terminal loses focus ("what I am doing plus the next
    action") is shown at the top of the card
  - A `RECAP - 2h ago` label with a relative timestamp and the body (clamped to
    three lines)
  - A session with no recap shows nothing extra, only the existing last-prompt
    summary
  - Session search (the Ctrl+B filter) matches recap text too
  - It reads the `system/away_summary` entries from the end of
    `~/.claude/projects/<dir>/<session>.jsonl`, riding the existing jsonl read
    cache (5s TTL) at no extra cost

## [0.1.80] - 2026-04-25

### Refactored
- Dead code cleanup (-981 lines)
  - Deleted seven unused files: `UrlMenu.tsx`, `SessionListMini.tsx`,
    `SessionTabs.tsx`, `SessionTab.tsx`, `LanguageSwitcher.tsx`,
    `dashboard/CostEstimate.tsx`, `dashboard/LimitWarning.tsx`
  - Removed unused state, functions and props (Terminal/InputBar's dead URL menu
    state, `onReload`, `hideDashboardTab` and so on)
  - Removed unused imports (`Settings`, `PaneInfo`, `UrlMenu`, `symlink`)
  - Removed unused npm packages: `@xterm/addon-web-links`, `qrcode.react`
- No functional change. Sessions, dashboard and file browser were verified in dev

## [0.1.79] - 2026-04-25

### Fixed
- Claude Code's input prompts (permission, plan, AskUserQuestion and so on) did
  not appear after a WS reconnect
  - The "discard initial-content on reconnect" added in v0.1.78 had the side
    effect that a prompt UI arriving during the reconnect was never written to
    xterm, leaving the user unaware until they reloaded
  - `onInitialContent` is back to its v0.1.77 behavior and writes even when
    wasExpected=false. The clear sequence covers only the visible area (ESC[2J +
    ESC[H), so the user's scroll position is preserved
  - Duplicated scrollback returns with it, but the upstream
    [Claude Code TUI redraw bug](https://github.com/anthropics/claude-code/issues/49086)
    dominates, so it is accepted
- The CJK `rescaleOverlappingGlyphs: true` from v0.1.78 (overlapping characters)
  is kept

## [0.1.78] - 2026-04-25

### Fixed
- Two terminal display instabilities
  - **Duplicated scrollback**: on a WebSocket reconnect the old history and the
    new initial-content overlapped, so scrolling up showed the same output twice.
    A reconnect discards initial-content and leaves it to the live `%output`
  - **Overlapping CJK glyphs**: characters bled into the neighboring cell in
    mixed Japanese and ASCII output, resolved with
    `rescaleOverlappingGlyphs: true`

## [0.1.77] - 2026-04-24

### Fixed
- Context usage was measured incorrectly
  - A model's maximum context window moved from a hardcoded 200k to a dynamic
    fetch through Anthropic's `/v1/models` API
  - Fixes the 100% cap on Opus 4.7 (1M context), and now matches the `/context`
    command within 1%

### Changed
- Token usage went from output only to cumulative used (input + cache_creation +
  output)
  - cache_read is billed at 10% and is excluded, so the number is close to the
    real contribution toward the rate limit
  - The UI label changed from `out` to `used`, with the breakdown in the tooltip
    (in / cache_create / cache_read / out)

### Added
- A new `backend/src/services/anthropic-models.ts`
  - Calls `/v1/models` with the OAuth token and caches
    `model_id -> max_input_tokens` for 24 hours

## [0.1.76] - 2026-04-24

### Fixed
- Memory metrics work on macOS too
  - The `/proc`-dependent implementation was unified on
    `ps -A -o pid=,ppid=,rss=` (which works on both Linux and macOS)
  - A process-table cache with a 1-second TTL shares one `ps` spawn across
    sessions

## [0.1.75] - 2026-04-24

### Added
- Metrics on each card in the session list
  - **Context usage**: computed from the latest usage in the .jsonl and shown as
    a progress bar against a 200k maximum (green below 60%, amber 60-80%, red at
    80% or above)
  - **Memory usage**: the RSS total from walking the /proc tree from tmux's
    pane_pid
  - **Token usage**: cumulative output tokens from a full scan of the .jsonl
- An mtime+size cache answers in 56-83ms from the second call onward
- Supported on both desktop (SessionList) and mobile/tablet (SessionListMini)

### Changed
- A session card's summary and prompt went from `truncate` (one line plus an
  ellipsis) to `line-clamp-2` (two lines maximum), which reads better

## [0.1.74] - 2026-04-22

### Added
- Type checking through the TypeScript 7.0 beta (tsgo), about 6.8 times faster
  than tsc 5.9.3
- A `typecheck` script in each workspace, runnable together from the root with
  `bun run typecheck`
- A typecheck step in CI (`.github/workflows/test.yml`)

### Fixed
- 13 existing type errors in backend/frontend that had gone undetected
  - A lost narrow on `SessionState`, and missing required properties on a lost
    session
  - Optional chaining in test code
  - The frontend's CSS module declaration (`vite-env.d.ts`)
  - A missing `SessionResponse` type import
- `backend/tsconfig.json`: `bun-types` -> `bun` (matching `@types/bun`)

## [0.1.73] - 2026-04-12

### Added
- File Viewer: file upload and download (large files such as video included)
- `POST /files/upload` - multi-file upload with streaming writes (Bun.write)
- `GET /files/download` - download as an attachment, streamed (Bun.file)
- `GET /files/raw` - direct streaming of images, video and audio (Range requests
  supported)
- Video playback (MP4, WebM, MOV and so on) and audio playback (MP3, WAV, FLAC
  and so on) in the FileViewer
- Toast notifications for upload success and failure
- Upload and download buttons in the mobile layout too

### Fixed
- Large images were broken by the 1MB limit (they go through /files/raw
  streaming now)
- The server's maximum request body size was raised to 10GB
- Handled the File object reference being lost in a mobile PWA by converting to a
  Blob
- Video seeking and progressive playback (Range request / 206 Partial Content)
- The video player sizes itself to the screen (object-contain, playsInline)

## [0.1.65] - 2026-04-11

### Added
- The conversation viewer shows a description summary on a tool block (collapsed
  it reads like "Bash: what the command does")
- G2 Glasses: the description accompanies the tool name there too

## [0.1.64] - 2026-04-10

### Fixed
- Zombie WebSocket connections are detected and closed (a connection with no ping
  for 60 seconds)
- Handles the case where a device sleeping or the network dropping never fires a
  close event

## [0.1.63] - 2026-04-10

### Fixed
- Dashboard usage data did not appear when rate limited (429)
- The Anthropic usage API response is cached for 60 seconds, with a 5-minute
  backoff on a 429

## [0.1.62] - 2026-04-10

### Fixed
- The session indicator said "working" while it was waiting for permission or
  input
- The hook override TTL was unified at 24 hours (so the status no longer expires
  during a long wait on a permission prompt)
- A pending-tool state is detected from the jsonl (the badge appears even when a
  new tool_use is not yet recorded there)

### Added
- G2 Glasses: `requestContentAndWait` makes fetching terminal content more
  reliable

## [0.1.61] - 2026-04-09

### Added
- The glasses-upload skill (automating the build, upload and Beta promotion to
  EVEN Hub)

## [0.1.60] - 2026-04-09

### Fixed
- G2 Glasses: conversation pagination counts pages by lines throughout (fixing
  the last page being unreachable)

## [0.1.59] - 2026-04-09

### Added
- G2 Glasses: line-based pagination (character width detects CJK against ASCII
  automatically)
- G2 Glasses: multi-message display (short messages packed into seven lines)
- G2 Glasses: a swipe jumps by the number of messages displayed

### Changed
- G2 Glasses: borders removed from every container, with `borderWidth: 0` stated
  explicitly
- G2 Glasses: header and footer heights unified at 36px
- G2 Glasses: the session list is limited to seven lines (removing the scroll
  indicator)
- G2 Glasses: display.ts refactored (content helpers extracted, duplication
  removed)

## [0.1.58] - 2026-04-09

### Fixed
- G2 Glasses: messages containing only a tool result are skipped in the
  conversation, and consecutive assistant messages are merged
- G2 Glasses: text content is shown before tool calls
- G2 Glasses: tapping in conversation mode refreshes the conversation and
  reconnects the WS
- G2 Glasses: automatic re-subscribe after a WS reconnect
- G2 Glasses: the EVEN Hub SDK bridge initialization timeout was extended to five
  seconds
- G2 Glasses: the phone UI's WS diagnostics use a dynamic import, resolving an
  initialization-order error
- G2 Glasses: the localhost URL is set automatically in dev for the simulator

## [0.1.57] - 2026-04-08

### Fixed
- G2 Glasses: choice mode fetches the latest terminal screen through
  request-content
- G2 Glasses: re-sorting sessions no longer switches session unintentionally
- G2 Glasses: the fallback choices (y/n/skip) were removed

### Added
- G2 Glasses: WS diagnostics in the phone UI
- G2 Glasses: WS state and buffer display in the browser debug UI
- G2 Glasses: a requestContent method on ws-client

## [0.1.56] - 2026-04-08

### Changed
- Terminal.tsx was split from 2397 lines to 1151 (extracting InputBar,
  SelectionOverlay, UrlMenu, useSelectionMode and terminal-themes)

## [0.1.55] - 2026-04-08

### Changed
- The soft keyboard defaults to Japanese input mode
- The glasses app.json's package_id and permissions format was corrected to EVEN
  Hub's specification

## [0.1.54] - 2026-04-08

### Added
- Long-press text selection mode in a desktop browser (the same UX as tablet and
  phone)
- Dragging after a long press extends the selection in real time
- The S and E handles can be dragged with the mouse to fine-tune the selection
- The selection mode badge and the copy/cancel panel move automatically so they
  do not overlap the selection

### Fixed
- xterm.js changed the selection after the mouse was released (controlled through
  pointer-events)
- mouseup was not detected after dragging an S or E handle (the capture phase is
  used)

## [0.1.53] - 2026-04-08

### Changed
- `any` and `as` casts were removed and `ExtendedSessionResponse` is used
  consistently
- `buildSessionsList`'s return type went from `object[]` to
  `ExtendedSessionResponse[]`
- The Bun WebSocket handler is typed as `ServerWebSocket<MuxData>`
- CLAUDE.md's component list was synchronized with the real files

## [0.1.52] - 2026-04-08

### Added
- A delete button on a lost session (next to Resume)

## [0.1.51] - 2026-04-07

### Added
- **A G2 smart glasses companion app** (the `glasses/` workspace)
  - The session list (with status icons, selected by a ring swipe)
  - The conversation view (paging, refreshed by 3-second polling)
  - Choice mode (sending cursor keys to drive Claude Code's selection screen)
  - A phone settings screen (a CC Hub introduction, setup steps, URL entry with
    autocompletion)
  - LocalStorage sharing (configure on the phone and the glasses find and connect
    automatically)
  - Compact display of tool calls (`[Edit] path`, `[Bash] command` and so on)
- A `?last=N` parameter on the conversation API

## [0.1.49] - 2026-04-07

### Fixed
- Resuming a lost session with no ccSessionId

## [0.1.47] - 2026-04-06

### Changed
- The waitingForInput field was removed (unified on the hook-based indicator)

## [0.1.44] - 2026-04-05

### Fixed
- AskUserQuestion's PreToolUse shows the waiting_input status

## [0.1.42] - 2026-04-04

### Fixed
- Browser notifications for PreToolUse events are suppressed (status update only)

## [0.1.41] - 2026-04-04

### Changed
- The session indicator is driven by hook events alone (the jsonl/ps heuristics
  were removed)
  - PreToolUse / UserPromptSubmit -> processing
  - Stop / SubagentStop -> completed
  - PostToolUse (AskUserQuestion) -> waiting_input
- Added the PreToolUse and UserPromptSubmit hooks to `~/.claude/settings.json`

## [0.1.40] - 2026-04-04

### Changed
- Dropped the wchan analysis from ps (it is always do_epoll_wait on Node.js and
  says nothing)
- The session indicator moved to hook/jsonl
- The jsonl cache TTL went from 5s to 2s
- The processRunning map and its logic were deleted entirely (-81 lines)

## [0.1.39] - 2026-04-04

### Fixed
- `cchub update` updates the binary at the registered service path
- When the CLI binary and the service binary are at different paths, both are
  updated

## [0.1.38] - 2026-04-04

### Fixed
- A race condition that lost metadata (theme and title)
  - lastKnownSessions moved into its own file (last-known-sessions.json)
  - The snapshot written every five seconds no longer overwrites the metadata
    itself

### Changed
- Code health
  - Three frontend lint errors fixed (CSS parse, noImportantStyles,
    noUselessCatch)
  - Backend lint fixes (parseInt radix, unused parameter, optional chain)
  - zod unified (shared v3 -> v4) and duplicate local schemas removed
  - An isActive field added to listPanes
  - The old metadata files (session-themes.json, session-titles.json) are deleted
    automatically
- Closed the GitHub issues that were already done (#1, #2, #12, #47)

## [0.1.37] - 2026-04-04

### Fixed
- A lost session after a reboot no longer disappears on refresh
- Resuming a lost session carries the conversation over through `claude -r`

## [0.1.36] - 2026-04-04

### Added
- ccSessionId is stored for a lost session after a reboot
- Resuming a lost session carries the conversation over through `claude -r`

## [0.1.35] - 2026-04-04

### Fixed
- Desktop copy and paste (text selection, Ctrl+C/V, the right-click menu)
- Desktop font size changes (Ctrl+=/-/0)
- iPad safe-area-inset-top support
- Mouse tracking reset

### Changed
- CLAUDE.md and the README were fully updated (the WebSocket `/ws/mux`, and every
  service, API and component documented)

## [0.1.5] - 2026-03-20

### Changed
- Japanese input on a phone moved to a two-row layout (the input field takes the
  full width on top, with the buttons underneath)
- Button layout: history / file / ABC / clear on the left, cursor up and down
  plus send on the right
- Buttons enlarged to 44px touch targets

### Fixed
- Suppressed the unnecessary notification from the UserPromptSubmit hook

## [0.1.4] - 2026-03-20

### Changed
- The "Connecting" indication moved from a full-screen overlay to a small banner
  in the top left (so the terminal stays usable while connecting)

## [0.1.3] - 2026-03-20

### Fixed
- A long press in the file viewer brought up the browser's context menu
  (download / share / print)

## [0.1.2] - 2026-03-20

### Added
- Long-pressing a pane in the session list closes it (with a confirmation
  dialog)

### Fixed
- The pane operation APIs (close / focus / split / respawn) returned a 500 under
  zod v4

## [0.1.1] - 2026-03-19

### Fixed
- tmux control mode did not work on macOS (the PTY wrapper moved from `script` to
  `expect`)

## [0.1.0] - 2026-03-19

### Added
- Long-press text selection in the terminal (for touch devices)
  - A long press starts selection mode and dragging selects by character
  - The S and E handles adjust the selection by dragging
  - A preview panel of the selected text
  - Copy and Cancel buttons, with clipboard support

## [0.0.99] - 2026-03-19

### Added
- Copy Prompt in the FileViewer (select lines, add a comment, and it lands in the
  terminal's input field)
- A send button and a clear button for Japanese input (on both phone and tablet)
- A Source/Preview toggle for Markdown and HTML files

### Changed
- Line numbers are always visible in the FileViewer (word wrap included)
- The whole row is tappable for selection (not just the line number)
- The FloatingKeyboard is hidden while the FileViewer is shown on a tablet

## [0.0.98] - 2026-03-18

### Changed
- Major upgrades: zod 3 -> 4, @hono/zod-validator 0.5 -> 0.7
- Major upgrades: vite 6 -> 8, @vitejs/plugin-react 4 -> 6

## [0.0.97] - 2026-03-18

### Added
- Unit tests for the share-token service (18 tests)

### Changed
- Patch and minor dependency updates (hono, react, tailwindcss, i18next and
  others)

## [0.0.96] - 2026-03-18

### Removed
- The deprecated TabletLayout component (478 lines, already merged into
  DesktopLayout + isTablet)
- The unused isExternal field, the onReload prop and the legacy flat sessions
  array
- Migration code such as the `ext:` prefix normalization, the old localStorage
  key cleanup and the old pane type conversion

## [0.0.95] - 2026-03-18

### Fixed
- Syntax highlighting was sometimes missing in the file browser

## [0.0.94] - 2026-03-18

### Fixed
- Pressing `/` on the soft keyboard produced `?` (a long-press timer left behind
  by touch and mouse both firing)

## [0.0.93] - 2026-03-17

### Changed
- Japanese input on the tablet FloatingKeyboard matches the phone (a textarea,
  Enter twice to send, bracketed paste)

## [0.0.92] - 2026-03-17

### Added
- A history button for Japanese input on a phone (sharing history with the
  FloatingKeyboard)
- Multi-line editing for Japanese input on a phone (a textarea)
- Enter twice sends, and multiple lines are sent at once in bracketed paste mode

### Fixed
- Vertical scrolling was enabled on the viewer page

## [0.0.91] - 2026-03-16

### Fixed
- The terminal content at the bottom of the viewer page was invisible (vertical
  scrolling enabled)

## [0.0.90] - 2026-03-16

### Changed
- Funnel became on-demand: on when a share token is created, off when the last
  token disappears
- Automatic Funnel setup at startup was dropped (leftovers from a previous Funnel
  are cleaned up)

## [0.0.89] - 2026-03-16

### Added
- Automatic Tailscale Funnel setup: external exposure on port 8443 is configured
  when the server starts
- The share dialog's QR code and URL use the external Funnel URL automatically

### Fixed
- A port conflict between Funnel and the backend (it forwards through a separate
  port 8443)
- Fixed-width terminal rendering and font size adjustment on the ViewerPage

## [0.0.88] - 2026-03-16

### Added
- Presentation mode: a session can be shared through a read-only URL
- Share token management (create, list, revoke; up to five tokens per session,
  with an expiry)
- A share dialog with a QR code (desktop, tablet and mobile)
- A read-only WebSocket endpoint (`/ws/view/:token`) that blocks input
- Font size adjustment on the viewer's side (with no effect on the sharer's)
- Horizontal scrolling (so a tablet's wide screen can be viewed on a phone)
- Sharing outside the VPN through automatic Tailscale Funnel URL detection

## [0.0.87] - 2026-03-15

### Fixed
- The terminal could not be scrolled (the scrollback is sent to xterm.js on the
  initial connection)
- The Connecting overlay no longer blocks touch input

## [0.0.86] - 2026-03-14

### Fixed
- Larger touch targets and font sizes in the file browser (better on a phone)

## [0.0.85] - 2026-03-14

### Fixed
- Badges are unified on indicatorState (processing -> green cc, waiting_input ->
  yellow, idle -> nothing)

## [0.0.84] - 2026-03-14

### Fixed
- The idle state (UserInput/end_turn) is treated as completed, suppressing an
  unnecessary waiting-for-input badge

## [0.0.83] - 2026-03-14

### Added
- Phone: long-pressing a session opens a menu dialog (edit the title, change the
  theme, delete)
- Tablet: a custom title field in the menu dialog

### Fixed
- The scroll position is preserved across a WebSocket reconnect (the scrollback
  clear and scrollToBottom are skipped)
- The hook TTL for the processing state went from 30 seconds to 5 minutes
  (reducing false waiting-for-input displays)

## [0.0.82] - 2026-03-14

### Fixed
- Reduced terminal flicker and scroll resets on a WebSocket reconnect

## [0.0.81] - 2026-03-14

### Added
- Custom session titles are stored server-side (merged into
  session-metadata.json)
- The session list is shown full screen (like the file viewer)
- Session cards and history are a two-column grid on tablet and PC
- firstPrompt is always visible on tablet, and the summary spans several lines
- Better status detection through hooks (UserPromptSubmit, Stop,
  AskUserQuestion)

### Fixed
- A "waiting for permission" badge appears while a tool such as Bash waits for
  approval
- Custom titles appear in the phone session list
- `cchub notify` sends over HTTPS in dev
- History projects are sorted by path

## [0.0.29] - 2026-02-07

### Added

- **A git diff viewer** - a Claude/Git toggle in the file viewer's Changes tab
  - Git mode shows the working tree's changes through `git status --porcelain`
    and `git diff`
  - A segmented button switches between Claude's changes and git's (git by
    default)
  - List and tree display modes (saved in localStorage)
  - Clicking a file shows the unified diff in the existing DiffViewer
  - New APIs: `GET /api/files/git-changes/:workingDir`,
    `GET /api/files/git-diff/:workingDir`

- **Browser back gesture support** - navigation through history.back() in the
  FileViewer
  - It goes diff -> changes list -> browser view -> terminal
  - Implemented with `window.history.pushState` and the `popstate` event

### Fixed

- **Biome lint configuration** - a11y and style rules set to warn in
  `biome.json`
  - Eight a11y rules (`useButtonType`, `noSvgWithoutTitle`,
    `noStaticElementInteractions` and others) set to warn
  - `noExplicitAny`, `noNonNullAssertion`, `useExhaustiveDependencies` and
    others set to warn as well
  - Auto-fixable lint errors corrected in 16 backend and 14 frontend files
  - DesktopLayout.tsx: corrected the declaration order inside a `useEffect`
  - FloatingKeyboard.tsx: `getDefaultPosition` moved to module level

## [0.0.28] - 2026-02-07

### Added

- **A network latency monitor** - a real-time latency card on the dashboard
  - Two measurements: WebSocket ping/pong (every 10 seconds) and an API ping
    (every 30 seconds)
  - A CSS-based sparkline visualizes the last 30 data points
  - Color coded: green below 50ms, yellow 50-150ms, red above 150ms
  - While the WS is down the last measurement is shown dimmed (a pong within 20
    seconds counts as connected)

## [0.0.27] - 2026-02-07

### Performance

- **Sessions API latency down 48.6%** (70.84ms -> 36.39ms)
  - Duplicate `capture-pane` calls merged (two per session down to one)
  - The `ps` command batched (N calls down to one for Claude detection and
    process state across every TTY)
  - A 2-second TTL cache on `listSessions`
  - A 10-second TTL cache on the TTY-to-SessionID mapping
  - Duplicate fetch requests removed from the frontend's `useSessions`

- **Terminal WebSocket hot path optimized**
  - Removed the debug hex logging (an `Array.from` + `map` + `join` +
    `console.log` ran on every keystroke)
  - Added a 30-second grace period on PTY disconnect (so a tablet waking from
    sleep reconnects immediately)

### Added

- **A terminal latency benchmark suite** (`backend/tests/benchmark/`)
  - Four metrics: single-character echo RTT, command execution RTT, throughput
    and the Sessions API
  - p95/p99 percentile statistics

## [0.0.26] - 2026-02-06

### Added
- **An onboarding walkthrough** - a spotlight-style guide for first-time users
  - Supported on desktop, tablet and mobile
  - It explains the keyboard, split panes and the session list in order
  - A `beforeAction` pattern drives the UI automatically before an explanation
    (showing the keyboard, for instance)

- **Terminal refresh** - a lightweight recovery when the display breaks
  - Sends `tmux refresh-client -S` over the WebSocket
  - Refreshes automatically on a WebSocket reconnect

- **A split button per pane** - a split button in each pane header in desktop
  mode

### Changed
- **The hamburger menu is gone** - DesktopLayout's side panel overlay was
  dropped (merged into the session list sidebar inside PaneContainer)
- **A better sidebar resize handle** - a transparent overlay with a larger touch
  area (24px on a tablet)
- **The sidebar overlaps the terminal's edge** - which reduces the gap caused by
  xterm's fractional character width
- **Tab navigation auto-fits** - a smaller font plus truncation keeps it on one
  line in a narrow panel
- **The reload button reloads the whole page**

### Fixed
- Unnatural mobile terminal scrolling (thresholds adjusted, double scrolling
  removed)
- The keyboard onboarding did not appear on mobile
- Onboarding tooltips were hidden behind the navigation bar
- A better fallback when `clipboard.read` returns empty on paste
- Long project paths wrapped in the history list

## [0.0.25] - 2026-02-05

### Added
- **CLI internationalization**: Japanese and English for backend and CLI messages
  - The language is detected from the `LANG` / `LC_ALL` / `LC_MESSAGES`
    environment variables
  - A Japanese locale (`ja_*`) produces Japanese output, everything else English
  - The translation data is embedded for the single binary

### Changed
- Added an internationalization (i18n) section to CLAUDE.md

## [0.0.24] - 2026-02-05

### Added
- **Frontend internationalization**: full i18n through react-i18next
  - Japanese and English translations for every UI component
  - Automatic browser language detection through
    i18next-browser-languagedetector
  - A language switch button (EN/JA) in the UI
  - The setting is saved in localStorage (`cchub-language`)
  - Translation files: `frontend/src/i18n/locales/{en,ja}.json`

### Changed
- Dashboard status messages are generated in the frontend (so they can be
  translated)
- Hardcoded Japanese in every component was replaced by translation keys

## [0.0.23] - 2026-02-05

### Added
- **Conversation history search**
  - A search box in the History tab
  - Searches project names and user messages
  - Incremental search (SSE streaming)
  - Full-text search (across every user message)
  - Snippets around each match

## [0.0.22] - 2026-02-05

### Added
- **A VSCode-style tree file browser**
  - Directories expand and collapse
  - Subdirectories load lazily
  - Indentation by depth

- **Pane resizing in the file browser**
  - The divider between the left and right panes can be dragged
  - Mouse and touch both supported

- **Text selection**
  - Text can be selected in the Markdown preview
  - Text can be selected in the conversation viewer

### Fixed
- Images did not appear in the conversation viewer
  - Added an unauthenticated image endpoint at `/api/images/`
- The HTML preview refreshed periodically
  - The blob URL is memoized to stop the iframe from reloading
- The keyboard came to the front while the file browser was shown
  - The keyboard's z-index was adjusted
- Japanese IME input did not work correctly on desktop

## [0.0.21] - 2026-02-05

### Added
- **Session color themes**
  - A color theme per session (nine colors plus none)
  - Long-press in the session list to open the color menu
  - The terminal background follows the theme
  - The setting persists in `~/.cchub/session-themes.json`

- **Conversation viewer improvements**
  - A system-generated summary is distinguished as "System (Summary)"
  - Styled in amber so it is distinct from a real user message

### Changed
- **Mobile keyboard improvements**
  - A tap or long press shows the custom keyboard
  - The OS soft keyboard is prevented from opening
  - `inputmode="none"` is set on xterm's internal textarea

### Fixed
- A session theme change did not apply immediately on mobile

## [0.0.20] - 2026-02-05

### Added
- **Password authentication**
  - The `-P` option enables password authentication at server startup
  - Conditional auth middleware on every API endpoint
  - Token authentication on the WebSocket connection
  - A login form in the frontend

- **HTML file preview**
  - HTML files are previewed in an iframe in the file viewer

- **A development command**
  - `bun run dev:auth` - starts the dev environment with password
    authentication (password: devpass)

### Security
- API access control through JWT authentication
- WebSocket token verification
- An `authFetch` helper centralizes authenticated API calls

## [0.0.19] - 2026-02-04

### Added
- **Long-press deletion on desktop**
  - Long-press deletion in the session list works in a desktop browser
  - Added `onMouseDown` / `onMouseUp` / `onMouseLeave` events

### Changed
- **Better Claude Code detection**
  - A TTY process check that works on both macOS and Linux
  - `ps -t` confirms the `claude` process directly
  - The `pane_current_command` fallback was removed

### Fixed
- The undefined variable `pts` became `ttyName` (session matching had been
  failing)

### UI
- Desktop icon buttons enlarged (w-3 h-3 -> w-4 h-4)
- Fixed event propagation on buttons

## [0.0.18] - 2026-02-04

### Added
- **A version display on the dashboard**
  - The CC Hub version appears at the bottom of the screen

### Changed
- **Better version management**
  - package.json is the source of truth for the version
  - The hardcoded VERSION constant was removed

### UI
- The mobile bottom navigation bar is taller (better touch targets)

## [0.0.4] - 2026-02-01

### Added
- **A stronger CLI**
  - `--help` and `--version` options
  - `-p, --port` / `-H, --host` / `-P, --password` options
  - `cchub setup` - registers the systemd service
  - `cchub update` - automatic updates (through GitHub Releases)
  - `cchub status` - shows the service state

- **systemd integration**
  - The user service file is generated automatically
  - Automatic restart (`Restart=always`)
  - A daily update check (a timer)

### Changed
- Tailscale is required (always HTTPS)
- Configuration moved from environment variables to CLI arguments

### Removed
- Self-signed certificates (TLS=1)
- Custom certificates (TLS_CERT/TLS_KEY)
- Configuration through environment variables (PORT, HOST, TLS)

## [0.0.3] - 2026-02-01

### Added
- **A dashboard**
  - Usage limits (the 5-hour and 7-day cycles)
  - A limit-hit estimate (when the current pace reaches it)
  - Daily usage charts (message and session counts)
  - Per-model token usage (Opus against Sonnet)
  - An estimated cost

- **Session history**
  - A list of past Claude Code sessions
  - Grouped by project
  - The conversation contents
  - Resuming a session (`claude -r`)

- **A stronger conversation viewer**
  - Markdown rendering (tables and code blocks included)
  - Image support
  - Automatic refresh for an active session

- **Stronger session management**
  - PTY-based session matching (identifying several sessions in one directory)
  - A session state indicator (working / waiting for input / idle / done)
  - A session resume button

### Fixed
- Information from several Claude Code sessions in the same directory was mixed
  together

## [0.0.2] - 2026-02-01

### Added
- Binaries are uploaded to the GitHub Release automatically

## [0.0.1] - 2026-01-31

### Added
- Initial release
- Multi-session management
- A tablet-optimized UI
- A file viewer
- Change tracking
- TLS support (a self-signed certificate, Tailscale)
