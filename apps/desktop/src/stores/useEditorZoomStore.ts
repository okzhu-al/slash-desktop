import { create } from 'zustand';

interface EditorZoomState {
    zoomLevel: number;
    zoomIn: () => void;
    zoomOut: () => void;
    zoomBy: (delta: number) => void;
    resetZoom: () => void;
    setZoomLevel: (level: number) => void;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3.0;
const ZOOM_STEP = 0.1;

export const useEditorZoomStore = create<EditorZoomState>((set) => ({
    zoomLevel: parseFloat(localStorage.getItem('editor_zoom_level') || '1.0') || 1.0,
    
    setZoomLevel: (level: number) => {
        const newLevel = Math.min(Math.max(level, MIN_ZOOM), MAX_ZOOM);
        localStorage.setItem('editor_zoom_level', newLevel.toString());
        set({ zoomLevel: newLevel });
    },
    
    zoomBy: (delta: number) => {
        set((state) => {
            const newLevel = Math.min(Math.max(state.zoomLevel + delta, MIN_ZOOM), MAX_ZOOM);
            localStorage.setItem('editor_zoom_level', newLevel.toString());
            return { zoomLevel: newLevel };
        });
    },
    
    zoomIn: () => {
        set((state) => {
            const newLevel = Math.min(state.zoomLevel + ZOOM_STEP, MAX_ZOOM);
            localStorage.setItem('editor_zoom_level', newLevel.toString());
            return { zoomLevel: newLevel };
        });
    },
    
    zoomOut: () => {
        set((state) => {
            const newLevel = Math.max(state.zoomLevel - ZOOM_STEP, MIN_ZOOM);
            localStorage.setItem('editor_zoom_level', newLevel.toString());
            return { zoomLevel: newLevel };
        });
    },
    
    resetZoom: () => {
        localStorage.setItem('editor_zoom_level', '1.0');
        set({ zoomLevel: 1.0 });
    }
}));
