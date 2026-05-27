import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';

export type SkillTarget = 'properties' | 'rename' | 'ghostlink' | 'classify';

export interface SkillResult {
    status: string;
    data: string | null; // JSON string
    timestamp: number;
}

export interface RenameResult {
    status: string;
    old_path: string;
    new_path: string;
    new_title: string;
}

async function emitProgress(path: string, skill: string, status: 'started' | 'running' | 'completed' | 'failed', preview?: string) {
    // path aggregation usually happens in backend log_skill_progress but here we emulate it
    // The UI expects "relative path" or similar.
    // simpler to just emit what we have.
    await emit('ai:skill-progress', { path, skill, status, preview });
}

/**
 * Orchestrates atomic AI skills in a dependency chain.
 * 
 * Flow:
 * 1. Summary + Tagging (Parallel)
 * 2. Smart Rename (Dependent on content, summary helps but not strict)
 * 3. Classification / GhostLinks (Dependent on stable path)
 */
export async function runSkillChain(
    notePath: string,
    content: string,
    target: SkillTarget
): Promise<string> {
    let currentPath = notePath;

    try {
        const chainStart = performance.now();
        console.debug(`✨ [Orchestrator] Starting chain for ${target} on ${currentPath}`);

        // 🎯 激活当前笔记 AI 注册，清除可能残留的 Abort 熔断状态，允许重新计算顺利执行
        try {
            await invoke('register_active_note_ai', { notePath: currentPath });
        } catch (e) {
            console.warn(`[Orchestrator] Failed to register active note AI:`, e);
        }

        // Helper: run a skill with timing + error isolation
        const runSkillSafe = async (name: string, fn: () => Promise<SkillResult>): Promise<SkillResult | null> => {
            const t0 = performance.now();
            console.debug(`⏱️ [Orchestrator] ${name} → START  (T+${(t0 - chainStart).toFixed(0)}ms)`);
            try {
                const res = await fn();
                const elapsed = performance.now() - t0;
                console.debug(`⏱️ [Orchestrator] ${name} → DONE   (${elapsed.toFixed(0)}ms, status=${res.status})`);
                return res;
            } catch (e) {
                const elapsed = performance.now() - t0;
                console.error(`⏱️ [Orchestrator] ${name} → FAILED (${elapsed.toFixed(0)}ms):`, e);
                await emitProgress(currentPath, name, 'failed');
                return null;
            }
        };

        // STEP 1: Summary → Tagging (Sequential to avoid API rate-limit / concurrent request timeout)
        await emitProgress(currentPath, 'summarization', 'started');
        const summaryRes = await runSkillSafe('summarization', () =>
            invoke<SkillResult>('run_summary', { notePath: currentPath, content })
        );

        if (summaryRes) {
            const preview = summaryRes.status === 'skipped' ? 'Cached' : (summaryRes.data ? 'Summary updated' : undefined);
            await emitProgress(currentPath, 'summarization', 'completed', preview);
        }

        await emitProgress(currentPath, 'tagging', 'started');
        const taggingRes = await runSkillSafe('tagging', () =>
            invoke<SkillResult>('run_tagging', { notePath: currentPath, content })
        );

        // Handle Tagging Result
        let tagsPreview: string | undefined;
        if (taggingRes) {
            try {
                if (taggingRes.status === 'skipped') {
                    tagsPreview = 'Cached';
                } else if (taggingRes.data) {
                    const tags = JSON.parse(taggingRes.data);
                    if (Array.isArray(tags)) tagsPreview = tags.join(', ');
                }
            } catch { }
            await emitProgress(currentPath, 'tagging', 'completed', tagsPreview);
        }

        const step1Elapsed = performance.now() - chainStart;
        console.debug(`⏱️ [Orchestrator] STEP1 total: ${step1Elapsed.toFixed(0)}ms | Summary: ${summaryRes?.status ?? 'failed'}, Tags: ${taggingRes?.status ?? 'failed'}`);

        // Emit note updated event so PropertiesPanel refreshes (if anything succeeded)
        if (summaryRes || taggingRes) {
            await emit('ai:note-updated', { path: currentPath });
        }

        // If target is just properties, we are done
        if (target === 'properties') {
            return currentPath;
        }

        // STEP 2: Smart Rename (for rename & classify targets)
        if (target === 'rename' || target === 'classify') {
            await emitProgress(currentPath, 'smart_rename', 'started');

            // SIGNAL START: Tell App.tsx we are about to rename, so it ignores the upcoming FS events
            await emit('smart-rename:started', { path: currentPath });

            const renameRes = await invoke<RenameResult>('run_smart_rename', { notePath: currentPath, content });

            if (renameRes.status === 'success' && renameRes.new_path) {
                console.debug(`✨ [Orchestrator] Renamed to ${renameRes.new_path}`);
                await emit('smart-rename:completed', {
                    old_path: currentPath,
                    new_path: renameRes.new_path,
                    ai_title: renameRes.new_title,
                    skipped: false
                });
                currentPath = renameRes.new_path;
            } else if (renameRes.status === 'skipped') {
                await emit('smart-rename:completed', {
                    old_path: currentPath,
                    new_path: '',
                    ai_title: '',
                    skipped: true
                });
            }
            const renamePreview = renameRes.status === 'skipped' ? 'Cached' : undefined;
            await emitProgress(currentPath, 'smart_rename', 'completed', renamePreview);

            // If target is just rename, we are done
            if (target === 'rename') {
                return currentPath;
            }
        }

        // STEP 3: Classification
        if (target === 'classify') {
            // ClassificationPanel handles the actual classification call via loadSuggestions.
            // We just ensured prerequisites (summary, tagging, rename) are done.
        }

        console.debug(`✨ [Orchestrator] Chain complete for ${target}`);
        return currentPath;

    } catch (e) {
        console.error("❌ [Orchestrator] Chain failed:", e);
        throw e;
    }
}
