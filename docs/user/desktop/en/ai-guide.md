# AI Guide

> Status: Current
> Audience: Users
> Owner: Product
> Last reviewed: 2026-05-31

Slash AI is a local-first assistant. It can help summarize, tag, process selected text, discover related notes, and classify Inbox material. It does not silently move, delete, or rewrite your notes for you.

## What AI Can Do

- Suggest summaries.
- Suggest tags.
- Suggest note titles.
- Run AI Skills on selected text.
- Recommend related notes.
- Support semantic search and deep search.
- Suggest where a note should be filed.

AI output is a suggestion by default. Slash writes tags, summaries, titles, or file locations only after you confirm the change.

## Provider Types

Slash separates generation models from embedding models.

### Generation Models

Generation models power summaries, tags, AI Skills, classification, relation explanations, and other text generation tasks.

You can use:

- Local Ollama.
- Online OpenAI-compatible providers.

Online providers require a Base URL, model name, and API key. API keys are stored in the system Keychain rather than plain text configuration files.

### Embedding Model

Embeddings power semantic search, GhostLink candidate retrieval, folder vectors, and RAG indexes.

The current embedding model is local Ollama `bge-m3`. Even if you use an online provider for generation, semantic indexing still depends on local `bge-m3`.

## Quick Start: Local Ollama

1. Install and start Ollama.
2. Prepare a generation model in Ollama.
3. Open Slash settings.
4. Go to AI settings.
5. Select the local provider.
6. Configure Ollama host, port, and generation model.
7. Confirm that the connection status is healthy.

If model loading fails, confirm that Ollama is running. The default port is usually `11434`.

## Quick Start: Online Provider

1. Open Slash settings.
2. Go to AI settings.
3. Add an online provider.
4. Fill in Base URL, model name, and API key.
5. Save and activate the provider.

Online providers receive the relevant text for the task. Make sure you trust the provider and understand its privacy and billing terms.

## Folder-Level AI Configuration

You can assign a different generation provider or model to a folder. Slash searches upward from the current note for `.slash-folder.yml`.

Example:

```yaml
ai:
  provider: online
  model: gpt-4.1-mini
```

This only affects generation tasks. It does not change the local embedding model.

## AI Skills

AI Skills are commands that operate on selected text or the current note. They are useful for rewriting, extracting structure, summarizing, generating action items, or applying a custom workflow.

Typical flow:

1. Select text.
2. Open the `/` menu.
3. Choose an AI Skill.
4. Review the generated result.
5. Insert, replace, or discard the result.

## Summaries and Tags

Slash can suggest summaries and tags based on note content. Suggestions are visible in the note properties area. They become part of your note only after you accept or edit them.

## GhostLinks

GhostLinks are potential relationships between notes. Slash uses embeddings and context to find notes that may be related, then asks the generation model to explain the relationship.

You decide whether to confirm a suggested link.

## Smart Classification

Slash can help decide where Inbox notes belong in the PARA structure. It may suggest an existing folder or a new folder under a PARA root.

When the AI response is invalid or uncertain, Slash falls back to safer local candidates rather than silently applying a risky move.

## Privacy Notes

- Local Ollama generation stays on your machine.
- Online providers receive the content needed for the selected task.
- API keys are stored in the system Keychain.
- Embeddings currently depend on local Ollama `bge-m3`.
- AI suggestions should be reviewed before they change your Vault.

## Troubleshooting

If AI does not work:

- Confirm that the selected provider is active.
- For local mode, confirm that Ollama is running.
- Confirm that the generation model exists.
- Confirm that `bge-m3` is available for semantic features.
- For online mode, confirm the Base URL, model name, API key, and network access.
