import { metadataService } from '@/core/metadata/MetadataService';
import { cacheService } from '@/core/cache/CacheService';
import { markdownService } from '@/core/markdown/MarkdownService';
import { exists, mkdir, readTextFile, writeTextFile, readDir, stat, remove, rename } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { Note, NoteRepository } from './types';
import matter from 'gray-matter';
import { useSessionStore } from '@/stores/useSessionStore';
import { getParentPath, getRelativePath, getBasename, normalizePath } from '@/shared/utils/pathUtils';
export class FileSystemNoteRepository implements NoteRepository {
    public readonly rootDir: string;

    constructor(rootDir: string) {
        this.rootDir = rootDir;
    }

    async initialize(): Promise<void> {
        const dirExists = await exists(this.rootDir);
        if (!dirExists) {
            await mkdir(this.rootDir, { recursive: true });
        }
        await cacheService.initialize(this.rootDir);
    }

    private async getRoot(): Promise<string> {
        return this.rootDir;
    }

    async getNotes(): Promise<Note[]> {
        const root = await this.getRoot();
        const entries = await readDir(root);
        const notes: Note[] = [];

        for (const entry of entries) {
            if (entry.isFile && entry.name.endsWith('.md')) {
                const filePath = await join(root, entry.name);
                let stats;
                try {
                    stats = await stat(filePath);
                } catch (e) {
                    console.warn(`Failed to stat file ${entry.name}`, e);
                }

                // Check cache first
                let title = entry.name.replace('.md', '');
                const cached = cacheService.get(filePath);

                if (cached && cached.title) {
                    title = cached.title;
                }

                notes.push({
                    id: title, // Use title/path? Using title as ID is flaky if duplicated, but sticking to previous pattern for now. Actually getNotes uses title as ID?
                    // Previous code used title as id.
                    title: title,
                    content: '',
                    path: filePath,
                    createdAt: stats ? stats.birthtime?.getTime() || Date.now() : Date.now(),
                    updatedAt: stats ? stats.mtime?.getTime() || Date.now() : Date.now()
                });
            }
        }
        return notes;
    }

    async getNote(id: string): Promise<Note | null> {
        try {
            const filePath = id; // ID is the absolute path

            // 团队文件不从本地磁盘读取
            if (filePath.startsWith('__team__/')) {
                return null;
            }

            // Guard: Only allow .md files to be opened as notes
            if (!filePath.endsWith('.md')) {
                console.warn('[Repository.getNote] Skipped non-markdown file:', filePath);
                return null;
            }

            const rawContent = await readTextFile(filePath);
            const stats = await stat(filePath);

            const { metadata, content: bodyContent } = metadataService.parse(filePath, rawContent);

            // ✅ 关键修复：Editor 现在直接使用 Markdown，不需要转换为 HTML
            const name = getBasename(filePath) || '';
            let title = name.replace(/\.md$/, '');
            if (metadata.title) {
                // 外部重命名后物理文件名改变，但 YAML 中的 title 还是旧的。
                // 此时应当以物理文件名为准，自动在内存中修正 metadata 里的 title 属性，
                // 以便在下一次保存时自动物理修正写入正确的 title 字段。
                if (metadata.title !== title) {
                    metadata.title = title;
                }
            }



            return {
                id,
                title,
                content: bodyContent,  // 直接使用 Markdown，不转换
                path: filePath,
                metadata,
                createdAt: stats.birthtime?.getTime() || Date.now(),
                updatedAt: stats.mtime?.getTime() || Date.now()
            };
        } catch (e) {
            // 文件不存在是正常情况（如已改名或删除的笔记仍在缓存中）
            // 只有非 "No such file" 的错误才值得 warn
            const msg = String(e);
            if (!msg.includes('No such file')
                && !msg.includes('os error 2')
                && !msg.includes('os error 3')
                && !msg.includes('not found')
                && !msg.includes('找不到指定的路径')) {
                console.warn('Note not accessible:', e);
            }
            return null;
        }
    }

    async saveNote(note: Note): Promise<void> {



        // 2. Transcode ONLY IF it looks like HTML (Legacy/Internal format)
        let markdownBody = note.content;
        if (markdownService.isHTML(note.content)) {
            markdownBody = markdownService.toMarkdown(note.content);
        }

        // 3. 保留原始 frontmatter 字节策略
        let fileContent: string;
        let existingRaw: string | undefined;

        try {
            existingRaw = await readTextFile(note.path);
            const fmEnd = this._findFrontmatterEnd(existingRaw);

            if (fmEnd !== -1) {
                const rawFrontmatterBlock = existingRaw.slice(0, fmEnd);
                const { data: existingMeta } = matter(existingRaw);
                const newMeta = note.metadata || {};

                const metaEqual = this._metadataEqual(existingMeta, newMeta);

                // ── 日志：metadata 对比详情 ──
                if (!metaEqual) {
                    const existingKeys = Object.keys(existingMeta).filter(k => existingMeta[k] !== undefined);
                    const newKeys = Object.keys(newMeta).filter(k => newMeta[k] !== undefined);
                    const allKeys = new Set([...existingKeys, ...newKeys]);
                    const diffs: string[] = [];
                    for (const k of allKeys) {
                        const va = String(existingMeta[k] ?? '∅');
                        const vb = String(newMeta[k] ?? '∅');
                        if (va !== vb) diffs.push(`  ${k}: [disk]"${va}" vs [react]"${vb}"`);
                    }
                    if (existingKeys.length !== newKeys.length) {
                        diffs.unshift(`  keyCount: disk=${existingKeys.length} react=${newKeys.length}`);
                        const onlyInDisk  = existingKeys.filter(k => !(k in newMeta));
                        const onlyInReact = newKeys.filter(k => !(k in existingMeta));
                        if (onlyInDisk.length)  diffs.push(`  disk-only keys: [${onlyInDisk.join(', ')}]`);
                        if (onlyInReact.length) diffs.push(`  react-only keys: [${onlyInReact.join(', ')}]`);
                    }
                    console.warn(`💾 [saveNote] metadata CHANGED → full re-serialize:\n${diffs.join('\n')}`);
                }

                if (metaEqual) {
                    const newBody = '\n' + markdownBody.replace(/^[\n\r]+/, '');
                    fileContent = rawFrontmatterBlock + newBody;
                } else {
                    fileContent = metadataService.stringify(markdownBody, newMeta);
                    fileContent = metadataService.ensureSlashId(fileContent);
                }
            } else {

                fileContent = metadataService.stringify(markdownBody, note.metadata || {});
                fileContent = metadataService.ensureSlashId(fileContent);
            }

            // 最终幂等校验
            if (fileContent.trimEnd() === existingRaw.trimEnd()) {

                return;
            }




            // BUG-D06: Shrinkage Guard 已移除 — 根因已在 useContentPersistence 中修复
            // （thunk 返回空字符串时跳过保存），不再需要在此层做大小检查

            // WRITING log removed for zero-noise in production

        } catch {

            fileContent = metadataService.stringify(markdownBody, note.metadata || {});
            fileContent = metadataService.ensureSlashId(fileContent);
        }

        // Write to disk
        await writeTextFile(note.path, fileContent);

        // 异步检查并清理因编辑而孤立的附件
        if (typeof existingRaw === 'string') {
            const oldAssets = this._extractAssetRefsOffline(existingRaw);
            const newAssets = this._extractAssetRefsOffline(fileContent);
            const removedAssets = oldAssets.filter(a => !newAssets.includes(a));
            if (removedAssets.length > 0) {
                this._verifyAndCleanOrphanAssets(removedAssets).catch(e => 
                    console.error('🧹 [AutoClean] async orphan clean failed:', e)
                );
            }
        }

        // 5. Update database for WikiLink suggestions
        // Extract relative path from absolute path
        const relativePath = getRelativePath(note.path, this.rootDir);
        invoke('scan_single_file', {
            vaultPath: this.rootDir,
            relativePath
        }).then(() => {
            // Immediately schedule note for media embedding if it has images
            return invoke('trigger_schedule_note', {
                vaultPath: this.rootDir,
                notePath: relativePath
            });
        }).then(() => {
            // Notify status bar to refresh media_pending count immediately
            window.dispatchEvent(new CustomEvent('slash:media-pending-changed'));
        }).catch((e) => console.warn('[saveNote] Async processing failed:', e));

        // Immediate Cache Update
        const title = note.metadata?.title || note.title;
        cacheService.set(note.path, {
            mtime: Date.now(),
            title: title,
            tags: note.metadata?.tags
        });
        await cacheService.persist();

        // Dispatch event to notify task panel of content changes
        window.dispatchEvent(new CustomEvent('slash:note-saved', {
            detail: { path: note.path }
        }));
    }

    async createNote(title: string, parentPath?: string): Promise<Note> {
        const root = parentPath || await this.getRoot();
        let fileName = `${title}.md`;
        let filePath = await join(root, fileName);

        if (await exists(filePath)) {
            throw new Error('Note already exists');
        }

        const metadata: Record<string, any> = { title };
        // 如果用户已加入团队，注入 editor 字段
        const editorName = useSessionStore.getState().displayName;
        if (editorName) {
            metadata.editor = editorName;
        }

        // ── 在创建时立即注入 slash_id（UUID） ──
        // 不能等到 saveNote 才生成：首次 push 时文件内容若无 slash_id，
        // 服务端快照会使用 file_uuid=NULL，导致后续 push 重复创建"创建了"快照
        const slashId = crypto.randomUUID();
        metadata.slash_id = slashId;
        // contributors 也在创建时初始化，确保首次 sync 就有完整 frontmatter
        if (editorName) {
            metadata.contributors = [editorName];
        }
        // 新建笔记默认 Solo 模式（仅 Editor 可编辑）
        metadata.doc_status = 'solo';

        const fileContent = metadataService.stringify('', metadata);

        // Purge any stale AI data from a previous note with the same path
        // (e.g., a deleted/renamed note that left orphan embeddings)
        try {
            await invoke('purge_stale_note_data', { notePath: filePath, vaultPath: this.rootDir });
        } catch (e) {
            console.warn('[createNote] purge_stale_note_data failed (non-fatal):', e);
        }

        await writeTextFile(filePath, fileContent);

        const note: Note = {
            id: filePath,
            title,
            content: '',
            path: filePath,
            metadata,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };



        // Cache
        cacheService.set(filePath, { mtime: Date.now(), title });
        await cacheService.persist();

        return note;
    }

    async deleteNote(id: string): Promise<void> {
        const filePath = id;


        // 🔎 DIAG: 在删除前读取文件内容，提取资产引用
        let assetRefs: string[] = [];
        try {
            const content = await readTextFile(filePath);
            assetRefs = this._extractAssetRefsOffline(content);
            if (assetRefs.length > 0) {

            }
        } catch (e) {

        }

        if (!await exists(filePath)) {

            cacheService.delete(filePath);
            await cacheService.persist();
            return;
        }


        try {
            await invoke('move_to_trash', { path: filePath, vaultPath: this.rootDir });

            cacheService.delete(filePath);
            await cacheService.persist();
        } catch (e) {

            if (await exists(filePath)) {
                try {
                    await remove(filePath);
                    cacheService.delete(filePath);
                    await cacheService.persist();
                } catch (rmError) {

                }
            }
        }

        // 🔎 DIAG: 删除完成后，扫描其他笔记检查资产引用计数
        if (assetRefs.length > 0) {
            this._verifyAndCleanOrphanAssets(assetRefs).catch(() => {});
        }
    }

    private _extractAssetRefsOffline(content: string): string[] {
        const assetRefs: string[] = [];
        // Extract from Markdown
        const imgRegex = /!\[[^\]]*\]\(([^)"]+?)(?:\s+"[^"]*")?\)/g;
        let match;
        while ((match = imgRegex.exec(content)) !== null) {
            const ref = decodeURIComponent(match[1].trim());
            if (ref.startsWith('assets/')) assetRefs.push(ref);
        }
        // Extract from HTML
        const htmlRegex = /<img[^>]+src=["']([^"']+)["']/g;
        while ((match = htmlRegex.exec(content)) !== null) {
            const ref = decodeURIComponent(match[1]);
            if (ref.startsWith('assets/')) assetRefs.push(ref);
        }
        return assetRefs;
    }

    private async _verifyAndCleanOrphanAssets(assetRefs: string[]): Promise<void> {
        if (!assetRefs || assetRefs.length === 0) return;
        try {
            const { readDir, readTextFile, exists } = await import('@tauri-apps/plugin-fs');
            const { invoke } = await import('@tauri-apps/api/core');
            const uniqueAssets = [...new Set(assetRefs)];
            
            // 递归收集所有 .md 文件
            const allMdFiles: string[] = [];
            const scanDir = async (dirPath: string) => {
                try {
                    const entries = await readDir(dirPath);
                    for (const entry of entries) {
                        const entryPath = `${dirPath}/${entry.name}`;
                        if (entry.isDirectory && !entry.name.startsWith('.') && entry.name !== 'assets') {
                            await scanDir(entryPath);
                        } else if (entry.isFile && entry.name.endsWith('.md')) {
                            allMdFiles.push(entryPath);
                        }
                    }
                } catch { /* skip inaccessible dirs */ }
            };
            await scanDir(this.rootDir);

            // 对每个资产检查剩余引用
            for (const asset of uniqueAssets) {
                let refCount = 0;
                const referencingNotes: string[] = [];
                
                for (const mdFile of allMdFiles) {
                    try {
                        const content = await readTextFile(mdFile);
                        if (content.includes(asset)) {
                            refCount++;
                            const relPath = getRelativePath(mdFile, this.rootDir);
                            referencingNotes.push(relPath);
                        }
                    } catch { /* skip unreadable files */ }
                }

                if (refCount > 0) {
                    console.error(`🔎 [AssetRefCount] '${asset}' still referenced by ${refCount} note(s): [${referencingNotes.join(', ')}] → KEEP`);
                } else {
                    // 🧹 自动清理孤儿资产：0引用 → 移入系统回收站
                    const assetFullPath = `${this.rootDir}/${asset}`;
                    try {
                        if (await exists(assetFullPath)) {
                            await invoke('move_to_trash', { path: assetFullPath, vaultPath: this.rootDir });
                            console.error(`🧹 [AssetRefCount] '${asset}' has 0 references → AUTO-CLEANED ✅ (moved to system trash)`);
                        } else {
                            console.error(`🔎 [AssetRefCount] '${asset}' has 0 references but file not found on disk (already cleaned)`);
                        }
                    } catch (cleanErr) {
                        console.error(`⚠️ [AssetRefCount] '${asset}' has 0 references → CLEANUP FAILED:`, cleanErr);
                    }
                }
            }
        } catch (e) {
            console.error('🔎 [AssetRefCount] Scan failed:', e);
        }
    }

    async renameNote(id: string, newTitle: string): Promise<string> {
        const oldPath = normalizePath(id);
        const parentDir = getParentPath(oldPath);
        const newPath = parentDir ? `${parentDir}/${newTitle}.md` : `${newTitle}.md`;

        // Check if this is a case-only rename (macOS is case-insensitive)
        const isCaseOnlyRename = oldPath.toLowerCase() === newPath.toLowerCase() && oldPath !== newPath;

        if (!isCaseOnlyRename && await exists(newPath)) {
            throw new Error('Note with this title already exists');
        }

        // Calculate relative paths for database migration
        const oldRelativePath = getRelativePath(oldPath, this.rootDir);
        const newRelativePath = getRelativePath(newPath, this.rootDir);

        // Migrate database records BEFORE filesystem rename to preserve data
        // This must happen first so the watcher doesn't delete the old record
        try {
            await invoke('rename_note_in_db', {
                oldRelativePath,
                newRelativePath,
            });

        } catch (e) {
            console.warn('[renameNote] Database migration failed (may not exist yet):', e);
            // Continue with rename even if DB migration fails - note might be new
        }

        if (isCaseOnlyRename) {
            // Two-step rename for case changes on case-insensitive file systems
            // 1. Rename to temp name
            // 2. Rename to final name
            const tempPath = `${parentDir}/tmp_rename_${Date.now()}.md`;
            await rename(oldPath, tempPath);
            await rename(tempPath, newPath);
        } else {
            await rename(oldPath, newPath);
        }

        // Update YAML title inside the file to match new filename
        try {
            const content = await readTextFile(newPath);
            const { metadata, content: bodyContent } = metadataService.parse(newPath, content);
            metadata.title = newTitle;
            const newContent = metadataService.stringify(bodyContent, metadata);
            await writeTextFile(newPath, newContent);

        } catch (e) {
            console.warn('[renameNote] Failed to update YAML title:', e);
        }

        // Immediate Cache Update
        cacheService.rename(oldPath, newPath);
        await cacheService.persist();

        return newPath;
    }

    async createFolder(name: string, parentPath?: string): Promise<string> {
        const root = parentPath || await this.getRoot();
        const folderPath = await join(root, name);

        if (await exists(folderPath)) {
            throw new Error('Folder already exists');
        }

        await mkdir(folderPath, { recursive: true });
        return folderPath;
    }

    /**
     * 找到 frontmatter 结束位置（即 `---\n` 封面内容之后，包含关闭 `---` 和换行符）
     * 返回 offset：文件内容中 body 开始前一个字符的位置。
     * 找不到时返回 -1。
     */
    private _findFrontmatterEnd(content: string): number {
        if (!content.startsWith('---')) return -1;
        const afterOpen = content.indexOf('\n', 0);
        if (afterOpen === -1) return -1;
        const closeIdx = content.indexOf('\n---', afterOpen);
        if (closeIdx === -1) return -1;
        // 返回到 closing ---\n 结束为止的位置（包含 \n---\n）
        const endOfClose = content.indexOf('\n', closeIdx + 4);
        return endOfClose === -1 ? content.length : endOfClose + 1;
    }

    /**
     * 对比两个 metadata 对象是否语义相等。
     * 仅对比两者共同关心的字段，添加或删除字段视为不等。
     */
    private _metadataEqual(a: Record<string, any>, b: Record<string, any>): boolean {
        const keysA = Object.keys(a).filter(k => a[k] !== undefined);
        const keysB = Object.keys(b).filter(k => b[k] !== undefined);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) {
            if (!(key in b)) return false;
            const va = a[key];
            const vb = b[key];
            // 数组对比
            if (Array.isArray(va) && Array.isArray(vb)) {
                if (va.length !== vb.length) return false;
                if (va.some((v, i) => String(v) !== String(vb[i]))) return false;
                continue;
            }
            if (String(va) !== String(vb)) return false;
        }
        return true;
    }
}
