# Phase 1: Dynamic Governance System Implementation

This plan outlines the steps to transition the Slash platform from a hard-coded 50MB team asset size limit to a dynamic, server-side configurable governance model.

## User Review Required

> [!IMPORTANT]
> - Are you okay with adding a new `settings.rs` route file for the Team API or should it go into `core.rs`? I plan to add it to `apps/server/src/routes/team/settings.rs` to keep `core.rs` clean.
> - The minimum and maximum limits for file size configuration will be 1MB and 10240MB (10GB) respectively.
> - In `TeamManagePage.tsx`, I'll add a new section in the "Storage Dashboard" tab (or general config area for Admins) to manage this setting.

## Proposed Changes

---

### Backend (Server)

#### [NEW] `apps/server/src/routes/team/settings.rs`
- Implement `get_team_settings` to read `max_sync_file_size_mb` from `server_settings` (defaulting to 50 if missing).
- Implement `update_team_settings` to UPSERT `max_sync_file_size_mb` into `server_settings` (Admin-only).

#### [MODIFY] `apps/server/src/routes/team.rs`
- Register `settings.rs` routes for GET and PUT `/api/team/settings`.

#### [MODIFY] `apps/server/src/routes/sync/negotiate.rs`
- In `negotiate`, fetch `max_sync_file_size_mb` from `server_settings`.
- Populate `server_capabilities` in the `SyncNegotiateResponse`.

---

### Shared Protocol

#### [MODIFY] `packages/slash-sync-proto/src/lib.rs`
- Add `ServerCapabilities` struct.
- Add `server_capabilities: Option<ServerCapabilities>` to `SyncNegotiateResponse` with `serde(default, skip_serializing_if = "Option::is_none")`.

#### [MODIFY] `packages/slash-core/src/lib.rs`
- Rename `TEAM_ASSET_MAX_SIZE` to `TEAM_ASSET_MAX_SIZE_DEFAULT` (50MB) to act as an offline fallback.

---

### Desktop App (Tauri/Rust)

#### [MODIFY] `apps/desktop/src-tauri/src/state.rs`
- Add `SyncCapabilitiesState` and `SyncCapabilities` structures initialized with `TEAM_ASSET_MAX_SIZE_DEFAULT`.

#### [MODIFY] `apps/desktop/src-tauri/src/lib.rs`
- Register `SyncCapabilitiesState` into Tauri's managed state.
- Register new command `get_sync_capabilities`.

#### [MODIFY] `apps/desktop/src-tauri/src/commands/sync/personal.rs` & `apps/desktop/src-tauri/src/commands/sync/team.rs`
- Extract `server_capabilities` from `negotiate_resp` and update `SyncCapabilitiesState`.
- Read from `SyncCapabilitiesState` for file size constraints instead of the hardcoded constant. (Fallback to `TEAM_ASSET_MAX_SIZE_DEFAULT`).

#### [MODIFY] `apps/desktop/src-tauri/src/commands/sync/promote.rs`
- Read limit from `SyncCapabilitiesState` during promotion scans, fallback to `TEAM_ASSET_MAX_SIZE_DEFAULT`.

---

### Frontend (React/TypeScript)

#### [NEW] `apps/desktop/src/core/sync/capabilities.ts`
- Implement `getMaxSyncFileSize()` wrapping the Tauri `get_sync_capabilities` command with caching.
- Add cache invalidator and `formatFileSize` helper.

#### [MODIFY] `apps/desktop/src/services/TeamService.ts`
- Add `getTeamSettings` and `updateTeamSettings` API wrappers.

#### [MODIFY] `apps/desktop/src/features/editor/utils/clipboardHandlers.ts`
- Replace hardcoded `50 * 1024 * 1024` with dynamic limits fetched via `await getMaxSyncFileSize()`.
- Update error toast content to use dynamic limit parameters.

#### [MODIFY] `apps/desktop/src/locales/zh-CN/common.json` & `apps/desktop/src/locales/en/common.json`
- Update `team_size_limit_block` to accept a `{{limit}}` parameter instead of hardcoding "50MB".

#### [MODIFY] `apps/desktop/src/features/team/TeamManagePage.tsx`
- Add a settings card for Admins in the storage dashboard (or a general settings section) to configure "Max Sync File Size (MB)".
- Hook up to `getTeamSettings` and `updateTeamSettings`.

---

## Verification Plan

### Automated/Manual Tests
- Build `slash-sync-proto` and `slash-core`.
- Run `cargo check -p slash`.
- Run `npm run typecheck`.
- Start the server and client.
- As an Admin, modify the sync limit in TeamManagePage from 50MB to 100MB. Refresh page to verify persistence.
- Drag and drop a file > 50MB but < 100MB into the editor in a Team Vault to verify the dynamic allowance.
- Drag and drop a file > 100MB to verify the dynamic interception and dynamic i18n error message.
- Verify Personal Vault remains unconstrained.
- Test offline behavior where limit should fallback to 50MB.
