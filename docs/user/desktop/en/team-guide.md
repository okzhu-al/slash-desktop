# Team and Sync Guide

> Status: Current
> Audience: Users
> Owner: Slash
> Last reviewed: 2026-05-31

This guide explains personal sync, team spaces, permissions, comments, annotations, versions, and collaboration behavior in Slash Desktop. Team features require Slash Server.

## Core Concepts

Slash can be used fully offline. When connected to Slash Server, it adds two major capabilities:

- Personal sync: sync your own Vault across devices.
- Team collaboration: share selected directories, files, comments, annotations, versions, and task states with team members.

Slash team collaboration is local-first and asynchronous. It is not real-time collaborative editing of the same paragraph.

## Connect to Server

1. Open Settings.
2. Go to Sync or Server connection settings.
3. Enter the server URL.
4. For first-time setup, enter the Access Code shown in the server logs.
5. Follow the app prompts to set a PIN.

New devices usually connect with the PIN. If you forget the PIN, use the app flow to regenerate an access code and check the Server logs.

For production, use HTTPS:

```text
https://slash.example.com
```

HTTP is acceptable for local or LAN testing. The packaged macOS app should use HTTPS for public production servers.

## Personal Sync

Personal sync is for using the same Vault across multiple devices.

Common synced content includes:

- Markdown notes.
- Images, videos, PDFs, and other assets.
- Note moves, renames, and deletes.
- Task checkbox states.

If sync fails, your local Vault content remains on disk. After the network or Server connection recovers, you can sync again.

## Team Spaces

Team spaces are shared knowledge bases. A team admin can create a team, invite members, and grant access to selected directories.

Common team actions include:

- Create a team.
- Invite members.
- Promote a personal directory into a team space.
- Assign permissions to team directories.
- Browse team directories, files, and activity.
- Manage team trash and storage usage.

Before promoting a directory, review its structure, names, and contents so private or unfinished material is not shared by mistake.

## Roles and Permissions

Slash team permissions combine global roles and directory roles.

| Role | Meaning |
| --- | --- |
| Admin | Manages the team, members, maintenance mode, team settings, and high-risk operations. |
| Owner | Manages an assigned directory and can usually edit, sync, and maintain its content. |
| TeamMember | Edits and syncs assigned team directories. |
| Observer | Can view allowed content, but is not a normal editing or syncing member for directories. |

The Server is the final permission authority. Client-side read-only states are a user experience safeguard, not the security boundary.

## Comments, Annotations, and Versions

Team files can use lightweight collaboration features:

- Comments: discuss file content.
- Annotations: leave feedback on a specific content range.
- Version history: review and restore previous versions when needed.
- Collaboration events: see team activity for files.

These features are tied to file identity rather than only to file paths, so they should follow the same file after a rename.

## Edit Locks

For protected team files, Slash uses edit locks to reduce overwrite risk.

- If you hold the lock, you can edit and sync.
- If another member holds the lock, the app shows the current state.
- When offline or when the network is unstable, Slash behaves more conservatively to avoid overwriting someone else's work.

This is not real-time multi-user editing. It is a protection model for asynchronous sync.

## Task Sync

Task checkboxes in team files can sync faster than the normal save cycle. When you mark a task done or undone, other members should usually see the state change sooner.

If multiple users edit the same task line at the same time, the Server protects consistency instead of guessing which line should be changed.

## Maintenance Mode

When an Admin reorganizes team directories, moves many files, or performs maintenance, they may enable maintenance mode. During maintenance, some sync or editing operations may be limited for regular members.

If you see a maintenance notice, wait for the admin to finish before doing heavy edits.

## Safety Tips

- Use HTTPS for team servers.
- Keep backups of important local Vaults.
- Review a directory before promoting it to a team space.
- Do not share PINs, Access Codes, or team account passwords with unrelated people.
- If sync behaves unexpectedly, do not delete local files first. Preserve the local state and contact the admin or report an issue.

## FAQ

### Is team collaboration real-time co-editing?

No. Slash currently uses local-first editing, asynchronous sync, permissions, comments, annotations, versions, and edit locks.

### Why can I see a directory but not edit or sync it?

You may be an Observer, or you may only have view access. Visibility and sync scope are not the same thing.

### What happens if I am removed from a team?

The client stops accessing that team space. Follow the app prompts and your team policy for any local content that already exists.

### Will a sync failure delete my local notes?

Normally no. Your content is primarily Markdown and asset files in your Vault. If sync fails, preserve the local state first, then check the connection, permissions, and Server status.
