# Phase 2 & 3: Path-based Handoff & Sidecar Path Direct Read

This plan addresses the OOM crashes when importing large files via the `ImportHub`. By shifting from a full-memory Blob upload via HTTP FormData to a zero-copy path-based handoff, both the Electron/Tauri frontend and the Python Sidecar memory footprints will be drastically reduced.

## User Review Required

> [!WARNING]
> **Sidecar Docker Mapping Constraint**
> As discussed in the instructions, passing an absolute host path (e.g., `/Users/junior/...`) to the Sidecar works perfectly if the Sidecar runs natively on the host (via Python). However, if the Sidecar is running inside a Docker container (via `docker-compose`), it cannot natively access the macOS file system unless the vault or the parent directory is explicitly mounted in `docker-compose.yml`. 
> I will proceed under the assumption stated in the instructions: **"路径天然可达，无需映射"** (paths are naturally reachable). If you are using Docker for the sidecar and encounter "File not found" errors, you may need to either add a volume mount in `docker-compose.yml` or run the sidecar locally via a Python virtual environment.

## Proposed Changes

---

### Desktop Frontend

#### [MODIFY] `apps/desktop/src/services/ImportService.ts`
- **Goal**: Prevent loading entire file buffers into the WebView.
- **Changes**:
  - In `importFile()`, remove `readFile(filePath)` and the creation of `Blob` / `FormData`.
  - Replace the `fetch` payload with a JSON string containing `local_path`, `filename`, `base_url`, `api_key`, `llm_model`, `audio_lang`, and `app_lang`.
  - Set the `Content-Type` header to `application/json`.
  - Remove the unused `readFile` import if no longer needed elsewhere in the file.

---

### Python Sidecar

#### [MODIFY] `apps/python-sidecar/app/main.py`
- **Goal**: Update the `/parse` endpoint to support both the new JSON payload (local path direct read) and the legacy FormData payload.
- **Changes**:
  - Change the `/parse` route signature to `async def parse(request: Request):`.
  - Check `request.headers.get("content-type", "")`.
  - **If `application/json`**:
    - Parse the JSON body.
    - Validate that `local_path` exists and points to a valid file on disk.
    - Read the file content directly using `Path(local_path).read_bytes()`.
    - Extract configuration flags (`base_url`, `llm_model`, etc.).
  - **If `multipart/form-data`**:
    - Parse the form data using `await request.form()`.
    - Extract the file using `form.get("file")` and read it.
    - Extract configuration flags from the form.
  - The rest of the `MarkItDown` processing logic will remain exactly the same.

## Verification Plan

### Automated Tests
- Run `npm run typecheck` in the `apps/desktop` directory to ensure no TypeScript compilation errors.
- Run `cargo check` in `apps/desktop/src-tauri`.

### Manual Verification
1. Import a very large file (>50MB) via the Desktop Client's Import Hub.
2. Confirm the file uploads instantaneously without UI freezes (OOM).
3. Ensure the Sidecar correctly detects `[PATH MODE]` and successfully processes the file.
4. Verify that legacy FormData uploads (e.g., via `curl`) still work.
