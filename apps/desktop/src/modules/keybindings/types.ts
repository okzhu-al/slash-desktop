export type Scope = 'global' | 'editor';

export interface Keybinding {
    id: string;
    label: string;
    defaultKey: string;
    category: 'Global' | 'Editor';
    scope: Scope;
}

export interface CommandRegistry {
    [id: string]: Keybinding;
}

export type CommandHandler = () => void;
