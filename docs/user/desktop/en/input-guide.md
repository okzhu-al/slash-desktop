# Input and Editing Guide

> Status: Current
> Audience: Users
> Owner: Slash
> Last reviewed: 2026-05-31

This guide covers common input patterns, Markdown syntax, and editing actions in the Slash editor.

## Slash Menu

Type `/` in the editor to open the quick command menu. Common commands include:

- Code block.
- Table.
- Drawing board.
- AI Skill.

## Text Formatting

| Format | Markdown | Shortcut |
| --- | --- | --- |
| Bold | `**text**` | macOS `Cmd+B`, Windows/Linux `Ctrl+B` |
| Italic | `*text*` | macOS `Cmd+I`, Windows/Linux `Ctrl+I` |
| Strikethrough | `~~text~~` | macOS `Cmd+Shift+S` |
| Highlight | `==text==` | macOS `Cmd+Shift+H` |
| Inline code | `` `code` `` | macOS `Cmd+E` |

When the cursor is at the end of formatted text, `Backspace` usually restores the Markdown source form so you can continue editing.

## Headings

Type `#` followed by a space at the beginning of a line:

```markdown
# Heading 1
## Heading 2
### Heading 3
```

Slash supports headings from H1 to H6.

## Lists

Slash supports ordered lists, unordered lists, task lists, and mixed nested lists.

| Type | Input |
| --- | --- |
| Unordered list | `- ` or `* ` |
| Ordered list | `1. ` |
| Task list | `[] ` or `【】 ` |

Common actions:

- `Enter`: create the next list item.
- `Tab`: indent the current list item.
- `Shift+Tab`: outdent the current list item.
- `Backspace` on an empty list item: exit the current list.

## Task Lists

Task lists can be written directly inside notes.

```markdown
[] Prepare release checklist
[] Review update notes
```

Click the checkbox to switch completion state. Tasks also appear in the task panel, where they can be reviewed and toggled.

Inside a task line, type two spaces to open the task metadata menu. You can insert date, assignee, priority, and other chips.

## Quotes

Type:

```markdown
> Quoted text
```

## Code Blocks

Use triple backticks:

````markdown
```ts
console.log("hello");
```
````

Use the copy button in the upper-right corner of a code block to copy its content.

## WikiLinks

Use double brackets to link notes:

```markdown
[[Project Plan]]
[[Project Plan#Milestones]]
```

Unresolved links can be created first and filled in later. Slash uses links to build backlinks and knowledge graph relationships.

## Media and Attachments

You can insert or drop images, videos, PDFs, and other files into notes. Assets are stored in the Vault, and notes keep Markdown references to them.

## PARA Workflow

For daily use:

- Put new material into `00_Inbox`.
- Move actionable work into `01_Projects`.
- Keep ongoing responsibilities in `02_Areas`.
- Store reusable references in `03_Resources`.
- Move inactive material to `04_Archives`.

Slash is designed to let you capture first and organize later.
