import { create } from 'zustand';
import { normalizePath } from '@/shared/utils/pathUtils';
import { parseTeamNoteId } from '@/shared/utils/teamNoteIdentity';
// Note: We use manual saveForVault/loadForVault for per-vault tab persistence
// instead of Zustand persist middleware to avoid cross-vault state conflicts

export interface Tab {
    id: string;          // Note path (unique identifier)
    title: string;       // Display title (filename without extension)
    isDirty: boolean;    // Has unsaved changes
    fileId?: string | null; // Stable note identity when known
    teamPath?: string | null; // Current remote path for stable team note tabs
}

const normalizeTabId = (id: string): string => {
    if (id.startsWith('__folder__:')) {
        return `__folder__:${normalizePath(id.slice('__folder__:'.length))}`;
    }
    if (id.startsWith('__team__/')) {
        return `__team__/${normalizePath(id.slice('__team__/'.length))}`;
    }
    return normalizePath(id);
};

interface TabsState {
    tabs: Tab[];
    activeTabId: string | null;

    // Actions
    openTab: (id: string, title: string, fileId?: string | null, teamPath?: string | null) => void;
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

    openTab: (id: string, title: string, fileId?: string | null, teamPath?: string | null) => {
        const normalizedId = normalizeTabId(id);
        const { tabs } = get();
        const existingTab = tabs.find(t =>
            (fileId && t.fileId === fileId) || normalizeTabId(t.id) === normalizedId
        );

        if (existingTab) {
            // Tab already open - update title/path and activate
            set(state => ({
                activeTabId: normalizedId,
                tabs: state.tabs.map(t =>
                    t.id === existingTab.id
                        ? { ...t, id: normalizedId, title, fileId: fileId ?? t.fileId, teamPath: teamPath ?? t.teamPath }
                        : t
                ),
            }));
        } else {
            // Add new tab and activate it
            const newTab: Tab = { id: normalizedId, title, isDirty: false, fileId, teamPath };
            set({
                tabs: [...tabs, newTab],
                activeTabId: normalizedId,
            });
        }
    },

    closeTab: (id: string) => {
        const normalizedId = normalizeTabId(id);
        const { tabs, activeTabId } = get();
        const index = tabs.findIndex(t => normalizeTabId(t.id) === normalizedId);
        if (index === -1) return;
        const tabId = tabs[index].id;

        const newTabs = tabs.filter(t => t.id !== tabId);

        // Determine new active tab
        let newActiveId: string | null = null;
        if (activeTabId === tabId && newTabs.length > 0) {
            // Switch to adjacent tab
            const newIndex = Math.min(index, newTabs.length - 1);
            newActiveId = newTabs[newIndex].id;
        } else if (activeTabId !== tabId) {
            // Keep current active
            newActiveId = activeTabId;
        }

        set({
            tabs: newTabs,
            activeTabId: newActiveId,
        });
    },

    setActiveTab: (id: string) => {
        const normalizedId = normalizeTabId(id);
        const tab = get().tabs.find(t => normalizeTabId(t.id) === normalizedId);
        set({ activeTabId: tab?.id ?? normalizedId });
    },

    updateTabTitle: (id: string, title: string) => {
        const normalizedId = normalizeTabId(id);
        set(state => ({
            tabs: state.tabs.map(t =>
                normalizeTabId(t.id) === normalizedId ? { ...t, title } : t
            ),
        }));
    },

    renameTab: (oldId: string, newId: string, newTitle: string) => {
        const normalizedOldId = normalizeTabId(oldId);
        const normalizedNewId = normalizeTabId(newId);
        const { tabs, activeTabId } = get();
        const existingTab = tabs.find(t => normalizeTabId(t.id) === normalizedOldId);
        if (!existingTab) return;

        // Update the tab's ID and title, and update activeTabId if needed
        set({
            tabs: tabs.map(t =>
                t.id === existingTab.id ? { ...t, id: normalizedNewId, title: newTitle } : t
            ),
            activeTabId: activeTabId === existingTab.id ? normalizedNewId : activeTabId,
        });
    },

    setTabDirty: (id: string, dirty: boolean) => {
        const normalizedId = normalizeTabId(id);
        set(state => ({
            tabs: state.tabs.map(t =>
                normalizeTabId(t.id) === normalizedId ? { ...t, isDirty: dirty } : t
            ),
        }));
    },

    closeAllTabs: () => {
        set({ tabs: [], activeTabId: null });
    },

    closeOtherTabs: (id: string) => {
        const normalizedId = normalizeTabId(id);
        const { tabs } = get();
        const tab = tabs.find(t => normalizeTabId(t.id) === normalizedId);
        set({
            tabs: tab ? [tab] : [],
            activeTabId: tab ? tab.id : null,
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
                const normalizedTabs: Tab[] = [];
                for (const tab of (tabs || []) as Tab[]) {
                    const parsedTeamNote = parseTeamNoteId(tab.id);
                    if (parsedTeamNote.isTeamNote && !parsedTeamNote.isStable && !tab.fileId) {
                        continue;
                    }
                    const normalizedId = normalizeTabId(tab.id);
                    if (!normalizedTabs.some(t => t.id === normalizedId)) {
                        normalizedTabs.push({ ...tab, id: normalizedId });
                    }
                }
                const normalizedActiveTabId = activeTabId ? normalizeTabId(activeTabId) : null;
                set({
                    tabs: normalizedTabs,
                    activeTabId: normalizedTabs.some(t => t.id === normalizedActiveTabId)
                        ? normalizedActiveTabId
                        : normalizedTabs[0]?.id ?? null,
                });
            } catch {
                set({ tabs: [], activeTabId: null });
            }
        } else {
            set({ tabs: [], activeTabId: null });
        }
    },
}));
