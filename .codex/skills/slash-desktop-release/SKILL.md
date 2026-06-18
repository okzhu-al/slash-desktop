---
name: slash-desktop-release
description: Use when releasing Slash Desktop, repairing Slash updater metadata, recovering a partial desktop release, or deciding whether Slash Server changes require separate deployment. Enforces desktop/server release boundaries, GitHub Actions release flow, updater signature backfill, and online update.json verification.
---

# Slash Desktop Release

Use this skill for Slash Desktop releases and for fixing incomplete releases. The release is not complete until the online updater metadata is verified from `okzhu-al/slash-desktop/main/update.json`.

## Product Boundary

- Slash Desktop releases go through GitHub Actions and the `okzhu-al/slash-desktop` updater repository.
- Slash Server is separate. Server changes require the user to redeploy the server or sync the server mirror; do not deploy or publish server artifacts unless the user explicitly asks.
- If changed files include `apps/server/**`, server migrations, server Docker files, or shared server protocol changes, report that the Desktop release does not deploy those server changes.

## Success Standard

A Desktop release is successful only when all of these are true:

- The Slash main repo has the release commit and tag expected for the version.
- The `okzhu-al/slash-desktop` release assets exist for macOS and Windows.
- Both local `update.json` and `../slash-desktop/update.json` point at the target version.
- No updater signature is `__PENDING_SIGNATURE__`, copied from another version, empty, or mismatched with the asset filename.
- `scripts/verify-updater-metadata.py --version <version> --repo okzhu-al/slash-desktop --file <file>` passes for local metadata.
- The online raw file at `https://raw.githubusercontent.com/okzhu-al/slash-desktop/main/update.json` also passes the same verification.

Tag creation, GitHub Release creation, or uploaded assets alone are not enough.

## Normal Bugfix Discipline

Before any release decision:

1. Record the change in `docs/operations/beta-change-log.md` under the pending release section.
2. Run the relevant checks for the touched surface.
3. Commit the bugfix normally.
4. Only start the release flow when the user explicitly asks to publish a version.

If the worktree contains unrelated changes and the user did not explicitly say to publish all current changes, pause and ask for confirmation.

## Desktop Release Flow

1. Check status in both repositories:
   - `/Users/junior/Projects/slash`
   - `/Users/junior/Projects/slash-desktop`
2. Confirm the target version and release notes.
3. For a Desktop-only release, run the release script with server publishing disabled:
   - `scripts/release-desktop.sh -v <version> --skip-server`
4. Wait for GitHub Actions to finish building release assets.
5. Download the generated `.sig` assets for macOS and Windows.
6. Backfill signatures into both updater files:
   - `/Users/junior/Projects/slash/update.json`
   - `/Users/junior/Projects/slash-desktop/update.json`
7. Verify both updater files with `scripts/verify-updater-metadata.py`.
8. Commit and push `../slash-desktop/update.json` first so clients can discover the new version.
9. Fetch the online raw updater metadata and verify it.
10. Commit and push the main repo release/backfill changes.

## Partial Release Recovery

If the tag or GitHub Release already exists, do not recreate the tag. Recover the release by finishing the missing updater steps:

1. Inspect release assets and signature assets for the target version.
2. Download current `.sig` assets.
3. Replace pending or stale signatures in both updater files.
4. Run the verifier locally and against the online raw file after pushing `slash-desktop/main`.
5. Report the recovered version, mirror commit, main repo commit, and online verification result.

## Server Handling

When Desktop and Server changes are mixed:

- Use `--skip-server` for the Desktop release unless the user explicitly asks for a server publish/deploy.
- Tell the user that server changes are not live until the server is redeployed.
- For Slash Server releases, treat the task as a server deployment task, not a Desktop updater release. Verify server migrations and deployment state separately.

## Final Report

Report:

- Version released.
- Main repo commit and pushed branch.
- `slash-desktop` updater commit and pushed branch.
- GitHub release/tag status.
- Online updater verification result.
- Any server deployment reminder.

Never say the release is complete while online updater metadata is missing, stale, or unverifiable.
