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
the testing group, nor the store listing. (Done on 2026-07-29 for the cchub ->
hrdle rename; the old `com.m0a.cchubglasses` stays Private as a fallback.)

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

5. **Log in to EVEN Hub** (through agent-browser):
   ```bash
   agent-browser --session-name evenhub open https://hub.evenrealities.com/hub
   agent-browser --session-name evenhub wait --load networkidle
   agent-browser --session-name evenhub set viewport 1280 800  # required: the default 393x852 (mobile) puts layout elements outside the viewport and clicks are ignored
   agent-browser --session-name evenhub snapshot -i
   ```
   - Skip this if the session is already logged in
   - Otherwise: fill the "Email" textbox with `$EVENHUB_EMAIL`, press
     "Continue", fill the "Password" textbox with `$EVENHUB_PASSWORD`, press
     "Continue" (**a two-step flow**)
   - The credentials come from environment variables

6. **Open the app's detail page**:
   ```bash
   # click "Hrdle" (the URL does not change below a 1280x800 viewport)
   agent-browser --session-name evenhub click @eXX  # the ref for Hrdle in the snapshot
   agent-browser --session-name evenhub wait --load networkidle
   ```

7. **Upload the build**:
   ```bash
   agent-browser --session-name evenhub click @eXX  # the ref for "Upload a build"
   sleep 3
   ```

   The file input is set through CDP (the modal is drag-and-drop based and an
   ordinary click does nothing). Getting the page's WS URL:
   ```bash
   # write /json/list to a file first (a shell wrapper can truncate stdout, so do not pipe it directly)
   rtk proxy curl -s http://127.0.0.1:<port>/json/list > /tmp/cdp-list.json
   python3 -c "
   import json
   with open('/tmp/cdp-list.json') as f:
       data = json.load(f)
   for t in data:
       if t.get('type') == 'page':
           print(t['webSocketDebuggerUrl'])
           break
   "
   # the port comes from `agent-browser --session-name evenhub get cdp-url`
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
   agent-browser --session-name evenhub snapshot -i
   agent-browser --session-name evenhub fill @eXX "what changed"  # Change log
   agent-browser --session-name evenhub click @eXX                # "Add build"
   agent-browser --session-name evenhub wait --load networkidle
   ```

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

9. **Confirm**: the snapshot should show the new version as
   `"vX.X.X Uploaded N seconds ago Private"`

10. **Switch Beta over**:

    **Step A: put the current Beta build back to Private**
    - Expand the current Beta build (`"... Published ... Beta"`) in the build
      list with `agent-browser click`
    - Find the Beta badge inside the expanded panel dynamically:
      ```bash
      agent-browser --session-name evenhub eval '(() => {
        const badges = Array.from(document.querySelectorAll("*"))
          .filter(e => e.textContent === "Beta" && e.children.length === 0);
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
      agent-browser --session-name evenhub eval '(() => { document.elementFromPoint(826, 292)?.click(); return "clicked"; })()'
      ```
    - snapshot, click the "Private" ref, then click "Confirm"

    **Step B: promote the new build to Beta**
    - No reload is needed (continue straight on from A)
    - Expand the new build with a click
    - The same way, get the `"Private"` badge's coordinates inside the expanded
      panel and click through `elementFromPoint`
    - snapshot, click the "Beta" ref, then click "Promote to Beta"

    - A snapshot ref cannot click these badges — always use `elementFromPoint()`
    - The coordinates move with the viewport and the number of builds, so
      **always look them up dynamically** (never hardcode them)

11. **Close the browser**:
    ```bash
    agent-browser --session-name evenhub close
    ```

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
- **Fetch CDP `/json/list` through a file**: a shell wrapper can truncate stdout
  to `...(N bytes total)`. Redirect to `/tmp/cdp-list.json` and read it with
  python3 rather than piping
- **EVEN Hub is the public web (`hub.evenrealities.com`)** — no Tailscale IP is
  involved (do not confuse it with the Hrdle server itself)
