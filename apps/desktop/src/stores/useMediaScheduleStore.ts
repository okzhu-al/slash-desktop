import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export interface ScheduledTask {
    notePath: string;
    vaultPath: string;
    targetTimestampMs: number;
    visionConfig?: {
        baseUrl: string;
        apiKey: string;
        model: string;
    };
}

interface MediaScheduleState {
    scheduledTasks: Record<string, ScheduledTask>;
    processingTasks: Record<string, boolean>; // Keyed by notePath
    scheduleTask: (notePath: string, vaultPath: string, delayMinutes: number, visionConfig?: ScheduledTask['visionConfig']) => void;
    clearTask: (notePath: string) => void;
    setProcessing: (notePath: string, isProcessing: boolean) => void;
    tick: () => void;
}

export const useMediaScheduleStore = create<MediaScheduleState>((set, get) => ({
    scheduledTasks: {},
    processingTasks: {},
    
    scheduleTask: (notePath, vaultPath, delayMinutes, visionConfig) => {
        const targetTimestampMs = Date.now() + delayMinutes * 60 * 1000;
        set((state) => ({
            scheduledTasks: {
                ...state.scheduledTasks,
                [notePath]: { notePath, vaultPath, targetTimestampMs, visionConfig }
            }
        }));
    },

    clearTask: (notePath) => {
        set((state) => {
            const newTasks = { ...state.scheduledTasks };
            delete newTasks[notePath];
            return { scheduledTasks: newTasks };
        });
    },

    setProcessing: (notePath, isProcessing) => {
        set((state) => {
            const newTasks = { ...state.processingTasks };
            if (isProcessing) {
                newTasks[notePath] = true;
            } else {
                delete newTasks[notePath];
            }
            return { processingTasks: newTasks };
        });
    },

    tick: () => {
        const now = Date.now();
        const { scheduledTasks, clearTask, setProcessing } = get();
        
        Object.values(scheduledTasks).forEach(task => {
            if (now >= task.targetTimestampMs) {
                // Time reached! Remove from store, mark as processing, and trigger backend
                clearTask(task.notePath);
                setProcessing(task.notePath, true);
                
                const payload: any = { 
                    vaultPath: task.vaultPath,
                    notePath: task.notePath 
                };
                if (task.visionConfig) {
                    payload.visionBaseUrl = task.visionConfig.baseUrl;
                    payload.visionApiKey = task.visionConfig.apiKey;
                    payload.visionModel = task.visionConfig.model;
                }
                
                invoke('trigger_media_embedding', payload).then(() => {
                    setProcessing(task.notePath, false);
                    window.dispatchEvent(new CustomEvent('slash:media-pending-changed'));
                }).catch(e => {
                    console.error('[MediaScheduleStore] Failed to execute scheduled task:', e);
                    setProcessing(task.notePath, false);
                });
            }
        });
    }
}));

// Start the global clock
setInterval(() => {
    useMediaScheduleStore.getState().tick();
}, 1000);
