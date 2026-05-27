import { JSDOM } from 'jsdom';

// 1. 初始化 JSDOM
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor"></div></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
global.navigator = dom.window.navigator;

// 2. 导入依赖
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { MixedListItem, MixedTaskList, MixedTaskItem, MixedListKeymap } from './MixedListExtension.mock.js';

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
      bulletList: false,
      orderedList: false,
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
                          serialized1.includes('  - [ ] 二级任务列表项 A1') &&
                          serialized1.includes('  - [x] 二级任务列表项 A2');

  // 测试 Backspace 交互 (Bug 13)
  const posA1 = findTextPosition(editor, '二级任务列表项 A1');
  if (posA1 !== -1) {
    editor.commands.setTextSelection(posA1);
    // 模拟 Backspace 触发 safeLiftListItem
    const backspaceResult = editor.commands.keyboardShortcut('Backspace');
    const serializedAfterBackspace = editor.storage.markdown.getMarkdown().trim();
    
    // 预期：A1 变成一级无序，A2 缩进一级
    const liftOK = serializedAfterBackspace.includes('- 一级无序列表项 A\n- 二级任务列表项 A1\n  - [x] 二级任务列表项 A2');
    
    logTestResult("场景 1 (一级无序 -> 二级任务)", hasCorrectStructure && serializationOK && liftOK, {
      "AST Structure Check": hasCorrectStructure ? 'OK' : 'FAIL',
      "Serialization Check": serializationOK ? 'OK' : 'FAIL',
      "Backspace Lift Check": liftOK ? 'OK' : 'FAIL',
      "Markdown Before": md1,
      "Markdown After Backspace": serializedAfterBackspace
    });
  } else {
    logTestResult("场景 1 (一级无序 -> 二级任务)", false, { error: "Could not find text '二级任务列表项 A1' in document." });
  }
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
  const serializationOK = serialized2.includes('- [ ] 一级任务列表项 A') &&
                          serialized2.includes('  - 二级无序列表项 A1') &&
                          serialized2.includes('  - 二级无序列表项 A2');

  // 测试 Backspace 交互 (Bug 13)
  const posA1 = findTextPosition(editor, '二级无序列表项 A1');
  if (posA1 !== -1) {
    editor.commands.setTextSelection(posA1);
    // 模拟 Backspace 触发 safeLiftListItem
    const backspaceResult = editor.commands.keyboardShortcut('Backspace');
    const serializedAfterBackspace = editor.storage.markdown.getMarkdown().trim();
    
    // 预期：二级无序 A1 转换为一级任务列表项
    const liftOK = serializedAfterBackspace.includes('- [ ] 一级任务列表项 A\n- [ ] 二级无序列表项 A1\n  - 二级无序列表项 A2');
    
    logTestResult("场景 2 (一级任务 -> 二级无序)", hasCorrectStructure && serializationOK && liftOK, {
      "AST Structure Check": hasCorrectStructure ? 'OK' : 'FAIL',
      "Serialization Check": serializationOK ? 'OK' : 'FAIL',
      "Backspace Lift Check": liftOK ? 'OK' : 'FAIL',
      "Markdown Before": md2,
      "Markdown After Backspace": serializedAfterBackspace
    });
  } else {
    logTestResult("场景 2 (一级任务 -> 二级无序)", false, { error: "Could not find text '二级无序列表项 A1' in document." });
  }
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
  const serializationOK = serialized3.includes('- [ ] 一级任务项') &&
                          serialized3.includes('  - 二级无序项') &&
                          serialized3.includes('    - [ ] 三级任务项');

  // 测试 Backspace 交互 (Bug 13)
  const posA3 = findTextPosition(editor, '三级任务项');
  if (posA3 !== -1) {
    editor.commands.setTextSelection(posA3);
    
    // 第一次退格，预期从三级任务（taskItem）提升为二级无序（listItem）
    editor.commands.keyboardShortcut('Backspace');
    const serializedAfterBackspace1 = editor.storage.markdown.getMarkdown().trim();
    const lift1OK = serializedAfterBackspace1.includes('- [ ] 一级任务项\n  - 二级无序项\n  - 三级任务项');
    
    // 连续第二次退格，预期从二级无序（listItem）提升为一级任务（taskItem）
    // 先重新定位光标到“三级任务项”的最前部
    const posA3_2 = findTextPosition(editor, '三级任务项');
    editor.commands.setTextSelection(posA3_2);
    editor.commands.keyboardShortcut('Backspace');
    const serializedAfterBackspace2 = editor.storage.markdown.getMarkdown().trim();
    const lift2OK = serializedAfterBackspace2.includes('- [ ] 一级任务项\n- [ ] 三级任务项\n  - 二级无序项'); // 嵌套结构转移

    logTestResult("场景 3 (三级混合嵌套: 任务 -> 无序 -> 任务)", hasCorrectStructure && serializationOK && lift1OK && lift2OK, {
      "AST Structure Check": hasCorrectStructure ? 'OK' : 'FAIL',
      "Serialization Check": serializationOK ? 'OK' : 'FAIL',
      "First Backspace Lift Check": lift1OK ? 'OK' : 'FAIL',
      "Second Backspace Lift Check": lift2OK ? 'OK' : 'FAIL',
      "Markdown Before": md3,
      "Markdown After First Backspace": serializedAfterBackspace1,
      "Markdown After Second Backspace": serializedAfterBackspace2
    });
  } else {
    logTestResult("场景 3 (三级混合嵌套)", false, { error: "Could not find text '三级任务项' in document." });
  }
} catch (e) {
  logTestResult("场景 3 (三级混合嵌套)", false, { error: e.stack });
}

console.log("\n🏁 E2E Regression Tests Completed.");
process.exit(0);
