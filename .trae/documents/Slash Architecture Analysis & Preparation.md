Based on the analysis of `Slash Tech Architecture.md` and the codebase, here is the comprehensive architectural overview and preparation for the next development phase.

## 1. System Architecture & Data Flow

### System Architecture Diagram
```mermaid
graph TD
    subgraph Frontend [Frontend (React + Zustand)]
        UI[UI Components] -->|shadcn/ui| Layout
        Layout --> Features
        Features -->|Editor/Sidebar| Hooks
        Hooks[Hook Suite] -->|IPC| Bridge
        
        subgraph Core_FE [Frontend Core]
            Cache
            FS_Store
            Para_Service
            Metadata
        end
        Features -.-> Core_FE
    end

    Bridge[Tauri Commands Interface] <-->|JSON| IPC[IPC Layer]

    subgraph Backend [Backend (Rust)]
        IPC --> Commands
        
        subgraph Command_Layer [Interface Layer]
            Cmd_AI[AI Commands]
            Cmd_DB[DB Commands]
            Cmd_FS[FS Commands]
            Cmd_Graph[Graph Commands]
        end
        
        Commands --> Core_BE
        
        subgraph Core_BE [Core Business Logic]
            AI_Orch[AI Orchestrator]
            DB_Mgr[DB Manager]
            Watcher[File Watcher]
            Rel_Eng[Relation Engine]
        end
        
        AI_Orch -->|Scheduler| Skills[AI Skills]
        Skills -->|HTTP| Ollama[Ollama Local LLM]
        
        DB_Mgr -->|SQL| SQLite[(SQLite DB)]
        Watcher -->|Events| Frontend_Events
        Rel_Eng -->|Extract| SQLite
    end
```

### Data Flow: Editor Save & AI Processing
```mermaid
sequenceDiagram
    participant U as User
    participant FE as Frontend (Editor)
    participant BE as Backend (Rust)
    participant DB as SQLite
    participant AI as AI Service

    U->>FE: Type Content
    FE->>FE: useSlashEditor (onUpdate)
    FE->>FE: useContentPersistence (Debounce)
    FE->>BE: command: save_note(content)
    
    rect rgb(20, 20, 40)
        Note right of BE: Transaction Start
        BE->>BE: Relation Extraction (Links/Tags)
        BE->>DB: Update Note & Relations
        BE->>BE: AI Orchestrator (Calc Delta)
    end
    
    alt Delta > 10% (Significant Change)
        BE->>AI: Trigger Auto-Tagging/Summary
        AI-->>BE: Return Metadata
        BE->>DB: Update Metadata
        BE->>FE: Emit "metadata-updated"
    else Delta < 10%
        BE->>AI: Update Embeddings Only
    end
    
    BE-->>FE: Save Success (Ack)
```

## 2. Functional Module Inventory

### Frontend Modules (`src/`)
| Module | Path | Status | Description |
|--------|------|--------|-------------|
| **Core** | `core/` | 🔒 Frozen | Infrastructure (Cache, FS, I18n, Para, Storage). |
| **Editor** | `features/editor/` | ⚡ Refactored | Main editor (TipTap), Hook Suite, Extensions. |
| **Sidebar** | `features/sidebar/` | Active | File tree, Navigation, Sort logic. |
| **Graph** | `features/graph/` | Active | Local/Global knowledge graph visualization. |
| **Settings** | `features/settings/` | Active | User configuration modal. |
| **Command** | `features/command-palette/` | Active | Quick action launcher. |

### Backend Modules (`src-tauri/src/`)
| Module | Path | Responsibilities |
|--------|------|------------------|
| **AI Cmds** | `commands/ai/` | Interface for AI skills, feedback, ghost links. |
| **AI Core** | `core/ai/` | Orchestrator, Scheduler, Policy, Skill implementations. |
| **DB Core** | `core/db/` | SQLite connection, Schema, Repository (CRUD). |
| **Watcher** | `core/watcher/` | File system monitoring, Sync logic. |
| **Relations**| `core/db/repository.rs` | Logic for extracting `[[links]]` and `Attribute::`. |

## 3. Key Technical Implementation Details

1.  **Relation Extraction**:
    -   Implemented in `repository.rs` and `relations.rs`.
    -   Parses Markdown AST to find `WikiLinks` and `Attribute:: Value` pairs.
    -   Updates `links` table in SQLite; supports bidirectional updates.

2.  **AI Orchestrator**:
    -   **Delta Strategy**: Calculates content diff percentage to decide AI tasks.
    -   **Three Tiers**:
        -   **Low**: Embedding update only.
        -   **High**: Auto-tagging, Summarization.
        -   **New**: Full analysis including Ghost Links.

3.  **File Watcher**:
    -   Runs in a separate thread (`core/watcher`).
    -   **Debounced** (200ms) to prevent partial write reads.
    -   **Sync**: Updates DB on external file changes and emits events to Frontend to refresh UI without reloading.

I have completed the architectural analysis and am ready to proceed with specific development tasks based on this foundation.