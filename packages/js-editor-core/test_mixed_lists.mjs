import { JSDOM } from 'jsdom';

// 1. 初始化 JSDOM
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

// Mock requestAnimationFrame for Tiptap focus command in Node/JSDOM
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);

// 2. 导入依赖
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { MixedListItem, MixedTaskList, MixedTaskItem, MixedListKeymap } from './src/extensions/MixedListExtension.mock.ts';

// Helper: 寻找文档中指定文本的起始位置
function findTextPosition(editor, text) {
  let foundPos = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text.includes(text)) {
      foundPos = pos + node.text.indexOf(text);
      return false; // stop iteration
    }
  });
  return foundPos;
}

// Helper: 打印测试结果
function logTestResult(scenarioName, passed, details = {}) {
  console.log(`\n[Scenario] ${scenarioName} -> ${passed ? '✅ PASSED' : '❌ FAILED'}`);
  if (!passed || Object.keys(details).length > 0) {
    console.log(JSON.stringify(details, null, 2));
  }
}

// 初始化编辑器
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

console.log("🚀 Starting E2E Regression Tests for Mixed List Bugs (Bug 11, 12, 13)...");

// =========================================================================
// 场景 1：第一级是无序列表，第二级是任务列表
// =========================================================================
try {
  const md1 = `- 一级无序列表项 A\n  - [ ] 二级任务列表项 A1\n  - [x] 二级任务列表项 A2`;
  editor.commands.setContent(md1);
  
  const serialized1 = editor.storage.markdown.getMarkdown().trim();
  const json1 = editor.getJSON();
  
  // 校验 AST 结构
  const hasCorrectStructure = 
    json1.content[0].type === 'bulletList' &&
    json1.content[0].content[0].type === 'listItem' &&
    json1.content[0].content[0].content[1].type === 'taskList';
  
  // 检查序列化是否保留了正确的 markdown 标记 (修复 Bug 11, 防止普通列表项混入空 checkbox)
  const serializationOK = serialized1.includes('- 一级无序列表项 A') &&
                          serialized1.includes('* [ ] 二级任务列表项 A1') &&
                          serialized1.includes('* [x] 二级任务列表项 A2');

  logTestResult("场景 1 (一级无序 -> 二级任务)", hasCorrectStructure && serializationOK, {
    "AST Structure Check": hasCorrectStructure ? 'OK' : 'FAIL',
    "Serialization Check": serializationOK ? 'OK' : 'FAIL',
    "Markdown Before": md1,
    "Serialized Markdown": serialized1,
    "JSON AST": JSON.stringify(json1, null, 2)
  });
} catch (e) {
  logTestResult("场景 1 (一级无序 -> 二级任务)", false, { error: e.stack });
}

// =========================================================================
// 场景 2：第一级是任务列表，第二级是无序列表
// =========================================================================
try {
  const md2 = `- [ ] 一级任务列表项 A\n  - 二级无序列表项 A1\n  - 二级无序列表项 A2`;
  editor.commands.setContent(md2);
  
  const serialized2 = editor.storage.markdown.getMarkdown().trim();
  const json2 = editor.getJSON();
  
  // 校验 AST 结构
  const hasCorrectStructure = 
    json2.content[0].type === 'taskList' &&
    json2.content[0].content[0].type === 'taskItem' &&
    json2.content[0].content[0].content[1].type === 'bulletList';
    
  // 检查序列化是否保留了正确的 markdown 标记 (二级无序列表项没有 [ ])
  const serializationOK = serialized2.includes('* [ ] 一级任务列表项 A') &&
                          serialized2.includes('- 二级无序列表项 A1') &&
                          serialized2.includes('- 二级无序列表项 A2');

  logTestResult("场景 2 (一级任务 -> 二级无序)", hasCorrectStructure && serializationOK, {
    "AST Structure Check": hasCorrectStructure ? 'OK' : 'FAIL',
    "Serialization Check": serializationOK ? 'OK' : 'FAIL',
    "Markdown Before": md2,
    "Serialized Markdown": serialized2,
    "JSON AST": JSON.stringify(json2, null, 2)
  });
} catch (e) {
  logTestResult("场景 2 (一级任务 -> 二级无序)", false, { error: e.stack });
}

// =========================================================================
// 场景 3：多级混合嵌套（一级任务 -> 二级无序 -> 三级任务）
// =========================================================================
try {
  const md3 = `- [ ] 一级任务项\n  - 二级无序项\n    - [ ] 三级任务项`;
  editor.commands.setContent(md3);
  
  const serialized3 = editor.storage.markdown.getMarkdown().trim();
  const json3 = editor.getJSON();
  
  // 校验 AST 结构
  const hasCorrectStructure = 
    json3.content[0].type === 'taskList' &&
    json3.content[0].content[0].type === 'taskItem' &&
    json3.content[0].content[0].content[1].type === 'bulletList' &&
    json3.content[0].content[0].content[1].content[0].content[1].type === 'taskList';
    
  // 检查序列化是否完美保留了每一层前缀 (Bug 11)
  const serializationOK = serialized3.includes('* [ ] 一级任务项') &&
                          serialized3.includes('- 二级无序项') &&
                          serialized3.includes('* [ ] 三级任务项');

  logTestResult("场景 3 (三级混合嵌套: 任务 -> 无序 -> 任务)", hasCorrectStructure && serializationOK, {
    "AST Structure Check": hasCorrectStructure ? 'OK' : 'FAIL',
    "Serialization Check": serializationOK ? 'OK' : 'FAIL',
    "Markdown Before": md3,
    "Serialized Markdown": serialized3,
    "JSON AST": JSON.stringify(json3, null, 2)
  });
} catch (e) {
  logTestResult("场景 3 (三级混合嵌套)", false, { error: e.stack });
}

// =========================================================================
// 场景 4：一级有序，二级空任务，在二级行首按退格键 (Backspace) 提升
// =========================================================================
import { TextSelection } from '@tiptap/pm/state';

try {
  const md4 = `1. 一级有序列表项\n    - [ ] X`;
  editor.commands.setContent(md4);
  
  // 程序化删除占位符 'X' 并将光标正确定位在空段落中
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
  
  // 模拟退格键 Backspace (由于光标处于空嵌套项的首位，它会触发提升)
  editor.commands.keyboardShortcut('Backspace');
  
  const serialized4 = editor.storage.markdown.getMarkdown().trim();
  
  // 断言 1：一级有序项不能退化为普通文本，必须保留 "1. 一级有序列表项" 标记
  const firstItemPreserved = serialized4.includes('1. 一级有序列表项');
  // 断言 2：二级任务项应提升为一级有序
  const ast4 = editor.getJSON();
  const listItemsCount = ast4.content[0].content.length;
  const liftedCorrectly = listItemsCount >= 2 && ast4.content[0].content[1].type === 'listItem';
  
  logTestResult("场景 4 (二级空任务退格提升 -> 一级有序)", firstItemPreserved && liftedCorrectly, {
    "First Item Preserved": firstItemPreserved ? 'OK' : 'FAIL (Bug 13: 误伤一级崩溃)',
    "Lifted Correctly": liftedCorrectly ? 'OK' : 'FAIL',
    "List Items Count (Expected >= 2)": listItemsCount,
    "Serialized Markdown": serialized4
  });
} catch (e) {
  logTestResult("场景 4 (二级空任务退格提升 -> 一级有序)", false, { error: e.stack });
}

// =========================================================================
// 场景 5：一级任务，二级空有序，在二级行首按退格键 (Backspace) 提升
// =========================================================================
try {
  const md5 = `- [ ] 一级任务列表项\n    1. X`;
  editor.commands.setContent(md5);
  
  // 程序化删除占位符 'X' 并将光标正确定位在空段落中
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
  
  // 模拟退格键 Backspace (由于光标处于空嵌套项的首位，它会触发提升)
  editor.commands.keyboardShortcut('Backspace');
  
  const serialized5 = editor.storage.markdown.getMarkdown().trim();
  
  // 断言 1：一级任务项不能退化为普通文本，必须保留 "* [ ] 一级任务列表项" 标记
  const firstItemPreserved = serialized5.includes('* [ ] 一级任务列表项');
  // 断言 2：二级有序项应提升为一级任务列表项
  const ast5 = editor.getJSON();
  const taskItemsCount = ast5.content[0].content.length;
  const liftedCorrectly = taskItemsCount >= 2 && ast5.content[0].content[1].type === 'taskItem';
  
  logTestResult("场景 5 (二级空有序退格提升 -> 一级任务)", firstItemPreserved && liftedCorrectly, {
    "First Item Preserved": firstItemPreserved ? 'OK' : 'FAIL (Bug 13: 误伤一级崩溃)',
    "Lifted Correctly": liftedCorrectly ? 'OK' : 'FAIL',
    "Task Items Count (Expected >= 2)": taskItemsCount,
    "Serialized Markdown": serialized5
  });
} catch (e) {
  logTestResult("场景 5 (二级空有序退格提升 -> 一级任务)", false, { error: e.stack });
}

console.log("\n🏁 E2E Regression Tests Completed.");
process.exit(0);
