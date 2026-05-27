/**
 * DiffOverlayExtension — PM 节点级对比 + 涂色 (v6)
 *
 * 核心思路：
 * - DiffOverlay 只负责设置 diff 数据和渲染装饰
 * - 内容替换（setContent）由 Editor.tsx 在 command 外部完成（避免嵌套 dispatch）
 * - 不合并 delete+insert 为 replace（避免不相关块错误配对）
 *
 * 命令：
 * - activateDiff(originalNodes, proposedNodes): 计算 diff + 激活装饰
 * - deactivateDiff(): 清除 diff + 关闭装饰
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

// ============================================================
// Types
// ============================================================

export interface NodeHash {
    hash: string;
    textContent: string;
    markdownSource?: string;  // 用于删除 widget 的 markdown 渲染
}

interface BlockDiff {
    type: 'equal' | 'insert' | 'delete';
    oldNode?: NodeHash;
    newNode?: NodeHash;
}

export interface DiffOverlayStorage {
    diffs: BlockDiff[];
    isActive: boolean;
    originalContent: string;
}

const diffOverlayPluginKey = new PluginKey('diffOverlay');

// ============================================================
// 公开工具函数（供 Editor.tsx 调用）
// ============================================================

/** 提取文档的每个顶层节点的文本 hash */
export function serializeDocNodes(doc: PMNode): NodeHash[] {
    const nodes: NodeHash[] = [];
    doc.forEach((node) => {
        const text = node.textContent;
        nodes.push({ hash: simpleHash(text), textContent: text });
    });
    return nodes;
}

/** 剥离 YAML frontmatter */
export function stripFrontmatter(md: string): string {
    if (md.startsWith('---')) {
        const endIdx = md.indexOf('\n---', 3);
        if (endIdx !== -1) {
            return md.substring(endIdx + 4).replace(/^\n+/, '');
        }
    }
    return md;
}

function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash = hash & hash;
    }
    return hash.toString(36);
}

// ============================================================
// Extension
// ============================================================

export const DiffOverlayExtension = Extension.create<Record<string, never>, DiffOverlayStorage>({
    name: 'diffOverlay',

    addStorage() {
        return {
            diffs: [],
            isActive: false,
            originalContent: '',
        };
    },

    addCommands() {
        return {
            /**
             * 激活 diff 装饰。
             * 调用前：Editor.tsx 已完成 setContent(proposedBody) 替换
             * 调用后：plugin apply 检测到 isActive=true 时自动构建装饰
             */
            activateDiff: (originalNodes: NodeHash[], proposedNodes: NodeHash[], originalMd: string) => ({ editor }) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const storage = (editor.storage as any).diffOverlay as DiffOverlayStorage;
                storage.diffs = computeBlockDiff(originalNodes, proposedNodes);
                storage.originalContent = originalMd;
                storage.isActive = true;

                const changes = storage.diffs.filter(d => d.type !== 'equal');
                console.log('[DiffOverlay v6] Activated with', changes.length, 'changes');

                // 发送 meta 触发一次装饰重建
                editor.view.dispatch(editor.state.tr.setMeta('diffOverlay', true));
                return true;
            },
            /**
             * 关闭 diff 装饰。
             * 调用后：Editor.tsx 负责 setContent(original) 恢复原文
             */
            deactivateDiff: () => ({ editor }) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const storage = (editor.storage as any).diffOverlay as DiffOverlayStorage;
                if (!storage.isActive) return true; // 幂等保护

                storage.diffs = [];
                storage.isActive = false;
                storage.originalContent = '';

                editor.view.dispatch(editor.state.tr.setMeta('diffOverlay', true));
                return true;
            },
        };
    },

    addProseMirrorPlugins() {
        const extension = this;

        return [
            new Plugin({
                key: diffOverlayPluginKey,
                state: {
                    init() { return DecorationSet.empty; },
                    apply(tr, oldDecorations, _oldState, newState) {
                        const storage = extension.storage;
                        if (tr.getMeta('diffOverlay')) {
                            if (!storage.isActive || storage.diffs.length === 0) {
                                return DecorationSet.empty;
                            }
                            return buildDecorations(newState.doc, storage.diffs);
                        }
                        if (storage.isActive && !tr.docChanged) {
                            return oldDecorations;
                        }
                        return storage.isActive ? buildDecorations(newState.doc, storage.diffs) : DecorationSet.empty;
                    },
                },
                props: {
                    decorations(state) { return this.getState(state); },
                },
            }),
        ];
    },
});

// ============================================================
// LCS Diff（不合并 delete+insert → 避免错误配对）
// ============================================================

function computeBlockDiff(oldNodes: NodeHash[], newNodes: NodeHash[]): BlockDiff[] {
    const m = oldNodes.length;
    const n = newNodes.length;

    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldNodes[i - 1].hash === newNodes[j - 1].hash) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    const reverseDiffs: BlockDiff[] = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldNodes[i - 1].hash === newNodes[j - 1].hash) {
            reverseDiffs.push({ type: 'equal' });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            reverseDiffs.push({ type: 'insert', newNode: newNodes[j - 1] });
            j--;
        } else {
            reverseDiffs.push({ type: 'delete', oldNode: oldNodes[i - 1] });
            i--;
        }
    }

    // 反转得到正序（不再合并 delete+insert）
    const result: BlockDiff[] = [];
    for (let k = reverseDiffs.length - 1; k >= 0; k--) {
        result.push(reverseDiffs[k]);
    }
    return result;
}

// ============================================================
// 装饰构建（基于建议稿文档）
// ============================================================

function buildDecorations(doc: PMNode, diffs: BlockDiff[]): DecorationSet {
    const decorations: Decoration[] = [];

    const blockPositions: Array<{ from: number; to: number }> = [];
    doc.forEach((node, offset) => {
        blockPositions.push({ from: offset, to: offset + node.nodeSize });
    });

    // docBlockIdx 跟踪建议稿块（insert/equal 消耗，delete 不消耗）
    let docBlockIdx = 0;

    for (const diff of diffs) {
        if (diff.type === 'equal') {
            docBlockIdx++;
        } else if (diff.type === 'insert') {
            // 建议稿中新增的块 → 绿色背景
            if (docBlockIdx < blockPositions.length) {
                const pos = blockPositions[docBlockIdx];
                decorations.push(Decoration.node(pos.from, pos.to, { class: 'diff-block-added' }));
                docBlockIdx++;
            }
        } else if (diff.type === 'delete') {
            // 原文中被删除的块 → 红色 widget
            const insertAt = docBlockIdx < blockPositions.length
                ? blockPositions[docBlockIdx].from
                : doc.content.size;
            if (diff.oldNode?.textContent) {
                decorations.push(createDeleteWidget(insertAt, diff.oldNode));
            }
        }
    }

    return DecorationSet.create(doc, decorations);
}

function createDeleteWidget(pos: number, node: NodeHash): Decoration {
    return Decoration.widget(pos, () => {
        const wrapper = document.createElement('div');
        wrapper.className = 'diff-block-deleted';
        const content = document.createElement('div');
        content.className = 'diff-deleted-content';
        content.innerHTML = simpleMarkdownToHtml(node.markdownSource || node.textContent);
        wrapper.appendChild(content);
        return wrapper;
    }, { side: -1 });
}

/** 简单 markdown → HTML 渲染（仅支持标题、列表、加粗、斜体、行内代码） */
function simpleMarkdownToHtml(md: string): string {
    const lines = md.split('\n');
    const htmlParts: string[] = [];
    let inList = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            if (inList) { htmlParts.push('</ul>'); inList = false; }
            continue;
        }

        // 标题
        const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
        if (headingMatch) {
            if (inList) { htmlParts.push('</ul>'); inList = false; }
            const level = headingMatch[1].length;
            htmlParts.push(`<h${level}>${inlineFormat(headingMatch[2])}</h${level}>`);
            continue;
        }

        // 无序列表
        const listMatch = trimmed.match(/^[-*+]\s+(.+)/);
        if (listMatch) {
            if (!inList) { htmlParts.push('<ul>'); inList = true; }
            htmlParts.push(`<li>${inlineFormat(listMatch[1])}</li>`);
            continue;
        }

        // 普通段落
        if (inList) { htmlParts.push('</ul>'); inList = false; }
        htmlParts.push(`<p>${inlineFormat(trimmed)}</p>`);
    }
    if (inList) htmlParts.push('</ul>');
    return htmlParts.join('');
}

/** 行内格式：加粗、斜体、行内代码 */
function inlineFormat(text: string): string {
    return text
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

// ============================================================
// Type augmentation
// ============================================================

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        diffOverlay: {
            activateDiff: (originalNodes: NodeHash[], proposedNodes: NodeHash[], originalMd: string) => ReturnType;
            deactivateDiff: () => ReturnType;
        };
    }
}
