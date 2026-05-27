import Blockquote from '@tiptap/extension-blockquote';
import { InputRule } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

// 模块级时间戳守卫，防止同一交互在微任务/拼音组合阶段高频重入触发
let lastTriggerTime = 0;

export const CustomBlockquote = Blockquote.extend({
    addInputRules() {
        return [
            new InputRule({
                find: /^\s*>\s$/,
                handler: ({ state }) => {
                    const now = Date.now();
                    if (now - lastTriggerTime < 150) {
                        // 💡 关键加固：防抖时直接 return (返回 undefined) 拦截默认输入，防止多余的字符原样插入到编辑器中
                        return;
                    }

                    const { tr } = state;
                    const $from = tr.selection.$from;

                    // 1. 强力防重入守卫：若当前已在 blockquote 中，立即退出并拦截输入
                    let inBlockquote = false;
                    for (let d = $from.depth; d > 0; d--) {
                        if ($from.node(d).type.name === 'blockquote') {
                            inBlockquote = true;
                            break;
                        }
                    }
                    if (inBlockquote) return;

                    // 确保是普通段落
                    if ($from.parent.type.name !== 'paragraph') return;

                    // 更新最后触发时间，拦截后续 150ms 内的并发重入
                    lastTriggerTime = now;

                    // 2. 原子的段落替换为单行引用块并精确定位光标
                    // 获取当前空段落的起止位置
                    const start = $from.before(1);
                    const end = $from.after(1);

                    // 创建一个包含单个空段落的 blockquote 节点 (共 1 行)
                    // 引号完全由 Tailwind CSS / Tiptap 默认伪元素渲染，物理上不插入任何引号字符，防范重复双引号
                    const blockquoteNode = state.schema.nodes.blockquote.create(null, [
                        state.schema.nodes.paragraph.create(null)
                    ]);

                    // 执行原子替换，将当前段落替换为单行引用块
                    tr.replaceWith(start, end, blockquoteNode);
                    
                    // 💡 关键选区定位：光标定位在唯一的空段落行首，视觉上刚好位于伪元素前引号与后引号的中间 “|”
                    // start + 1 (blockquote开始) + 1 (第一个paragraph开始) = start + 2
                    const targetPos = start + 2;
                    tr.setSelection(TextSelection.create(tr.doc, targetPos));
                },
            }),
        ];
    },
});



