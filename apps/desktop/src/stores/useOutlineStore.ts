import { create } from 'zustand';

export interface OutlineHeading {
    level: number;
    text: string;
    pos: number;
    id: string;
    noteId?: string | null;
}

interface OutlineStore {
    headings: OutlineHeading[];
    setHeadings: (headings: OutlineHeading[]) => void;
    /** 当前活跃的 heading 索引（光标/滚动位置对应的章节） */
    activeIndex: number | null;
    setActiveIndex: (index: number | null) => void;
}

export const useOutlineStore = create<OutlineStore>((set) => ({
    headings: [],
    setHeadings: (headings) => set({ headings }),
    activeIndex: null,
    setActiveIndex: (activeIndex) => set({ activeIndex }),
}));
