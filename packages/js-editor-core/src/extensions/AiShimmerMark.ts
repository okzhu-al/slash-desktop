/**
 * AiShimmerMark — 最小 TipTap Mark 扩展
 * 
 * 为文本施加 `.ai-shimmer` CSS 类，产生流光渐变加载效果。
 * 用于 AI Skill 执行期间的等待状态视觉反馈。
 */

import { Mark } from '@tiptap/core';

export const AiShimmerMark = Mark.create({
    name: 'aiShimmer',

    // 无需任何属性
    addAttributes() {
        return {};
    },

    parseHTML() {
        return [{ tag: 'span.ai-shimmer' }];
    },

    renderHTML() {
        return ['span', { class: 'ai-shimmer' }, 0];
    },
});
