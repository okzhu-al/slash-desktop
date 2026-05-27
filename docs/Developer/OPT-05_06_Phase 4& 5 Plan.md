# Phase 4 & 5: Zero-Shot Local Transcription + Embedding Media Semantic Weaving

This phase will replace the legacy `speech_recognition` + Google Web Speech API with an offline, high-precision, auto-language-detecting `faster-whisper` model. Furthermore, it will weave OCR and speech transcripts of media assets directly into the semantic embedding of notes, making AI search and GhostLink "media-aware".

## Proposed Changes

### apps/python-sidecar

Summary: Replace the unstable, network-dependent Google API with `faster-whisper` and route media directly to it.

#### [MODIFY] [requirements.txt](file:///Users/junior/Projects/slash/apps/python-sidecar/requirements.txt)
- Add `faster-whisper>=1.1.0`.

#### [MODIFY] [main.py](file:///Users/junior/Projects/slash/apps/python-sidecar/app/main.py)
- **Delete Monkey Patch**: Remove the `speech_recognition` dynamic patching logic (lines ~38-64).
- **Add Whisper Loader**: Introduce a singleton `get_whisper_model()` that lazily loads the `faster-whisper` "tiny" model.
- **Divert Media to Whisper**: In `/parse`, detect media extensions (`AUDIO_VIDEO_EXTENSIONS`) and route them explicitly to `get_whisper_model().transcribe()`. Return a `ParseResponse` immediately.
- **Context Cleanup**: Retain `audio_lang` input for logging purposes, but stop setting the `audio_lang_ctx` variable as faster-whisper natively detects the language.

---

### apps/desktop

Summary: Enhance the Rust AI embedding pipeline to recursively query the Sidecar for media texts and weave them into the note's semantic profile.

#### [MODIFY] [skills.rs](file:///Users/junior/Projects/slash/apps/desktop/src-tauri/src/commands/ai/skills.rs)
- **Regex Media Extraction**: Before invoking `service.generate_embedding()`, locate all inline media tags matching `!\[.*?\]\((assets/[^)]+)\)`.
- **Sidecar Synchronous Fetch**: Execute a POST request using `reqwest` to the local Sidecar `/parse` endpoint for each media file, extracting its markdown result.
- **Append and Weave**: Combine the base note text with a chunk (up to 2000 chars) of each media transcript under `[Media: filename]`, forming the `enriched_content` that goes into `generate_embedding`.

## Verification Plan

### Automated Tests
- Run `cargo check` and `npm run typecheck`.

### Manual Verification
1. **Local Transcription**: 
   - Turn off Wi-Fi and use ImportHub to upload an `.mp4` file. Verify that a Markdown file with a high-accuracy Chinese/English transcript is produced.
2. **Auto Language Detection**: 
   - Ensure importing files in different languages generates accurate transcripts with the `> **语言**: XX` metadata tag.
3. **Media-Aware Embedding**: 
   - Embed an audio/video file inside a markdown note.
   - Wait 5 seconds (triggering `on_idle` AI generation).
   - Check SQLite `embeddings_v2` to confirm the dimension matches and `is_embedded` flag is toggled. Test Semantic Search with words exclusive to the video's spoken dialogue to ensure it's successfully matched.
4. **Fallback Resilience**: 
   - Temporarily bring the Sidecar offline and ensure `trigger_ai_skill` still safely generates embeddings for the textual portion of the note without crashing.
