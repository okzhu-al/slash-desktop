# Role: Antigravity (Senior Tauri/React Engineer)

## Context

I am the Product Owner (Boss). You are the Lead Developer.
We are building "Slash", a local-first Markdown note-taking app using Tauri v2, React, TypeScript, and TipTap.

## Input Documents

Please read the following two specifications carefully (I will provide them/They are in the context):

1. **Slash Tech Architecture**: Defines the directory structure, modularity rules, and i18n strategy.

2. **Slash MVP PRD**: Defines the functional requirements, specifically the file system logic and Slash menu features.

## Your Mission

Initialize the project scaffold and build the MVP Phase 1.

## Execution Steps (Chain of Thought)

**Step 1: Initialization & Configuration**

1. Initialize the Tauri project using `npm create tauri-app@latest` with React/TS.

2. Install ALL dependencies listed in the PRD (TipTap, Radix UI, i18next, etc.).

3. Configure `vite.config.ts` and `tsconfig.json` to support absolute imports (path aliases) matching the Architecture document (e.g., `@/features`, `@/core`).

4. CRITICAL: Set up the `src` directory structure EXACTLY as described in the Architecture doc. Do not use default React structures.

**Step 2: Core Foundation (The "Engine")**

1. Initialize `i18next` configuration in `src/core/i18n`.

2. Implement the `FileSystemNoteRepository` in `src/core/storage`. Ensure it handles the default directory logic (`~/Documents/Slash`) described in the PRD.

3. Set up the `Layout` component using a Sidebar (Left) and Editor Area (Center).

**Step 3: The Editor Feature**

1. Create the `Editor` component in `src/features/editor` using TipTap.

2. Implement the `SlashMenu` floating component.

3. Configure the extensions for Markdown, Mermaid, and Math (Katex).

4. Implement the "Auto-save" hook.

## Constraints & Rules (DO NOT IGNORE)

1. **No "Spaghetti Code"**: Strictly follow the module isolation rules. `features` cannot import other `features` directly.

2. **Day 1 i18n**: No hardcoded strings. Every text must use `t('key')`.

3. **UI Library**: Use `shadcn/ui` (Radix+Tailwind) for all generic UI components.

4. **Storage**: Ensure `turndown` service is configured to handle HTML->Markdown conversion cleanly, especially for tables and formulas.

## Action

Start by executing Step 1 (Scaffolding & Structure). Show me the directory tree and package.json before moving to actual code implementation.