import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor"></div></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
if (!global.navigator) {
  global.navigator = dom.window.navigator;
} else {
  Object.defineProperty(global, 'navigator', {
    value: dom.window.navigator,
    writable: true,
    configurable: true
  });
}
global.KeyboardEvent = dom.window.KeyboardEvent;
global.MouseEvent = dom.window.MouseEvent;
global.FocusEvent = dom.window.FocusEvent;
global.Event = dom.window.Event;
global.CustomEvent = dom.window.CustomEvent;
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { MixedListItem, MixedTaskList, MixedTaskItem, MixedListKeymap } from './src/extensions/MixedListExtension.mock.ts';
import { TextSelection } from '@tiptap/pm/state';

const editor = new Editor({
  element: dom.window.document.getElementById('editor'),
  extensions: [
    StarterKit.configure({
      taskList: false,
      taskItem: false,
      listItem: false,
    }),
    MixedListItem,
    MixedTaskList,
    MixedTaskItem,
    MixedListKeymap,
    Markdown.configure({
      html: false,
      breaks: true,
      tightLists: true,
      bulletListMarker: '-',
    }),
  ],
});

try {
  const md = `- [ ] 任务\n  1. 序号1\n  2. X`;
  editor.commands.setContent(md);
  
  // 1. 删除 'X' 并将光标放在那里
  editor.commands.command(({ tr }) => {
    let foundPos = -1;
    tr.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'X') {
        foundPos = pos;
        return false;
      }
    });
    if (foundPos !== -1) {
      tr.delete(foundPos, foundPos + 1);
      tr.setSelection(TextSelection.create(tr.doc, foundPos));
    }
    return true;
  });
  
  const printSelection = (label) => {
    const { selection } = editor.state;
    const { $from } = selection;
    let path = [];
    for (let d = 0; d <= $from.depth; d++) {
      path.push($from.node(d).type.name);
    }
    console.log(`[${label}] Cursor pos: ${selection.from}, depth: ${$from.depth}, path: ${path.join(' -> ')}`);
  };

  console.log("--- 初始状态 (删除X后) ---");
  printSelection("初始");
  console.log(editor.storage.markdown.getMarkdown().trim());
  console.log("JSON AST:");
  console.log(JSON.stringify(editor.getJSON(), null, 2));
  
  // 2. 第一次退格 (提升为一级空任务项)
  editor.commands.keyboardShortcut('Backspace');
  console.log("\n--- 第一步退格后 ---");
  printSelection("第一步");
  console.log(editor.storage.markdown.getMarkdown().trim());
  console.log("JSON AST:");
  console.log(JSON.stringify(editor.getJSON(), null, 2));
  
  // 3. 第二次退格 (变成普通空段落)
  editor.commands.keyboardShortcut('Backspace');
  console.log("\n--- 第二步退格后 ---");
  printSelection("第二步");
  console.log(editor.storage.markdown.getMarkdown().trim());
  console.log("JSON AST:");
  console.log(JSON.stringify(editor.getJSON(), null, 2));
 
  // 4. 第三次退格 (预期：光标移到 序号1 后面，当前段落被删除)
  editor.commands.keyboardShortcut('Backspace');
  console.log("\n--- 第三步退格后 ---");
  printSelection("第三步");
  console.log(editor.storage.markdown.getMarkdown().trim());
  console.log("JSON AST:");
  console.log(JSON.stringify(editor.getJSON(), null, 2));

} catch (e) {
  console.error(e);
}
process.exit(0);
