/**
 * useCollabNotifyStore — 协作事件未读状态管理
 *
 * 职责：
 * 1. unreadFiles:       哪些笔记有未读团队事件（文件树小红点）
 *                       含 latestSeq：该文件最新事件的 seq（用于标记已读）
 * 2. unreadDetectedAt: 每条路径被首次标为未读的时间（ActivityTimeline NEW 基准）
 * 3. lastReadAt:       每篇笔记上次查看协作面板的时间戳
 *
 * 存储策略：
 * - 全部内存态，不再 localStorage 持久化
 * - 应用启动/重新登录后调用 refreshUnread() 从 GET /api/collab/unread 重建
 * - 红点语义：有他人 seq > read_seq[file] 的事件
 * - 消红时机：用户打开协作历史 Tab → markRead() → PUT /api/collab/read（服务端更新已读游标）
 */

import { create } from 'zustand';
import type { CollabEvent } from '@/services/CollabService';

interface UnreadFileEntry {
    latestSeq: number;   // 该文件当前最新事件 seq（用于 markFileRead 调用）
    unreadSince: number; // 当前未读事件的绝对最老时间点锚（毫秒戳）
    unreadCount: number; // 当前未被本地消费的有效新事件总数
}

interface CollabNotifyState {
    /** 有未读协作事件的笔记路径 → 详情 */
    unreadFiles: Map<string, UnreadFileEntry>;
    /** 由于被赋予团队权限而产生的团队根目录组高亮 */
    unreadFolders: Map<string, UnreadFileEntry>;
    /** 每篇笔记最后查看协作面板的时间戳（毫秒）*/
    lastReadAt: Record<string, number>;

    // ── 派生读取 ──
    /** 查询某路径是否有未读（快速判断，用于文件树红点） */
    isUnread: (path: string) => boolean;
    /** 获取某路径的未读详情（用于 ActivityTimeline NEW 基准） */
    getUnreadEntry: (path: string) => UnreadFileEntry | undefined;

    // ── 写入 ──
    /** 从 collab:new-events 事件增量标记未读 */
    markUnreadFromEvents: (events: CollabEvent[]) => void;
    /** 登录后从 GET /api/collab/unread 全量重建红点 */
    refreshUnread: (vaultId: string) => Promise<void>;
    /** 用户打开协作历史 Tab → 消红 + 写服务端已读游标 */
    markRead: (path: string, vaultId: string) => void;
    /** 用户主动点开带有 NEW 徽章的目录 → 消红胶囊 + 并行清理该层级下所有散户小红点 */
    markFolderRead: (path: string, vaultId: string) => Promise<void>;
    /** 用户主动点开/展开新入队的团队目录 → 仅消除 NEW 蓝圈徽章，严格保留内部独立触发的小红点 */
    markFolderBadgeRead: (path: string, vaultId: string) => Promise<void>;
    /** 仅更新 lastReadAt（ActivityTimeline 内部用） */
    setLastRead: (path: string, ts: number) => void;
    /** 当本地文件系统确认某个笔记或目录被物理删除时，立刻清洗其带来的红点污染 */
    clearUnreadForDeletedPath: (path: string) => void;
    /** 一键清除所有未读标记（文件红点 + 目录 NEW 蓝框） */
    clearAllUnread: (vaultId: string) => Promise<void>;
}

export const useCollabNotifyStore = create<CollabNotifyState>((set, get) => ({
    unreadFiles: new Map(),
    unreadFolders: new Map(),
    lastReadAt: {},

    isUnread: (path) => get().unreadFiles.has(path),

    getUnreadEntry: (path) => get().unreadFiles.get(path),

    markUnreadFromEvents: (events) => {
        set((state) => {
            const nextFiles = new Map(state.unreadFiles);
            const nextFolders = new Map(state.unreadFolders);
            for (const ev of events) {
                const isFolder = !ev.file_path.endsWith('.md');
                const targetMap = isFolder ? nextFolders : nextFiles;
                const existing = targetMap.get(ev.file_path);
                const evTs = new Date(ev.created_at).getTime();
                targetMap.set(ev.file_path, {
                    latestSeq: Math.max(ev.seq, existing?.latestSeq ?? 0),
                    // 如果已经记录了 unreadSince 则保持旧的绝对时间起点以囊括所有后续点；否则设为新事件
                    unreadSince: existing?.unreadSince || evTs,
                    unreadCount: (existing?.unreadCount ?? 0) + 1,
                });
            }
            return { unreadFiles: nextFiles, unreadFolders: nextFolders };
        });
    },

    refreshUnread: async (vaultId) => {
        if (!vaultId || vaultId === 'null' || vaultId === 'undefined') return;
        try {
            const { collabService } = await import('@/services/CollabService');
            const unreadList = await collabService.getUnreadFiles(vaultId);
            set(() => {
                const nextFiles = new Map<string, UnreadFileEntry>();
                const nextFolders = new Map<string, UnreadFileEntry>();
                const fallbackTime = Date.now();
                for (const item of unreadList) {
                    const isFolder = !item.file_path.endsWith('.md');
                    const targetMap = isFolder ? nextFolders : nextFiles;
                    targetMap.set(item.file_path, {
                        latestSeq: item.latest_seq,
                        unreadSince: item.unread_since ? new Date(item.unread_since).getTime() : fallbackTime,
                        unreadCount: item.unread_count,
                    });
                }
                return { unreadFiles: nextFiles, unreadFolders: nextFolders };
            });
        } catch { /* 静默忽略，红点为空态 */ }
    },

    markRead: (path, vaultId) => {
        const entry = get().unreadFiles.get(path);
        const latestSeq = entry?.latestSeq ?? 0;

        set((state) => {
            const next = new Map(state.unreadFiles);
            next.delete(path);
            return {
                unreadFiles: next,
                lastReadAt: { ...state.lastReadAt, [path]: Date.now() },
            };
        });

        // 异步通知服务端更新已读游标（非阻塞）
        if (latestSeq > 0) {
            import('@/services/CollabService').then(({ collabService }) => {
                collabService.markFileRead(vaultId, path, latestSeq);
            });
        }
    },

    markFolderRead: async (path, vaultId) => {
        const entry = get().unreadFolders.get(path);
        const latestSeq = entry?.latestSeq ?? 0;

        set((state) => {
            const nextF = new Map(state.unreadFolders);
            const nextFiles = new Map(state.unreadFiles);
            
            // 乐观更新：立刻在前端抹除该 folder 本身
            nextF.delete(path);

            // 清理子项（彻底解决透出短效红点残影）
            for (const key of nextF.keys()) {
                if (key.startsWith(path + '/')) nextF.delete(key);
            }
            for (const key of nextFiles.keys()) {
                if (key.startsWith(path + '/')) nextFiles.delete(key);
            }

            return {
                unreadFolders: nextF,
                unreadFiles: nextFiles,
            };
        });

        // 强时序等待：带上 clearChildren，压跨后端的所有内层文件红点
        if (latestSeq > 0) {
            const { collabService } = await import('@/services/CollabService');
            await collabService.markFileRead(vaultId, path, latestSeq, true);
            // 必须在上方的数据落库请求完成后，才能开始拉取新的校验，否则查询跑在写入前面，就会死灰复燃
            await get().refreshUnread(vaultId);
        }
    },

    markFolderBadgeRead: async (path, vaultId) => {
        const entry = get().unreadFolders.get(path);
        if (!entry) return; // 防止重复请求
        const latestSeq = entry.latestSeq ?? 0;

        set((state) => {
            const nextF = new Map(state.unreadFolders);
            // 仅乐观更新该 folder 本身，绝不动内部的子文件和子目录的散户红点
            nextF.delete(path);
            return {
                unreadFolders: nextF,
            };
        });

        if (latestSeq > 0) {
            const { collabService } = await import('@/services/CollabService');
            // 只覆盖本身的 seq，严禁 clearChildren
            await collabService.markFileRead(vaultId, path, latestSeq, false);
        }
    },

    setLastRead: (path, ts) => {
        set((state) => ({
            lastReadAt: { ...state.lastReadAt, [path]: ts },
        }));
    },

    clearUnreadForDeletedPath: (path) => {
        set((state) => {
            const nextFiles = new Map(state.unreadFiles);
            const nextFolders = new Map(state.unreadFolders);
            let updated = false;

            if (nextFiles.has(path)) {
                nextFiles.delete(path);
                updated = true;
            }
            if (nextFolders.has(path)) {
                nextFolders.delete(path);
                updated = true;
            }

            // 对受影响的级联内层散户红点一并收割
            for (const key of nextFiles.keys()) {
                if (key.startsWith(path + '/')) {
                    nextFiles.delete(key);
                    updated = true;
                }
            }
            for (const key of nextFolders.keys()) {
                if (key.startsWith(path + '/')) {
                    nextFolders.delete(key);
                    updated = true;
                }
            }

            if (!updated) return state;

            return {
                unreadFiles: nextFiles,
                unreadFolders: nextFolders,
            };
        });
    },

    clearAllUnread: async (vaultId) => {
        const { unreadFiles, unreadFolders } = get();
        // 乐观更新：立刻清空前端状态
        set({ unreadFiles: new Map(), unreadFolders: new Map() });

        // 异步通知服务端：为每个条目写已读游标
        try {
            const { collabService } = await import('@/services/CollabService');
            const promises: Promise<void>[] = [];
            for (const [path, entry] of unreadFiles) {
                if (entry.latestSeq > 0) {
                    promises.push(collabService.markFileRead(vaultId, path, entry.latestSeq));
                }
            }
            for (const [path, entry] of unreadFolders) {
                if (entry.latestSeq > 0) {
                    promises.push(collabService.markFileRead(vaultId, path, entry.latestSeq));
                }
            }
            await Promise.all(promises);
        } catch { /* 静默忽略，前端已清 */ }
    },
}));
