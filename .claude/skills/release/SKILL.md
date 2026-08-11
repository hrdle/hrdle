---
name: release
description: Run the Hrdle release procedure - version bump, release PR, tag push, GitHub Release check, waiting for CI, and `hrdle update`. Triggers on "/release", "release", "リリースして", "リリース", "バージョンアップ".
---

# Hrdle Release

## Release Workflow

1. **Confirm you are current**: `git fetch origin`, and check the current branch
   sits directly on top of origin/main
2. **Create the release branch**: `git checkout -b release/vX.X.X` (never push a
   working branch such as `work-1` directly)
3. **Update CHANGELOG.md**: add the new version's entry at the top
   (Added/Fixed/Changed sections)
4. **Bump the version**: increment the `version` field in the root
   `package.json` (patch)
5. **Update the architecture docs**: run
   `python3 scripts/build-architecture-html.py`
   - syncs `version` / `generated` in `architecture.json` with `package.json`
   - re-embeds the JSON into `architecture.html`
   - stage both outputs together as `architecture.json architecture.html`
6. **Commit and push**:
   ```bash
   git add package.json CHANGELOG.md architecture.json architecture.html
   git commit -m "chore: bump version to X.X.X"
   git push -u origin release/vX.X.X
   ```
7. **Open and merge the PR**:
   ```bash
   gh pr create --repo hrdle/hrdle --base main --head release/vX.X.X --title "Release vX.X.X" --body "..."
   gh pr merge <number> --repo hrdle/hrdle --merge  # keeps history; --squash if needed
   ```
   Confirm the merge before moving on (`gh pr view --json state`)
8. **Tag and push**:
   ```bash
   git fetch origin --prune
   git merge --ff-only origin/main
   git tag vX.X.X
   git push origin vX.X.X
   ```
9. **Check the GitHub Release**:
   pushing the tag makes the Release workflow create the GitHub Release. Check
   for an existing one first and create it by hand only if it is missing.
   ```bash
   gh release view vX.X.X --repo hrdle/hrdle --json url,name,tagName,isDraft,isPrerelease,publishedAt
   # only if no release exists:
   gh release create vX.X.X --repo hrdle/hrdle --title "vX.X.X" --notes "release notes"
   ```
10. **Wait for CI**: `gh run list --repo hrdle/hrdle --limit 3`. CI builds the
    binaries, so `bun run build:binary` locally is **never** needed
11. **Update production**: run `hrdle update`
12. **Clean up the branch**: return to this worktree's branch (`work-2`, for
    example) and bring it current with `git merge --ff-only origin/main`. Do not
    hardcode another worktree's branch name such as `work-1`.

## Important Rules

- **Never build the binary locally** — CI builds it and attaches it to the
  release
- **Always pass `--repo hrdle/hrdle` to `gh`.** There is one remote and it is
  the right one, so this is belt and braces rather than a fix - but it costs
  nothing and it is the habit that survives someone adding a second remote.
  A `gh pr create` resolving to the wrong one is the cheap failure; the
  expensive one is `main` force-pushed to another repository's history.

  Tags do not move, so that is recoverable: find the newest release tag, check
  every worktree for anything newer (`git merge-base --is-ancestor`), and
  restore with `git push origin <sha>:main --force-with-lease` so a concurrent
  write cannot be clobbered in the fixing.
- Versions are semver patch by default (0.0.41 -> 0.0.42)
- Ask the user before a major or minor bump
- Keep the release notes short and factual

## Release Notes Format

```
## Changes
- feat: what the new feature does
- fix: what the bug was
- chore: everything else

## Notes
Anything worth calling out
```

Write the notes from the recent commit log
(`git log --oneline origin/main~10..origin/main`).
