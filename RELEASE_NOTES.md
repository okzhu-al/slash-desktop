## v0.1.3-beta.19

#### 中文

##### Bug 修复

- 修复长音频/视频媒体索引只保留前一小段转写文本的问题；旧的截断缓存会自动刷新为完整转写缓存。
- 修复 `m4v` 视频在桌面端与 sidecar 之间类型识别不一致，导致未进入本地 Whisper 转写流程的问题。
- 修复插入 `.m4a/.aac` 等音频附件时，占位节点触发 `_importing_*` 404，以及部分音频文件可能被误判为无引用后清理的问题。
- 修复 InputHub 导入音视频后，转写内容在正文和悬浮卡复制粘贴时表现为类似 `Shift+Enter` 软换行的问题。

#### English

##### Bug Fixes

- Fixed long audio/video media indexing keeping only a small initial portion of the transcript; legacy truncated caches are refreshed automatically.
- Fixed inconsistent `m4v` media detection between the desktop app and sidecar, which could skip the local Whisper transcription path.
- Fixed audio attachment imports such as `.m4a/.aac` triggering `_importing_*` 404s, and fixed some audio files being cleaned up after being misdetected as unreferenced.
- Fixed audio/video transcripts imported through InputHub using soft-line-break style formatting in the note body and when copied from the media hover card.
