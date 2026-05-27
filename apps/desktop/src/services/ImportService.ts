/**
 * ImportService — 文件导入服务
 *
 * 将外部文件（PDF/Word/Excel/PPT 等）通过 MarkItDown Sidecar 转换为 Markdown，
 * 并保存到 Vault 的 00_Inbox 目录中。
 */
import { writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { getBasename } from '@/shared/utils/pathUtils';
import { mediaService } from '@/core/media/MediaService';

// ============================================================
// Types
// ============================================================

export interface ImportResult {
    filename: string;
    markdown: string;
    size: number;
    elapsed_ms: number;
}

// ============================================================
// Service
// ============================================================

const INBOX_DIR = '00_Inbox';

/** 获取 sidecar 动态 URL */
async function getSidecarUrl(): Promise<string> {
    try {
        return await invoke<string>('get_sidecar_url');
    } catch {
        return 'http://localhost:3722';
    }
}

class ImportServiceImpl {
    /** 检查 Sidecar 是否可用 */
    async checkAvailable(): Promise<boolean> {
        try {
            const url = await getSidecarUrl();
            const resp = await fetch(`${url}/health`, {
                signal: AbortSignal.timeout(3000),
            });
            return resp.ok;
        } catch {
            return false;
        }
    }

    async importFile(
        filePath: string,
        vaultPath: string,
        llmConfig?: { baseUrl: string; apiKey?: string; model: string },
        audioLang?: string,
        appLang?: string
    ): Promise<string> {
        // 0. 体积拦截：使用 stat 零内存检查文件大小
        const { stat } = await import('@tauri-apps/plugin-fs');
        const { getMaxSyncFileSize, formatFileSize } = await import('@/core/sync/capabilities');
        const fileStat = await stat(filePath);
        const maxLimitBytes = await getMaxSyncFileSize();
        if (fileStat.size > maxLimitBytes) {
            const i18next = (await import('i18next')).default;
            throw new Error(i18next.t('media.team_size_limit_block_import', '此文件 ({{size}}) 超出空间 {{limit}} 大小限制，无法导入', {
                size: formatFileSize(fileStat.size),
                limit: formatFileSize(maxLimitBytes)
            }));
        }

        // 1. 提取文件名
        const fileName = getBasename(filePath) || 'imported';
        const baseName = fileName.replace(/\.[^.]+$/, '');

        // 2. 构建 JSON payload 传路径
        const payload: Record<string, string> = {
            local_path: filePath,
            filename: fileName,
        };

        if (llmConfig) {
            payload.base_url = llmConfig.baseUrl;
            if (llmConfig.apiKey) {
                payload.api_key = llmConfig.apiKey;
            }
            payload.llm_model = llmConfig.model;
        }
        
        if (audioLang) {
            payload.audio_lang = audioLang;
        }

        if (appLang) {
            payload.app_lang = appLang;
        }

        const sidecarUrl = await getSidecarUrl();
        const resp = await fetch(`${sidecarUrl}/parse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!resp.ok) {
            const text = await resp.text();
            let errMsg = text;
            try {
                const json = JSON.parse(text);
                if (json.detail) errMsg = json.detail;
            } catch (e) {
                // ignore
            }
            throw new Error(errMsg || `HTTP ${resp.status}`);
        }

        const result: ImportResult = await resp.json();
        
        result.markdown = await this.extractAndSaveInlineImages(result.markdown, baseName);

        // 将原始文件保存到 assets
        let assetMarkdown = '';
        try {
            const savedAssetPath = await mediaService.saveAssetFromPath(filePath);
            
            // 将 Sidecar 刚刚解析出来的结果直接固化到缓存中
            // 这样后台向量化引擎（MediaScheduler）扫描到这篇笔记时，就能直接瞬间命中缓存，避免二次调起本地 Sidecar/LLM！
            const savedHash = getBasename(savedAssetPath)?.split('.')[0];
            if (savedHash) {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('save_media_enrich_cache', { 
                    assetHash: savedHash, 
                    text: result.markdown,
                    modelName: llmConfig?.model || 'local_import'
                }).catch(e => console.warn("Failed to save media cache", e));
            }
            
            
            // Generate standard image syntax for all files
            // TipTap extensions (Image, Video, Audio, FileAttachment) will parse and render accordingly
            assetMarkdown = `![${fileName}](${savedAssetPath})\n\n`;
        } catch (err) {
            console.error('[ImportService] Failed to save raw asset:', err);
        }

        // 4. 写入 Vault 的 00_Inbox 目录
        const inboxPath = `${vaultPath}/${INBOX_DIR}`;
        if (!(await exists(inboxPath))) {
            await mkdir(inboxPath, { recursive: true });
        }

        // 避免文件名冲突
        let targetPath = `${inboxPath}/${baseName}.md`;
        let counter = 1;
        while (await exists(targetPath)) {
            targetPath = `${inboxPath}/${baseName}_${counter}.md`;
            counter++;
        }

        const { useSessionStore } = await import('@/stores/useSessionStore');
        const editorName = useSessionStore.getState().displayName || '';
        const editorLine = editorName ? `\neditor: "${editorName}"` : '';

        // 添加 frontmatter
        const content = `---
title: "${baseName}"
slash_id: "${crypto.randomUUID()}"
source: "${fileName}"
doc_status: "solo"${editorLine}
imported_at: "${new Date().toISOString()}"
---

${assetMarkdown}${result.markdown}`;

        await writeTextFile(targetPath, content);

        // 触发 UI 状态与后台处理 (仅当提供了 llmConfig 时才走后门，即 PDF/DOCX/图片等富文本，且用户选了 Vision LLM)
        if (llmConfig) {
            this.triggerEmbeddingWithUI(vaultPath, targetPath, llmConfig);
        }

        return targetPath;
    }

    /**
     * 根据超链接进行页面解析并倒入到 Vault
     * 
     * @param url 源 URL
     * @param vaultPath Vault 根路径
     * @param llmConfig AI Provider
     * @returns 新创建的 .md 文件绝对路径
     */
    async importUrl(
        url: string,
        vaultPath: string,
        llmConfig?: { baseUrl: string; apiKey?: string; model: string },
        audioLang?: string,
        appLang?: string
    ): Promise<string> {
        const payload: Record<string, string> = { url };
        if (llmConfig) {
            payload.base_url = llmConfig.baseUrl;
            if (llmConfig.apiKey) payload.api_key = llmConfig.apiKey;
            payload.llm_model = llmConfig.model;
        }
        
        if (audioLang) {
            payload.audio_lang = audioLang;
        }

        if (appLang) {
            payload.app_lang = appLang;
        }

        const sidecarUrl = await getSidecarUrl();
        const resp = await fetch(`${sidecarUrl}/parse-url`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!resp.ok) {
            const text = await resp.text();
            let errMsg = text;
            try {
                const json = JSON.parse(text);
                if (json.detail) errMsg = json.detail;
            } catch (e) {
                // ignore
            }
            throw new Error(errMsg || `HTTP ${resp.status}`);
        }

        const result: ImportResult = await resp.json();
        
        result.markdown = await this.extractAndSaveInlineImages(result.markdown, result.filename.replace(/\.[^.]+$/, ''));

        // 4. 写入 Vault 的 00_Inbox 目录
        const inboxPath = `${vaultPath}/${INBOX_DIR}`;
        if (!(await exists(inboxPath))) {
            await mkdir(inboxPath, { recursive: true });
        }

        const baseName = result.filename.replace(/\.[^.]+$/, '');
        
        // 避免文件名冲突
        let targetPath = `${inboxPath}/${baseName}.md`;
        let counter = 1;
        while (await exists(targetPath)) {
            targetPath = `${inboxPath}/${baseName}_${counter}.md`;
            counter++;
        }

        const { useSessionStore } = await import('@/stores/useSessionStore');
        const editorName = useSessionStore.getState().displayName || '';
        const editorLine = editorName ? `\neditor: "${editorName}"` : '';

        // 添加 frontmatter
        const content = `---
title: "${baseName}"
slash_id: "${crypto.randomUUID()}"
source: "${url}"
doc_status: "solo"${editorLine}
imported_at: "${new Date().toISOString()}"
---

${result.markdown}`;

        await writeTextFile(targetPath, content);

        // 触发 UI 状态与后台处理 (仅当提供了 llmConfig 时才走后门)
        if (llmConfig) {
            this.triggerEmbeddingWithUI(vaultPath, targetPath, llmConfig);
        }

        return targetPath;
    }

    /**
     * 解析 Markdown 中潜藏的 data:image/...;base64,... 并保存到本地
     */
    private async extractAndSaveInlineImages(markdown: string, baseName: string): Promise<string> {
        let processedMarkdown = markdown;
        const regex = /!\[([^\]]*)\]\((data:image\/([a-zA-Z0-9]+);base64,([A-Za-z0-9+/=]+))\)/g;
        
        const matches = [...markdown.matchAll(regex)];
        if (matches.length === 0) return markdown;

        try {
            for (let i = 0; i < matches.length; i++) {
                const match = matches[i];
                const fullMatch = match[0];
                const altText = match[1] || 'image';
                const ext = match[3] || 'png';
                const b64Data = match[4];

                try {
                    // Decode base64 
                    const binaryString = atob(b64Data);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let j = 0; j < binaryString.length; j++) {
                        bytes[j] = binaryString.charCodeAt(j);
                    }
                    
                    const imgName = `${baseName}_embedded_${i + 1}.${ext}`;
                    const savedPath = await mediaService.saveAssetFromBytes(bytes, imgName, ext);
                    
                    // Replace the full match with the local path
                    processedMarkdown = processedMarkdown.replace(fullMatch, `![${altText}](${savedPath})`);
                } catch (err) {
                    console.error('[ImportService] Failed to extract an inline image:', err);
                }
            }
        } catch (globalErr) {
            console.error('[ImportService] Extraction dependencies failed', globalErr);
        }

        return processedMarkdown;
    }


    /** 触发 Embedding 流水线并同步 UI 状态 */
    private async triggerEmbeddingWithUI(vaultPath: string, targetPath: string, llmConfig?: { baseUrl: string; apiKey?: string; model: string }) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const { useMediaScheduleStore } = await import('@/stores/useMediaScheduleStore');
            
            // \ud83d\udee1\ufe0f Windows \u517c\u5bb9\uff1a\u7edf\u4e00\u6b63\u659c\u6760\u518d\u505a\u622a\u53d6
            const normTarget = targetPath.replace(/\\/g, '/');
            const normVault = vaultPath.replace(/\\/g, '/').replace(/\/$/, '');
            const relativePath = normTarget.startsWith(normVault + '/')
                ? normTarget.slice(normVault.length + 1)
                : normTarget;
            
            // 通知 UI 显示 Spinner
            useMediaScheduleStore.getState().setProcessing(targetPath, true);
            window.dispatchEvent(new CustomEvent('slash:media-pending-changed'));

            const payload: any = { 
                vaultPath, 
                notePath: relativePath 
            };
            if (llmConfig) {
                payload.visionBaseUrl = llmConfig.baseUrl;
                if (llmConfig.apiKey) payload.visionApiKey = llmConfig.apiKey;
                payload.visionModel = llmConfig.model;
            }

            // 强行调起后台流水线
            invoke('trigger_media_embedding', payload).then(() => {
                useMediaScheduleStore.getState().setProcessing(targetPath, false);
                window.dispatchEvent(new CustomEvent('slash:media-pending-changed'));
            }).catch(e => {
                console.warn("[ImportService] Failed to trigger embedding", e);
                useMediaScheduleStore.getState().setProcessing(targetPath, false);
                window.dispatchEvent(new CustomEvent('slash:media-pending-changed'));
            });
        } catch (e) {
            console.warn("[ImportService] Failed to trigger embedding pipeline", e);
        }
    }

}

export const importService = new ImportServiceImpl();
