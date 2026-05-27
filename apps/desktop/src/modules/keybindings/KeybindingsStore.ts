import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { COMMANDS } from './registry';

interface KeybindingsState {
    // Custom keybindings: commandId -> keyCombo
    customKeys: Record<string, string>;

    // Actions
    setCustomKey: (commandId: string, keyCombo: string) => void;
    resetKey: (commandId: string) => void;
    resetAllKeys: () => void;
    getEffectiveKey: (commandId: string) => string;
}

export const useKeybindingsStore = create<KeybindingsState>()(
    persist(
        (set, get) => ({
            customKeys: {},

            setCustomKey: (commandId: string, keyCombo: string) => {
                set(state => ({
                    customKeys: {
                        ...state.customKeys,
                        [commandId]: keyCombo
                    }
                }));
            },

            resetKey: (commandId: string) => {
                set(state => {
                    const { [commandId]: _, ...rest } = state.customKeys;
                    return { customKeys: rest };
                });
            },

            resetAllKeys: () => {
                set({ customKeys: {} });
            },

            getEffectiveKey: (commandId: string) => {
                const { customKeys } = get();
                const command = COMMANDS[commandId];
                if (!command) return '';
                return customKeys[commandId] || command.defaultKey;
            }
        }),
        {
            name: 'slash-keybindings'
        }
    )
);

// Helper to format key for display
export const formatKeyForDisplay = (key: string): string => {
    const isMac = navigator.platform.includes('Mac');
    return key
        .replace('Mod', isMac ? '⌘' : 'Ctrl')
        .replace('Alt', isMac ? '⌥' : 'Alt')
        .replace('Shift', isMac ? '⇧' : 'Shift');
};

// Helper to normalize captured key event
export const captureKeyCombo = (e: KeyboardEvent): string | null => {
    // Ignore modifier-only presses
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) {
        return null;
    }

    const parts: string[] = [];
    if (e.metaKey || e.ctrlKey) parts.push('Mod');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    // Normalize key
    let key = e.key.toUpperCase();
    if (key === ' ') key = 'SPACE';

    parts.push(key);
    return parts.join('+');
};
