/**
 * useFileWatcher — Tauri 文件监听与事件监听
 *
 * 职责：
 * 1. 监听 Tauri `note-renamed` 和 `vault:refresh` 事件
 * 2. 启动文件系统 watcher（debounce + ignore patterns）
 * 3. 处理文件删除时的 tab 清理和 UI 同步
 * 4. 监听外部文件拖放（从 Finder 拖入 .md 文件）
 */

import { useEffect } from 'react';
import { copyFile } from '@tauri-apps/plugin-fs';
import { useFileSystemStore } from '@/core/fs/store';
import { useTabsStore } from '@/core/tabs/TabsStore';
import type { FileSystemNoteRepository } from '@/core/storage/FileSystemNoteRepository';

interface UseFileWatcherOptions {
    repo: FileSystemNoteRepository;
    onNoteDeleted?: (id: string) => void;
    onNoteRenamed?: (oldPath: string, newPath: string) => void;
}

export function useFileWatcher({ repo, onNoteDeleted, onNoteRenamed: _onNoteRenamed }: UseFileWatcherOptions) {
    const { root: _root, loadRoot, refreshTree, refreshNode, removeNode, renameNode } = useFileSystemStore();

    // Load root on mount or repo change
    useEffect(() => {
        if (repo && repo.rootDir) {
            loadRoot(repo.rootDir);
        }
    }, [repo]);

    // Event listeners & File Watcher
    useEffect(() => {
        let isMounted = true;
        const unlisteners: (() => void)[] = [];

        const setupListener = async () => {
            try {
                const { listen } = await import("@tauri-apps/api/event");
                const { fileSystemService } = await import("@/core/fs/FileSystemService");

                // Note renamed event
                const unlistenRename = await listen('note-renamed', async (event: any) => {
                    if (!isMounted) return;
                    console.log("[useFileWatcher] Note renamed event received:", event.payload);
                    const { oldId, newId, newTitle, newPath } = event.payload;
                    if (oldId && newPath) {
                        renameNode(oldId, newPath);
                        _onNoteRenamed?.(oldId, newPath);
                        useTabsStore.getState().renameTab(oldId, newId || newPath, newTitle);
                    }
                });

                if (!isMounted) {
                    unlistenRename();
                } else {
                    unlisteners.push(unlistenRename);
                }

                // Vault refresh event from Rust file watcher
                const unlistenVaultRefresh = await listen('vault:refresh', async () => {
                    if (!isMounted) return;

                    if (repo && repo.rootDir) {
                        await refreshTree();
                    }
                });

                if (!isMounted) {
                    unlistenVaultRefresh();
                } else {
                    unlisteners.push(unlistenVaultRefresh);
                }

                // File System Watcher with debounce and ignore patterns
                if (repo && repo.rootDir) {
                    try {
                        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
                        const pendingPaths = new Set<string>();
                        const pendingFilePaths = new Set<string>();

                        const ignorePatterns = [
                            '.slash/',
                            '.slash\\',
                            'slash.log',
                            'assets_index.json',
                            'cache.json',
                            '.DS_Store',
                            'Thumbs.db',
                            '.tmp',
                        ];

                        const shouldIgnore = (path: string): boolean => {
                            const normalized = path.replace(/\\/g, '/');
                            return ignorePatterns.some(pattern => normalized.includes(pattern.replace(/\\/g, '/')));
                        };

                        const isDirectoryLikeEvent = (path: string): boolean => {
                            const normalized = path.replace(/\\/g, '/');
                            return !normalized.split('/').pop()?.includes('.');
                        };

                        const unwatch = await fileSystemService.watch(repo.rootDir, async (event) => {
                            if (!isMounted) return;

                            const paths: string[] = (event.paths || []);
                            const relevantPaths = paths.filter(p => !shouldIgnore(p));
                            if (relevantPaths.length === 0) return;

                            for (const p of relevantPaths) {
                                const separator = p.includes('\\') ? '\\' : '/';
                                const parentPath = p.substring(0, p.lastIndexOf(separator));
                                if (parentPath) pendingPaths.add(parentPath);
                                pendingFilePaths.add(p);
                            }

                            if (debounceTimer) clearTimeout(debounceTimer);
                            debounceTimer = setTimeout(async () => {
                                if (!isMounted) return;
                                const pathsToRefresh = Array.from(pendingPaths);
                                pendingPaths.clear();

                                const pathsToCheck = Array.from(pendingFilePaths);
                                pendingFilePaths.clear();

                                const { exists } = await import('@tauri-apps/plugin-fs');
                                const tabsStore = useTabsStore.getState();
                                const deletedPaths: string[] = [];

                                const pathStartsWith = (fullPath: string, prefix: string): boolean => {
                                    const lowerPath = fullPath.toLowerCase().replace(/\\/g, '/');
                                    let lowerPrefix = prefix.toLowerCase().replace(/\\/g, '/');
                                    if (lowerPrefix.endsWith('/')) {
                                        lowerPrefix = lowerPrefix.slice(0, -1);
                                    }
                                    return lowerPath.startsWith(lowerPrefix + '/');
                                };

                                for (const p of pathsToCheck) {
                                    if (!isDirectoryLikeEvent(p) && !p.endsWith('.md')) continue;
                                    let fileExists = await exists(p).catch(() => false);
                                    if (!fileExists) {
                                        // 防御竞态条件：macOS overwrite 操作可能导致毫秒级 exists=false
                                        await new Promise(resolve => setTimeout(resolve, 250));
                                        fileExists = await exists(p).catch(() => false);
                                    }

                                    if (!fileExists) {
                                        // 🛡️ 根目录物理自愈拦截：应用外绝不允许删除大类根目录，删了也要秒级拉起/重建！
                                        const rootDirNorm = repo.rootDir.replace(/\\/g, '/');
                                        const pNorm = p.replace(/\\/g, '/');
                                        const relPath = pNorm.toLowerCase().startsWith(rootDirNorm.toLowerCase() + '/')
                                            ? pNorm.substring(rootDirNorm.length + 1)
                                            : '';
                                        
                                        const protectedRoots = [
                                            '00_inbox', '01_projects', '02_areas', '03_resources', '04_archives', 'assets', '.slash',
                                            '01_projects', '02_areas', '03_resource', '04_archive'
                                        ];

                                        if (relPath && protectedRoots.includes(relPath.toLowerCase())) {
                                            console.warn(`🛡️ [useFileWatcher] Protected PARA root directory '${relPath}' deleted externally! Recreating and healing...`);
                                            const { mkdir } = await import('@tauri-apps/plugin-fs');
                                            await mkdir(p).catch(err => console.error("Failed to heal protected root directory:", err));
                                            continue; // 🔴 拦截删除动作，物理原处秒级重构！
                                        }

                                        deletedPaths.push(p);

                                        const resolvePhysicalToTeamPaths = async (physicalUrl: string): Promise<string[]> => {
                                            if (!physicalUrl.toLowerCase().startsWith(rootDirNorm.toLowerCase() + '/')) return [];
                                            const relPath = physicalUrl.substring(rootDirNorm.length + 1);
                                            const paths = [`__team__/${relPath}`];
                                            
                                            const reversePara: Record<string, string> = {
                                                '01_Projects': '01_PROJECTS',
                                                '02_Areas': '02_AREAS',
                                                '03_Resources': '03_RESOURCE',
                                                '04_Archives': '04_ARCHIVE',
                                            };
                                            
                                            for (const [personal, team] of Object.entries(reversePara)) {
                                                if (relPath === personal || relPath.startsWith(personal + '/')) {
                                                    const sub = relPath === personal ? '' : relPath.slice(personal.length);
                                                    paths.push(`__team__/${team}${sub}`);
                                                }
                                            }
                                            
                                            try {
                                                const { readTextFile } = await import('@tauri-apps/plugin-fs');
                                                const data = await readTextFile(`${rootDirNorm}/.slash/team_path_mappings.json`);
                                                const parsed = JSON.parse(data);
                                                
                                                let allMappings: Record<string, string> = {};
                                                if (parsed.teams) {
                                                    for (const teamId of Object.keys(parsed.teams)) {
                                                        Object.assign(allMappings, parsed.teams[teamId]);
                                                    }
                                                } else if (parsed.mappings) {
                                                    allMappings = parsed.mappings as Record<string, string>;
                                                } else {
                                                    allMappings = parsed as Record<string, string>;
                                                }
                                                
                                                const mappings = Object.entries(allMappings);
                                                for (const [personal, team] of mappings) {
                                                    if (relPath === personal || relPath.startsWith(personal + '/')) {
                                                        const sub = relPath === personal ? '' : relPath.slice(personal.length);
                                                        paths.push(`__team__/${team}${sub}`);
                                                    }
                                                }
                                            } catch { } // ignore
                                            
                                            return paths;
                                        };

                                        const teamCandidates = await resolvePhysicalToTeamPaths(pNorm);

                                        const allTabs = tabsStore.tabs;
                                        for (const tab of allTabs) {
                                            let shouldClose = false;

                                            // Exact matches for single file (physical)
                                            if (p.endsWith('.md') && tab.id === p) {
                                                shouldClose = true;
                                            }

                                            // Descendant matches for directory and team instances
                                            if (!shouldClose) {
                                                if (pathStartsWith(tab.id, p)) {
                                                    shouldClose = true;
                                                } else {
                                                    for (const virt of teamCandidates) {
                                                        if (tab.id === virt || pathStartsWith(tab.id, virt)) {
                                                            shouldClose = true;
                                                            break;
                                                        }
                                                    }
                                                }
                                            }

                                            if (shouldClose) {
                                                console.log(`[useFileWatcher] Removed locally via sync! Closing tab: ${tab.id}`);
                                                tabsStore.closeTab(tab.id);
                                                onNoteDeleted?.(tab.id);
                                            }
                                        }
                                    }
                                }

                                for (const deletedPath of deletedPaths) {
                                    removeNode(deletedPath);
                                }

                                const shouldRefreshTree = pathsToCheck.some((changed) =>
                                    changed.endsWith('.md') || isDirectoryLikeEvent(changed)
                                );
                                const refreshTargets = shouldRefreshTree ? pathsToRefresh : [];
                                for (const parentPath of refreshTargets) {
                                    await refreshNode(parentPath);
                                }
                            }, 500);
                        });

                        if (!isMounted) {
                            unwatch();
                        } else {
                            unlisteners.push(unwatch);
                        }
                    } catch (e) {
                        console.error("Failed to start watcher", e);
                    }
                }
            } catch (err) {
                console.error("Failed to setup listeners", err);
            }
        };

        setupListener();

        return () => {
            isMounted = false;
            console.log("[useFileWatcher] Cleaning up listeners...");
            unlisteners.forEach(fn => fn());
        };
    }, [repo]);

    // Listen for external file drop (from desktop/finder)
    useEffect(() => {
        let unlisten: (() => void) | undefined;

        const setupDragDropListener = async () => {
            try {
                const { getCurrentWebview } = await import('@tauri-apps/api/webview');
                const webview = getCurrentWebview();

                unlisten = await webview.onDragDropEvent(async (event) => {
                    if (event.payload.type !== 'drop') return;

                    const { paths, position } = event.payload;
                    const [x, y] = [position.x, position.y];

                    console.log(`📥 [useFileWatcher] DragDrop event at (${x}, ${y}) with ${paths.length} files`);

                    if (paths.length === 0) return;

                    const mdPaths = paths.filter(p => p.endsWith('.md'));
                    if (mdPaths.length === 0) return;

                    const elementUnderMouse = document.elementFromPoint(x, y);
                    let targetFolder: string | null = null;

                    let el: Element | null = elementUnderMouse;
                    while (el) {
                        const folderPath = el.getAttribute('data-folder-path');
                        if (folderPath) {
                            targetFolder = folderPath;
                            break;
                        }
                        el = el.parentElement;
                    }

                    if (!targetFolder) return;

                    console.log(`📥 [useFileWatcher] Copying ${mdPaths.length} files to ${targetFolder}`);

                    for (const sourcePath of mdPaths) {
                        const fileName = sourcePath.split('/').pop() || 'unknown.md';
                        const destPath = `${targetFolder}/${fileName}`;

                        try {
                            await copyFile(sourcePath, destPath);
                        } catch (err) {
                            console.error(`❌ Failed to copy ${fileName}:`, err);
                        }
                    }

                    if (repo?.rootDir) {
                        refreshTree();
                    }
                });
            } catch (err) {
                console.error('❌ Failed to setup drag drop listener:', err);
            }
        };

        setupDragDropListener();

        return () => {
            unlisten?.();
        };
    }, [repo, refreshTree]);
}
