# Sync Propagation Fix Report

## Overview
Based on the architect's verdict (`docs/Architect/sync_propagation_verdict.md`), the core of the sync propagation failure was driven by a lethal intersection between the implementation of BUG22's path filter in Personal Sync and the omission of updating the team sync activation state (`team_sync_state.json`) after a "Promote to Team" operation. This effectively left newly promoted directories in a "No Man's Land" where neither Personal Sync nor Team Sync would track the paths. 

Three specific fixes were successfully implemented to resolve the synchronization deadlock and depth-truncation bugs.

## Implemented Fixes

### P0: Activate Team Sync Upon Promote
**File Modified:** `apps/desktop/src-tauri/src/commands/sync/promote.rs`
**Change:** Appended logic at the end of the `push_directory_to_vault` function to explicitly write the `target_vault_id` to `.slash/team_sync_state.json`. 
**Impact:** Ensures that once a directory is successfully promoted to a team vault, the background AutoSync engine is immediately made aware of the active team space and properly initiates the Team Sync cycle.

### P1: Auto Sync Fallback for `vault_id`
**File Modified:** `apps/desktop/src-tauri/src/commands/sync/team.rs`
**Change:** Updated `read_known_team_vault_id` to include a robust fallback mechanism. If `.slash/team_sync_state.json` is missing or empty, it will extract the `vault_id` directly from the actively mapped teams in `.slash/team_path_mappings.json`.
**Impact:** Provides an essential safety net for cases where `team_sync_state.json` is unexpectedly purged or missing, preventing the team synchronizer from silently ignoring active mapping states. 

### P2: Fix Homesteading Truncation Limit for Root Folders
**File Modified:** `apps/server/src/routes/sync/homestead.rs`
**Change:** In `process_homesteading`, changed the depth iteration `for depth in 2..parts.len()` to `for depth in 1..parts.len()`.
**Impact:** Corrects an issue where top-level root folders (e.g., PARA directories like `01_PROJECTS`) failed to have their access permissions explicitly registered and inherited. Ensures visibility and standard PULL access rights for non-admin users within top-level directories in team contexts.

## Outstanding Items
As dictated by the verdict document, the **403 Identity Conflict (P3)** issue, dealing with personal vault ownership upon entering a team via invite code, has been verified as a separate and discrete bug regarding auth persistence and mode transition conflicts. This issue will be tracked and resolved independently to maintain proper separation of concerns.

## Architect Errata & Amendments

### Architect Update: Reverting BUG22 Path Filter (Self-Correction)
**File Modified:** `apps/desktop/src-tauri/src/commands/sync/personal.rs`
**Change:** Removed the custom path filtering block from L56-L71. The code now correctly uses full directory scans `scan_directory_manifests(&root)` for Personal Sync, irrespective of what files are mapped to the Team Sync.
**Impact:** Eliminates the misidentified "boundary block" that excluded team-mapped files from Personal Sync. The architecture affirms that Personal Sync should encompass the entire local vault state, allowing Team Sync to overlay as a secondary synchronization loop. This resolves the true root cause, where files entered a "No Man's Land" due to overly aggressive path exclusion logic.
