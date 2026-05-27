import { CommandRegistry, Keybinding } from "./types";

export const COMMANDS: CommandRegistry = {
    // Global Category
    "app.new_note": {
        id: "app.new_note",
        label: "New Note",
        defaultKey: "Mod+N",
        category: "Global",
        scope: "global"
    },
    "app.new_folder": {
        id: "app.new_folder",
        label: "New Folder",
        defaultKey: "Mod+Shift+N",
        category: "Global",
        scope: "global"
    },

    // Editor Category
    "editor.bold": {
        id: "editor.bold",
        label: "Toggle Bold",
        defaultKey: "Mod+B",
        category: "Editor",
        scope: "editor"
    },
    "editor.italic": {
        id: "editor.italic",
        label: "Toggle Italic",
        defaultKey: "Mod+I",
        category: "Editor",
        scope: "editor"
    },
    "editor.code": {
        id: "editor.code",
        label: "Toggle Code",
        defaultKey: "Mod+E",
        category: "Editor",
        scope: "editor"
    },
    "editor.insert_table": {
        id: "editor.insert_table",
        label: "Insert Table",
        defaultKey: "Mod+Shift+T",
        category: "Editor",
        scope: "editor"
    },
    "editor.strike": {
        id: "editor.strike",
        label: "Toggle Strikethrough",
        defaultKey: "Mod+Shift+S",
        category: "Editor",
        scope: "editor"
    },
    "editor.highlight": {
        id: "editor.highlight",
        label: "Toggle Highlight",
        defaultKey: "Mod+Shift+H",
        category: "Editor",
        scope: "editor"
    },
    "editor.find": {
        id: "editor.find",
        label: "Find in Note",
        defaultKey: "Mod+F",
        category: "Editor",
        scope: "global"  // Global scope so it works regardless of focus
    },
    "editor.save": {
        id: "editor.save",
        label: "Force Save Note",
        defaultKey: "Mod+S",
        category: "Editor",
        scope: "editor"
    }
};

export const getCommandsByCategory = () => {
    const grouped: Record<string, Keybinding[]> = {};

    Object.values(COMMANDS).forEach(cmd => {
        if (!grouped[cmd.category]) {
            grouped[cmd.category] = [];
        }
        grouped[cmd.category].push(cmd);
    });

    return grouped;
};
