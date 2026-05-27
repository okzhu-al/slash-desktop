import { create } from 'zustand';
// Note: We use manual saveForVault/loadForVault for per-vault tab persistence
// instead of Zustand persist middleware to avoid cross-vault state conflicts

export interface Tab {
    id: string;          // Note path (unique identifier)
    title: string;       // Display title (filename without extension)
    isDirty: boolean;    // Has unsaved changes
}

interface TabsState {
    tabs: Tab[];
    activeTabId: string | null;

    // Actions
    openTab: (id: string, title: string) => void;
    closeTab: (id: string) => void;
    setActiveTab: (id: string) => void;
    updateTabTitle: (id: string, title: string) => void;
    renameTab: (oldId: string, newId: string, newTitle: string) => void;  // Rename tab (update ID and title)
    setTabDirty: (id: string, dirty: boolean) => void;
    closeAllTabs: () => void;
    closeOtherTabs: (id: string) => void;

    // Per-vault persistence
    saveForVault: (vaultPath: string) => void;
    loadForVault: (vaultPath: string) => void;
}

export const useTabsStore = create<TabsState>()((set, get) => ({
    tabs: [],
    activeTabId: null,

    openTab: (id: string, title: string) => {
        const { tabs } = get();
        const existingTab = tabs.find(t => t.id === id);

        if (existingTab) {
            // Tab already open - update title and activate
            set(state => ({
                activeTabId: id,
                tabs: state.tabs.map(t =>
                    t.id === id ? { ...t, title } : t
                ),
            }));
        } else {
            // Add new tab and activate it
            const newTab: Tab = { id, title, isDirty: false };
            set({
                tabs: [...tabs, newTab],
                activeTabId: id,
            });
        }
    },

    closeTab: (id: string) => {
        const { tabs, activeTabId } = get();
        const index = tabs.findIndex(t => t.id === id);
        if (index === -1) return;

        const newTabs = tabs.filter(t => t.id !== id);

        // Determine new active tab
        let newActiveId: string | null = null;
        if (activeTabId === id && newTabs.length > 0) {
            // Switch to adjacent tab
            const newIndex = Math.min(index, newTabs.length - 1);
            newActiveId = newTabs[newIndex].id;
        } else if (activeTabId !== id) {
            // Keep current active
            newActiveId = activeTabId;
        }

        set({
            tabs: newTabs,
            activeTabId: newActiveId,
        });
    },

    setActiveTab: (id: string) => {
        set({ activeTabId: id });
    },

    updateTabTitle: (id: string, title: string) => {
        set(state => ({
            tabs: state.tabs.map(t =>
                t.id === id ? { ...t, title } : t
            ),
        }));
    },

    renameTab: (oldId: string, newId: string, newTitle: string) => {
        const { tabs, activeTabId } = get();
        const existingTab = tabs.find(t => t.id === oldId);
        if (!existingTab) return;

        // Update the tab's ID and title, and update activeTabId if needed
        set({
            tabs: tabs.map(t =>
                t.id === oldId ? { ...t, id: newId, title: newTitle } : t
            ),
            activeTabId: activeTabId === oldId ? newId : activeTabId,
        });
    },

    setTabDirty: (id: string, dirty: boolean) => {
        set(state => ({
            tabs: state.tabs.map(t =>
                t.id === id ? { ...t, isDirty: dirty } : t
            ),
        }));
    },

    closeAllTabs: () => {
        set({ tabs: [], activeTabId: null });
    },

    closeOtherTabs: (id: string) => {
        const { tabs } = get();
        const tab = tabs.find(t => t.id === id);
        set({
            tabs: tab ? [tab] : [],
            activeTabId: tab ? id : null,
        });
    },

    // Save current tabs state for a specific vault
    saveForVault: (vaultPath: string) => {
        const { tabs, activeTabId } = get();
        const key = `slash-tabs-${btoa(encodeURIComponent(vaultPath)).replace(/=/g, '')}`;
        localStorage.setItem(key, JSON.stringify({ tabs, activeTabId }));
    },

    // Load tabs state for a specific vault
    loadForVault: (vaultPath: string) => {
        const key = `slash-tabs-${btoa(encodeURIComponent(vaultPath)).replace(/=/g, '')}`;
        const saved = localStorage.getItem(key);
        if (saved) {
            try {
                const { tabs, activeTabId } = JSON.parse(saved);
                set({ tabs: tabs || [], activeTabId: activeTabId || null });
            } catch {
                set({ tabs: [], activeTabId: null });
            }
        } else {
            set({ tabs: [], activeTabId: null });
        }
    },
}));
