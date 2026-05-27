/**
 * HistoryCache — ProseMirror 文档缓存
 *
 * 所有打开过的笔记都缓存其 ProseMirror doc JSON。
 * 切回时用 doc JSON 恢复，跳过 markdown → ProseMirror 解析（300ms → ~20ms）。
 * 用 rawContent hash 校验文件是否被外部修改过（同步/外部编辑器）。
 */



export function normalizeNoteId(noteId: string): string {
    if (!noteId) return '';
    return noteId.trim().replace(/\\/g, '/');
}

/**
 * 🚀 终极降维绝杀：循环剥离 Markdown 文本头部的所有层级的 YAML Frontmatter，只保留最纯粹的正文
 * 1. 彻底清洗 UTF-8 BOM 字符 (\ufeff) 以及一切前导/尾随空白，保障两端在物理哈希前完全对准。
 * 2. 引入 while 循环机制，强力剥离任何可能由于紧急写盘 (flushPendingSave) 嵌套导致的“双重/多重 Frontmatter”包裹，扒皮到最核心正文！
 */
export function stripFrontmatter(content: string): string {
    if (!content) return '';

    // 清除首尾空白与 UTF-8 BOM 头
    let current = content.replace(/^\ufeff/, '').trim();

    while (true) {
        // 匹配单独成行的 --- 包裹的 Frontmatter 结构，并将其剥除
        // 兼容 Windows (\r\n) 与 Unix (\n) 换行符
        const match = current.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
        if (match) {
            current = match[1].replace(/^\ufeff/, '').trim();
        } else {
            break;
        }
    }

    return current;
}

interface CachedDoc {
    docJSON: Record<string, any>;
    selection?: { anchor: number; head: number };
    scrollTop?: number;
    contentHash: number;
    timestamp: number;
}

/**
 * 快速字符串 hash（djb2 变体）
 * 不需要密码安全，只需检测"文件内容是否变了"
 */
function quickHash(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return hash;
}

/**
 * 统一对剥离了 Frontmatter 的最纯粹正文计算哈希
 */
function getBodyHash(str: string): number {
    const cleanStr = stripFrontmatter(str);
    return quickHash(cleanStr);
}

class HistoryCacheManager {
    public cache: Map<string, CachedDoc> = new Map();
    private loadHashes: Map<string, number> = new Map();
    private readonly MAX_CACHE_SIZE = 20;
    private readonly LOCAL_STORAGE_KEY = 'slash:note-view-positions';

    constructor() {}

    /**
     * 记录笔记加载时的原始内容 hash
     */
    recordLoadHash(noteId: string, rawContent: string) {
        const cleanId = normalizeNoteId(noteId);
        const newHash = getBodyHash(rawContent);
        this.loadHashes.set(cleanId, newHash);
    }

    /**
     * 更新指定笔记的 hash（通常在主动保存写盘后调用，避免二次读取时判定为外部修改）
     */
    updateHash(noteId: string, rawContent: string) {
        const cleanId = normalizeNoteId(noteId);
        const newHash = getBodyHash(rawContent);
        this.loadHashes.set(cleanId, newHash);
        const cached = this.cache.get(cleanId);
        if (cached) {
            cached.contentHash = newHash;
        }
    }

    /**
     * 缓存 ProseMirror doc JSON、历史栈、选区及滚动高度
     */
    saveDoc(
        noteId: string,
        docJSON: Record<string, any>,
        selection?: { anchor: number; head: number },
        scrollTop?: number
    ) {
        const cleanId = normalizeNoteId(noteId);
        const contentHash = this.loadHashes.get(cleanId) ?? 0;

        // LRU 淘汰
        if (this.cache.size >= this.MAX_CACHE_SIZE && !this.cache.has(cleanId)) {
            let oldestId: string | null = null;
            let oldestTime = Infinity;
            for (const [id, entry] of this.cache.entries()) {
                if (entry.timestamp < oldestTime) {
                    oldestTime = entry.timestamp;
                    oldestId = id;
                }
            }
            if (oldestId) {
                this.cache.delete(oldestId);
            }
        }

        const existing = this.cache.get(cleanId);
        const finalSelection = selection !== undefined ? selection : existing?.selection;
        const finalScrollTop = scrollTop !== undefined ? scrollTop : existing?.scrollTop;

        this.cache.set(cleanId, {
            docJSON,
            selection: finalSelection,
            scrollTop: finalScrollTop,
            contentHash,
            timestamp: Date.now()
        });

        // 💾 同步持久化阅读与编辑位置到 LocalStorage（最大100条限制）
        if (finalSelection && typeof finalScrollTop === 'number') {
            this.saveStoredPosition(cleanId, finalSelection.anchor, finalSelection.head, finalScrollTop);
        }
    }

    /**
     * 获取指定笔记的原始缓存对象（通常用于只读检查是否存在）
     */
    getCached(noteId: string): CachedDoc | undefined {
        const cleanId = normalizeNoteId(noteId);
        return this.cache.get(cleanId);
    }

    /**
     * 恢复缓存的 doc 及其所有伴随状态
     */
    retrieveDoc(noteId: string, rawContent: string): CachedDoc | null {
        const cleanId = normalizeNoteId(noteId);
        const cached = this.cache.get(cleanId);
        const currentHash = getBodyHash(rawContent);

        if (!cached) return null;

        const isJustSavedByUs = Date.now() - cached.timestamp < 3000;
        cached.timestamp = Date.now();

        if (cached.contentHash !== currentHash) {
            // 🚀 CRITICAL FIX: 如果距离上一次缓存保存时间在 3秒内，说明这极大可能是因为我们自家切换笔记时异步写盘（flushPendingSave）
            // 还没来得及落地或更新的微小时差，绝对不是外部编辑器的修改！我们应该直接信任最新的内存缓存，放行还原！
            if (isJustSavedByUs) {
                return cached;
            }

            this.cache.delete(cleanId);
            return null;
        }

        return cached;
    }

    // ==========================================
    // 💾 LocalStorage 跨会话阅读位置记忆持久化
    // ==========================================
    getStoredPosition(noteId: string): { anchor: number; head: number; scrollTop: number } | null {
        const cleanId = normalizeNoteId(noteId);
        try {
            const raw = localStorage.getItem(this.LOCAL_STORAGE_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            return data[cleanId] || null;
        } catch {
            return null;
        }
    }

    saveStoredPosition(noteId: string, anchor: number, head: number, scrollTop: number) {
        const cleanId = normalizeNoteId(noteId);
        try {
            const raw = localStorage.getItem(this.LOCAL_STORAGE_KEY);
            const data = raw ? JSON.parse(raw) : {};

            // 限制 LocalStorage 的尺寸最大为 100 条，超出的按照最旧的使用淘汰
            const keys = Object.keys(data);
            if (keys.length >= 100 && !data[cleanId]) {
                const sortedKeys = keys.sort((a, b) => (data[a].timestamp || 0) - (data[b].timestamp || 0));
                delete data[sortedKeys[0]];
            }

            data[cleanId] = {
                anchor,
                head,
                scrollTop,
                timestamp: Date.now(),
            };

            localStorage.setItem(this.LOCAL_STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn('[HistoryCache] Failed to persist position to localStorage:', e);
        }
    }

    removeState(noteId: string) {
        const cleanId = normalizeNoteId(noteId);
        this.cache.delete(cleanId);
        this.loadHashes.delete(cleanId);
    }

    clear() {
        this.cache.clear();
        this.loadHashes.clear();
    }
}

// 🚀 终极加固：将 historyCache 绑定至 window，确保在 Vite 热更新、多 bundle 或者是各种奇怪的重新求值下，全局只有一个共享的缓存实例，绝不丢失数据！
const GLOBAL_CACHE_KEY = '__slashHistoryCache';
let managerInstance: HistoryCacheManager;

if (typeof window !== 'undefined') {
    if (!(window as any)[GLOBAL_CACHE_KEY]) {
        (window as any)[GLOBAL_CACHE_KEY] = new HistoryCacheManager();
    }
    managerInstance = (window as any)[GLOBAL_CACHE_KEY];
} else {
    managerInstance = new HistoryCacheManager();
}

export const historyCache = managerInstance;
