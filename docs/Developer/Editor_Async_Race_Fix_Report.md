# Editor Async Race Fix (BUG21v2) Report

## Overview
This report documents the resolution of a critical data-integrity defect (BUG21 Regression) regarding the `editor` frontmatter property. The defect triggered a false claim of ownership when invited team members (such as "Lucia") opened a team note (created by "Join") strictly due to an asynchronous hydration race condition during React's component mounting lifecycle.

Because the `useIsTeamNote` hook inherently relied upon an asynchronous I/O read of `team_path_mappings.json`, the initial evaluation of `isTeamNoteRef` defaulted to `false`. Consequently, if an auto-save was triggered (or the user immediately typed a character) before the network/disk I/O resolved (usually occurring around a 150-200ms latency window), the persistence logic falsely identified the note as a "Personal Space Note" and forcefully hijacked the `editor` field, stripping the document of its original author ownership credentials.

## Implemented Fix

**File Modified:** `apps/desktop/src/features/editor/hooks/useContentPersistence.ts`

### Double Signal Fallback Mechanism
Rather than converting the persistence hook into an asynchronous block (which introduces cascading UI lockup issues), the solution integrates a synchronously available metric native to the Markdown frontmatter structure: the `doc_status` attribute.

Because personal space notes organically lack the `doc_status` property during typical generation, whereas team notes strictly implement `'solo'` or `'collab'` markers, this property is a deterministic sync validation anchor.

```typescript
// 🛡️ BUG21-v2: 双重信号判定 — 异步 isTeamNote + 同步 doc_status 兜底
// doc_status 仅存在于团队文件（solo/collab），个人文件无此字段
const effectiveIsTeamNote = isTeamNoteRef.current || !!mergedMeta.doc_status;
```

By substituting raw dependency on `!isTeamNoteRef.current` with the resilient `!effectiveIsTeamNote`, the system successfully avoids erroneous personal space fallbacks globally.

## Impact & Verification
- **Ownership Lock Secured**: Active team documents reliably route to the `contributors` array logic rather than aggressively usurping the `editor` namespace when modified prior to hydration.
- **Asynchronous Decoupling**: File writes no longer exhibit extreme vulnerability to localized I/O performance or processor stalling. Re-hydration lag seamlessly proxies back onto instantaneous state availability.
- **Architect Status**: V2 Double-Signal Codebase implementation successfully verified and merged.
