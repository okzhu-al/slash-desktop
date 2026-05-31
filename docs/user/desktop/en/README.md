# About Slash

> Status: Current
> Audience: Users
> Owner: Product
> Last reviewed: 2026-05-31

Slash is a local-first Markdown workspace for knowledge work. You can use it to write notes, organize reference material, manage tasks, search your vault, use AI-assisted organization and summarization, and connect to a self-hosted Slash Server when you need personal sync or team collaboration.

## Local First

Your core content lives in your own Vault.

- Notes are regular Markdown files.
- Images, videos, PDFs, and other assets are stored under the Vault `assets/` directory.
- You can still open and back up your files with other Markdown tools.
- Local indexes, task aggregation, and AI caches improve the experience, but they do not replace your Markdown files.

## Vault and PARA

Slash uses a Vault as the container for a knowledge base. A new Vault starts with PARA root folders:

- `00_Inbox`: quick capture and unsorted material.
- `01_Projects`: efforts with a goal and an expected end.
- `02_Areas`: ongoing responsibilities and standards.
- `03_Resources`: reference material, topics, interests, and reusable knowledge.
- `04_Archives`: completed or inactive material.

PARA is not a strict taxonomy. It is a decision rule: active outcomes go to Projects, ongoing responsibilities go to Areas, reusable references go to Resources, and inactive material goes to Archives.

## Editing and Organization

Slash provides a desktop workspace for long-form writing and repeated organization work:

- File tree and tabs.
- Markdown editor.
- WikiLink backlinks.
- Task lists and task metadata.
- Images, videos, PDFs, tables, code blocks, Mermaid diagrams, and drawing boards.
- Full-text search, task search, and semantic search.

## AI Assistance

Slash AI assists your work. It does not replace your judgment.

- Suggest summaries and tags.
- Run AI Skills on selected text.
- Recommend potential GhostLinks.
- Help classify Inbox notes.
- Support semantic search and knowledge discovery.

AI supports local Ollama and online OpenAI-compatible providers. Regardless of whether the generation model is local or online, semantic embedding currently depends on the local Ollama `bge-m3` model.

## Sync and Team Collaboration

You can use Slash completely offline. When you need multi-device sync or team collaboration, connect Slash Desktop to Slash Server.

Slash Server provides:

- Personal Vault sync.
- Team spaces.
- Team directory permissions.
- Comments, annotations, version history, and collaboration events.
- Collaboration edit locks when needed.

The current collaboration model is not real-time co-editing of the same paragraph. It is local-first editing with asynchronous sync, permissions, comments, annotations, and version tracking.

## Who Slash Is For

Slash is a good fit if you:

- Want to keep control of local Markdown files.
- Need to organize projects, references, and tasks over time.
- Want AI as an assistant rather than the owner of your knowledge base.
- Want self-hosted sync or a small-team knowledge workspace.

## Start Here

1. Create or open a Vault.
2. Put new material into `00_Inbox` first.
3. Move stable references to `03_Resources`.
4. Use links, tags, tasks, and AI suggestions as your workflow becomes clearer.

See also:

- [Input Guide](./input-guide.md)
- [AI Guide](./ai-guide.md)
