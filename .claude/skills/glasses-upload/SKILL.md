---
name: glasses-upload
description: Build the G2 glasses app and upload it to EVEN Hub. Triggers on "/glasses-upload", "upload the glasses app", "グラスアップロード", "ehpkアップロード", "グラスデプロイ".
---

# G2 Glasses EVEN Hub Upload

The app on EVEN Hub is **Hrdle** (Plugin ID `com.hrdle.glasses`). Its display
name is the same as the server's; "Glasses" only exists to tell them apart inside
the repository.

**The Plugin ID cannot be changed.** It appears read-only under Store listing ->
Project details in the Console, and only App name / tagline / icon / description /
privacy have an Edit. Changing the ID means taking the ehpk to "Upload package"
and **creating a new project**, which carries over neither the build history, nor
the testing group, nor the store listing.

## Workflow

1. **Bump the version**: increment `version` in `glasses/app.json` (patch)

2. **Build**:
   ```bash
   cd <repo>/glasses      # e.g. /home/m0a/repos/hrdle-work-1/glasses
   bun run build
   ```
   - The root is a bun workspace, so use `bun run build` rather than
     `npm run build`
   - There are several worktrees (hrdle-work-1/2/3) — use the `glasses/` of the
     repository you are working in

3. **Pack the ehpk**:
   ```bash
   bun run pack
   ```
   This produces `out.ehpk`. **It stops when the version in `app.json` and the
   one in the bundle disagree** — bumping without rebuilding produces the worst
   kind of drift, where Hub shows the new number while the device calls itself
   the old one (`glasses/scripts/pack.ts`).
   - `npx @evenrealities/evenhub-cli pack` fails with "Missing script" because
     npm reads the workspace's package.json. Use the `bunx evenhub` form.

4. **Commit** and open a PR (merge to main if appropriate):
   ```bash
   git checkout -b chore/glasses-build-vX.X.X origin/main
   git add glasses/app.json glasses/out.ehpk glasses/src/
   git commit -m "chore(glasses): build vX.X.X ehpk ..."
   git push -u origin chore/glasses-build-vX.X.X
   gh pr create --repo hrdle/hrdle --base main --title "..." --body "..."
   gh pr merge <number> --repo hrdle/hrdle --merge
   ```

5. **Open the app in EVEN Hub** (through agent-browser). **Both pages are
   reachable by URL** — no clicking through the project list:
   ```bash
   # the build list ("Builds" tab)
   agent-browser --session-name evenhub open https://hub.evenrealities.com/hub/com.hrdle.glasses
   # the review and publish panel ("Store listing" tab)
   agent-browser --session-name evenhub open https://hub.evenrealities.com/hub/com.hrdle.glasses/store-listing
   agent-browser --session-name evenhub set viewport 1280 800  # required: the default 393x852 (mobile) puts layout elements outside the viewport and clicks are ignored
   agent-browser --session-name evenhub wait --load networkidle
   ```
   - `/hub/com.hrdle.glasses/builds` is a 404. The build list is the project
     page itself
   - Skip the login if the session is already logged in
   - Otherwise: fill the "Email" textbox with `$EVENHUB_EMAIL`, press
     "Continue", fill the "Password" textbox with `$EVENHUB_PASSWORD`, press
     "Continue" (**a two-step flow**)
   - The credentials come from environment variables

6. **Read the state before touching anything.** What is Public, what is Beta,
   and whether a review is in flight decide the rest of this:
   ```bash
   agent-browser --session-name evenhub eval '(()=>{const t=document.body.innerText.replace(/\n+/g," | "); const i=t.indexOf("Public build"); return t.slice(i,i+240);})()'          # project page
   agent-browser --session-name evenhub eval '(()=>{const t=document.body.innerText.replace(/\n+/g," | "); const i=t.indexOf("Publish to hub"); return t.slice(i,i+240);})()'         # store listing
   ```
   Wrap every `eval` in an **IIFE**: the execution context persists between
   calls, so a bare `const x = ...` twice fails with "already been declared".

7. **Upload the build**:
   ```bash
   agent-browser --session-name evenhub find text "Upload a build" click
   sleep 3
   ```

   The file input is set through CDP (the modal is drag-and-drop based and an
   ordinary click does nothing). Getting the page's WS URL:
   ```bash
   # write /json/list to a file first (a shell wrapper can truncate stdout, so do not pipe it directly)
   PORT=$(agent-browser --session-name evenhub get cdp-url | sed -E 's|.*127.0.0.1:([0-9]+)/.*|\1|')
   curl -s http://127.0.0.1:$PORT/json/list > /tmp/cdp-list.json
   python3 -c "
   import json
   with open('/tmp/cdp-list.json') as f:
       data = json.load(f)
   for t in data:
       # pick the Hub tab by URL: other sessions' pages are on the same browser
       if t.get('type') == 'page' and 'evenrealities' in t.get('url', ''):
           print(t['webSocketDebuggerUrl'])
           break
   "
   ```

   Then setFileInputFiles over that PAGE_WS:
   ```python
   python3 << 'EOF'
   import json, asyncio, websockets

   PAGE_WS = "ws://127.0.0.1:<port>/devtools/page/<id>"

   async def main():
       async with websockets.connect(PAGE_WS, max_size=10*1024*1024) as ws:
           msg_id = 0
           async def send_cmd(method, params=None):
               nonlocal msg_id
               msg_id += 1
               await ws.send(json.dumps({'id': msg_id, 'method': method, 'params': params or {}}))
               while True:
                   resp = json.loads(await ws.recv())
                   if resp.get('id') == msg_id:
                       return resp

           await send_cmd('DOM.enable')
           doc = await send_cmd('DOM.getDocument', {'depth': -1})
           root = doc['result']['root']['nodeId']
           found = await send_cmd('DOM.querySelector', {'nodeId': root, 'selector': 'input[type=file]'})
           result = await send_cmd('DOM.setFileInputFiles', {
               'nodeId': found['result']['nodeId'],
               'files': ['<repo>/glasses/out.ehpk'],
           })
           print(f'Result: {json.dumps(result)}')

   asyncio.run(main())
   EOF
   ```

8. **Enter the changelog and submit**:
   ```bash
   sleep 3
   agent-browser --session-name evenhub snapshot -i               # the dialog is all the snapshot holds: "Change log", "Cancel", "Add build"
   agent-browser --session-name evenhub fill @eXX "what changed"  # Change log
   agent-browser --session-name evenhub click @eXX                # "Add build"
   agent-browser --session-name evenhub wait --load networkidle
   ```

   Take the textarea's ref from the snapshot. `find role textbox fill` does not
   reach it — it answers `Element not found` while `snapshot -i` lists the same
   field as `textbox "Change log"`.

   **Write it in English, and get it right the first time.** Everything typed
   into EVEN Hub — the changelog, the store description, the tagline — is prose
   we author for an audience that is not only us, so the same rule as commit
   messages and PR bodies applies (see CLAUDE.md). And it is **not editable
   after the build is added**: the panel renders the changelog as plain text
   with no textarea and no Edit control, so a wrong one stays on that build
   forever. v0.0.5 went up in Japanese and had to be left that way.

   **The field is capped at 500 characters and truncates silently.** `fill`
   reports success either way, so read the value back and check the length and
   the last sentence before pressing "Add build":

   ```bash
   agent-browser --session-name evenhub eval "(() => { const t = document.querySelector('textarea'); return {len: t.value.length, tail: t.value.slice(-60)} })()"
   ```

   A 620-character changelog for v0.0.11 arrived as 500 ending mid-word
   ("Separately, a co"). Caught before submitting, which is the only place it can
   be caught — combined with the rule above, an unchecked overflow is permanent.

   It caught two more people on 2026-08-06, in the same afternoon, both writing
   a changelog long enough to be worth writing. One read the field back and
   rewrote to 463; the other pressed "Add build" first and ended on
   `offered to yo`, and had to **delete the build and upload it again** — the
   only repair there is. Read it back. Writing three sentences instead of five
   is cheaper than either.

9. **Confirm**: the snapshot should show the new version as
   `"vX.X.X Uploaded N seconds ago Private"`

10. **Switch Beta over**:

    **A review in flight is not a reason to stop.** This used to say to halt
    after step 9 and ask, because whether moving Beta disturbed a review was
    undocumented and not a thing to find out on a submission that mattered. It
    was measured on 2026-08-07, deliberately, with the user's agreement to
    re-submit if it broke: v0.0.55 was In Review, v0.0.56 was uploaded and then
    promoted straight to Beta, and **the review did not move**. `Review status`
    still read `Submitted Aug 7, 2026 at 9:11 AM / In review / Awaiting
    review...`, to the character, and the project card still said
    `0.0.55 In Review`.

    The two are separate records, which is why: a build's
    `Private / Beta / Public` lives on the Builds tab, and the review is its own
    record under **Store listing -> Publish to hub**. The review is attached to
    the build that was submitted, not to whichever build is currently Beta.

    One thing does differ from the ordinary case below. **A build under review
    is not demoted to Private when it loses Beta** - v0.0.55 became
    `In Review` in the build list, keeping its review state, where v0.0.52 had
    gone to `Private`.

    **Promote the new build straight to Beta. Do not demote the old one first.**
    Measured on v0.0.53 (2026-08-06): promoting demotes the previous Beta by
    itself - v0.0.52 went to Private unasked. The demote-first path was the
    procedure here until then and it is worse in two ways: it is a step that
    buys nothing, and its confirmation is headed **`Delist this project from
    Even Hub?`** - a title that reads as though it is about the whole project
    while the body is scoped to the one build. Nobody should have to decide
    whether that dialog means what it says. `Promote this build to Beta?` names
    the build and the Beta group it is going to, and leaves nothing to guess.

    - Expand the new build (`"... Uploaded ... Private"`) in the build list with
      `agent-browser click`
    - Find its `Private` badge inside the expanded panel dynamically:
      ```bash
      agent-browser --session-name evenhub eval '(() => {
        const badges = Array.from(document.querySelectorAll("*"))
          .filter(e => e.textContent === "Private" && e.children.length === 0);
        return JSON.stringify(badges.map(b => {
          const r = b.getBoundingClientRect();
          return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
        }));
      })()'
      ```
      Of the coordinates returned, take the one **inside the panel** (x around
      800, near the center); a badge in a collapsed row sits around x=1200
    - Click the center (x+w/2, y+h/2) through
      `document.elementFromPoint(...)?.click()`:
      ```bash
      agent-browser --session-name evenhub eval '(() => { document.elementFromPoint(826, 267)?.click(); return "clicked"; })()'
      ```
    - snapshot, click the "Beta" ref, then click "Promote to Beta"
    - Confirm from the build list that the previous Beta now reads `Private`

    - A snapshot ref cannot click these badges — always use `elementFromPoint()`
    - The coordinates move with the viewport and the number of builds, so
      **always look them up dynamically** (never hardcode them)

11. **Publish what was approved, then submit the new build.** Everything here is
    the **Store listing** tab's `Publish to hub` panel, and it is a different
    record from the Beta switch above: a build's `Private / Beta / Public` lives
    on the build list, the review lives here and is attached to the build that
    was submitted.

    **The order is fixed** (the user's, 2026-08-14): promote the approved build
    to Public first, then submit the new one. A build cannot be swapped while a
    review is in flight — `Submit for review` fails with `Failed to submit /
    invalid parameter` and a reload restores the old submission — so anything
    already `In review` has to finish before the next one can go out. Read
    `Review status` before answering any question about what can be submitted.

    - **Ask before publishing.** Promotion changes what every user gets, and
      "approved" is not "the user wants it out today"
    - Press `Publish to Even Hub`, then `Select build` -> the build's row ->
      `Confirm` -> `Submit for review`
    - **The panel's controls sit below a 1280x800 viewport** (y around 950), and
      `find text "<label>" click` **reports `✓ Done` without pressing them**.
      Measured on 2026-08-15: `Publish to Even Hub` answered `✓ Done` three
      times, a reload still read `Approved`, and it looked like a broken button.
      Scroll it into view and click through the point:
      ```bash
      agent-browser --session-name evenhub eval '(()=>{const e=Array.from(document.querySelectorAll("*")).filter(x=>x.textContent.trim()==="Publish to Even Hub"&&x.children.length===0).pop(); e.scrollIntoView({block:"center"}); const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};})()'
      agent-browser --session-name evenhub eval '(()=>{ document.elementFromPoint(<x>,<y>)?.click(); return "clicked"; })()'
      ```
      Match on text with `children.length === 0` rather than on `button`:
      `Select build` is a `span`, so `querySelectorAll("button")` misses it
    - **`Publish to Even Hub` succeeded when the panel becomes
      `Select build / Submit for review`.** The promotion does not show in the
      DOM until a reload, and the panel's own version line keeps saying
      `Approved` in the meantime, so this is the signal to read
    - The build dialog is two steps: click the row, **check the icon**, then
      `Confirm`. Selection is carried by an icon and nothing else — chosen is
      `i-er:ic-checkbox-mark`, unchosen `i-er:ic-checkbox`; there is no `input`,
      `role` or `aria-selected`:
      ```bash
      agent-browser --session-name evenhub eval '(()=>{const d=document.querySelector("[role=dialog]"); return JSON.stringify(Array.from(d.querySelectorAll("span.iconify")).map(s=>s.className.toString()));})()'
      ```
    - **The `Private` badge the panel shows after selecting is not the build's
      Beta/Public state.** Check the build list instead
    - **`Submit for review` sends immediately** — no form, no confirmation.
      Read the selected version back before pressing it
    - Confirm afterwards with a reload: `Review status` should read
      `Submitted <time> / In review`
    - If a review comes back `Rejected`, do not promote and do not resubmit on
      your own — read the reason and tell the user (v0.0.48 failed on the colour
      of its screenshots)

12. **Close the browser**:
    ```bash
    agent-browser --session-name evenhub close
    ```

## The store listing rides along with the build

Editing the listing — app name, tagline, screenshots, description — is not a
separate act from shipping a build. The moment anything is edited, the
`Publish to hub` panel grows a `Listing information / Updated N ago / Basic Info
/ Preview / Description` line, and `Submit for review` sends the build **and
those edits together**.

That is why the panel locks: between a submission and its promotion, the `Edit`
controls for Basic info, Preview and Description are all `cursor-not-allowed`.
**Approval alone does not unlock them — the promotion does.** They look like
ordinary links while disabled, so a click that does nothing reads as a broken
page; the way to tell is

```bash
agent-browser --session-name evenhub eval '(()=>{const e=document.elementFromPoint(x,y); return (e?.className||"").toString().includes("cursor-not-allowed");})()'
```

**So the order for changing the listing is: promote → edit the listing → submit
the next build.** Miss that window and it waits a whole review round. Measured
on 2026-08-15 and again on 2026-08-16.

Field limits, all of which truncate silently:

| Field | Limit |
|---|---|
| App name | 20 |
| Tagline | 50 |
| Description | 2000 |
| Build changelog | 500 |

`fill` reports success either way, so **read the value back and check its
length** after every one of them. A tagline written at 62 characters arrived as
`...without openin`, and a changelog written at exactly 500 lost its last four
words — both caught only by reading back.

## While a review is in flight

- **The submitted build cannot be swapped.** `Submit for review` fails with
  `Failed to submit / invalid parameter` and a reload restores the old
  submission. There is no withdraw button either. Wait for `Approved`
- **Swapping it afterwards erases the previous build's approval record** from
  the panel — the approval is displayed against whichever build is selected,
  not kept per build
- Uploading a new ehpk and even promoting it to Beta does **not** disturb the
  review: it is attached to the submitted build, not to whatever is Beta

## When to stop at Beta

The usual run is upload → Beta → submit in one sitting. Stop at Beta and have
the build **worn** first when the change is one a browser cannot judge:

- the input is held differently (0.0.84's push-to-talk)
- a gesture is remapped
- anything whose cost is comfort rather than correctness

The simulator settles state transitions and nothing else. 0.0.84 is the worked
example: every screen and every transition checked out here, and the defect that
mattered — the first hold of each dictation being swallowed by a menu guard —
only existed for a finger that presses within a second of tapping. A tester who
pauses to set something up steps over it without noticing.

## The review watcher, and delegating a promotion

`evenhub-review-watch.timer` (every two hours) runs
`/home/m0a/linux/evenhub-review-watch.sh`, which reads `Review status` directly
and wakes a `claude -p` session only when there is something to decide. On
`Approved` it notifies the phone and asks, through `droidctl confirm`, whether
to promote. **No answer means no promotion.**

A same-status approval is re-raised every six hours (`remindedat`), because a
lingering `Approved` is itself proof nobody has acted — promotion makes the
whole `Review status` section disappear. Without that, an approval that was
missed once stayed silent indefinitely: v0.0.83 sat approved for two days behind
24 consecutive "already reported" ticks.

**To hand the promotion over for one build** — the user has said to take it all
the way to Public and does not want to be asked at 3am — add a paragraph to the
prompt inside that script naming the version, saying to skip `droidctl confirm`,
promote, and report afterwards with `droidctl notify`, and **saying to delete
that paragraph once promoted**. Done for v0.0.82 and v0.0.84. It is a paragraph
rather than a flag on purpose: it names one version, it explains itself to
whoever reads the script next, and it removes itself.

## Important Notes

- **Setting the viewport is required**: agent-browser defaults to 393x852
  (mobile), where the Hrdle detail page will not open and the Beta badge sits
  outside the viewport (x=1200+). Always `set viewport 1280 800` first
- **Use bun**: the root is a bun workspace, so `npm run build` and
  `npx evenhub pack` collide with the workspace package.json and fail. Use
  `bun run build` / `bun run pack` (`pack` checks the versions agree before
  handing off to the evenhub CLI)
- **The EVEN Hub CLI has no upload command**: browser automation is required
- **`--session-name evenhub` persists the session**: log in once and later runs
  skip it
- **The Beta badge cannot be driven by a snapshot ref**: use
  `elementFromPoint(x, y)?.click()`, with the coordinates found through
  `querySelectorAll` + `getBoundingClientRect`
- **A `✓ Done` from `find text ... click` is not proof the button was pressed.**
  Anything below the viewport goes unpressed and still reports success, so read
  the state back after every click that matters rather than trusting the return
  value
- **Fetch CDP `/json/list` through a file**: a shell wrapper can truncate stdout
  to `...(N bytes total)`. Redirect to `/tmp/cdp-list.json` and read it with
  python3 rather than piping
- **The browser session is shared with the other worktrees.** `--session-name
  evenhub` keeps it off the `default` session another agent may be driving, but
  two agents on `evenhub` still fight over one page — say so before starting a
  run that spans several minutes of clicking
- **EVEN Hub is the public web (`hub.evenrealities.com`)** — no Tailscale IP is
  involved (do not confuse it with the Hrdle server itself)
