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
global.InputEvent = dom.window.InputEvent;
global.CompositionEvent = dom.window.CompositionEvent;
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

// =========================================================================
// 场景 6：中文 IME 选词完成后不能把第二行任务项替换成普通段落
// =========================================================================
try {
  const md6 = `- [ ] 第一行\n- [ ] 第二行\n- [ ] 第三行`;
  editor.commands.setContent(md6);

  const secondTextPos = findTextPosition(editor, '第二行');
  editor.commands.command(({ tr }) => {
    tr.setSelection(TextSelection.create(tr.doc, secondTextPos + 1));
    return true;
  });

  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true, data: 'zhongwen' }));
  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '中文' }));

  let secondTaskPos = -1;
  let secondTaskNode = null;
  let taskIndex = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'taskItem') return true;
    taskIndex += 1;
    if (taskIndex === 2) {
      secondTaskPos = pos;
      secondTaskNode = node;
      return false;
    }
    return true;
  });

  const badParagraph = editor.schema.nodes.paragraph.create(null, editor.schema.text('中文输入'));
  const badTr = editor.state.tr.replaceWith(
    secondTaskPos,
    secondTaskPos + secondTaskNode.nodeSize,
    badParagraph
  );
  badTr.setMeta('composition', true);
  editor.view.dispatch(badTr);

  const serialized6 = editor.storage.markdown.getMarkdown().trim();
  const taskItemCount = [];
  editor.state.doc.descendants(node => {
    if (node.type.name === 'taskItem') taskItemCount.push(node);
  });

  const secondTaskPreserved = serialized6.includes('* [ ] 第二行') && taskItemCount.length === 3;

  logTestResult("场景 6 (IME 选词后不得删除第二行任务 checkbox)", secondTaskPreserved, {
    "Second Task Preserved": secondTaskPreserved ? 'OK' : 'FAIL',
    "Task Item Count": taskItemCount.length,
    "Serialized Markdown": serialized6
  });
} catch (e) {
  logTestResult("场景 6 (IME 选词后不得删除第二行任务 checkbox)", false, { error: e.stack });
}

// =========================================================================
// 场景 7：第二行行首中文 IME 临时拼音必须在选词提交时清除
// =========================================================================
try {
  const md7 = `- [ ] 第一行\n- [ ] 尾巴\n- [ ] 第三行`;
  editor.commands.setContent(md7);

  const secondParagraphTextStart = findTextPosition(editor, '尾巴');
  editor.commands.command(({ tr }) => {
    tr.setSelection(TextSelection.create(tr.doc, secondParagraphTextStart));
    return true;
  });

  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true, data: 'di er hang' }));
  editor.commands.insertContent('di er hang ');
  editor.view.dom.dispatchEvent(new dom.window.InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'deleteCompositionText',
    data: null,
  }));
  editor.commands.insertContent('第二行');
  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '第二行' }));

  const serialized7 = editor.storage.markdown.getMarkdown().trim();
  const pinyinCleared = serialized7.includes('* [ ] 第二行尾巴')
    && !serialized7.includes('di er hang')
    && !serialized7.includes('第二行第二行')
    && serialized7.includes('* [ ] 第三行');

  logTestResult("场景 7 (第二行行首 IME 临时拼音会被清除)", pinyinCleared, {
    "Pinyin Cleared": pinyinCleared ? 'OK' : 'FAIL',
    "Serialized Markdown": serialized7
  });
} catch (e) {
  logTestResult("场景 7 (第二行行首 IME 临时拼音会被清除)", false, { error: e.stack });
}

// =========================================================================
// 场景 8：第一行和第二行连续输入中文时，后续词不能吃掉前一个词
// =========================================================================
try {
  const md8 = `- [ ] 中文\n- [ ] 第一词\n- [ ] 第三行`;
  editor.commands.setContent(md8);

  const appendImeWord = (anchorText, pinyin, finalText) => {
    const anchorPos = findTextPosition(editor, anchorText);
    editor.commands.command(({ tr }) => {
      tr.setSelection(TextSelection.create(tr.doc, anchorPos + anchorText.length));
      return true;
    });
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true, data: pinyin }));
    editor.commands.insertContent(pinyin);
    editor.view.dom.dispatchEvent(new dom.window.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteCompositionText',
      data: null,
    }));
    editor.commands.insertContent(finalText);
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: finalText }));
  };

  appendImeWord('中文', 'shuru', '输入');
  appendImeWord('第一词', 'di er ci', '第二词');

  const serialized8 = editor.storage.markdown.getMarkdown().trim();
  const continuousInputOK = serialized8.includes('* [ ] 中文输入')
    && serialized8.includes('* [ ] 第一词第二词')
    && serialized8.includes('* [ ] 第三行')
    && !serialized8.includes('shuru')
    && !serialized8.includes('di er ci');

  logTestResult("场景 8 (连续中文输入不会吃掉前一个词)", continuousInputOK, {
    "Continuous Input": continuousInputOK ? 'OK' : 'FAIL',
    "Serialized Markdown": serialized8
  });
} catch (e) {
  logTestResult("场景 8 (连续中文输入不会吃掉前一个词)", false, { error: e.stack });
}

// =========================================================================
// 场景 9：insertFromComposition 提交候选词时只替换临时拼音
// =========================================================================
try {
  const md9 = `- [ ] 中文`;
  editor.commands.setContent(md9);

  const anchorPos = findTextPosition(editor, '中文');
  editor.commands.command(({ tr }) => {
    tr.setSelection(TextSelection.create(tr.doc, anchorPos + '中文'.length));
    return true;
  });
  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true, data: 'shuru' }));
  editor.commands.insertContent('shuru');
  editor.view.dom.dispatchEvent(new dom.window.InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertFromComposition',
    data: '输入',
  }));
  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '输入' }));

  const serialized9 = editor.storage.markdown.getMarkdown().trim();
  const insertFromCompositionOK = serialized9.includes('* [ ] 中文输入')
    && !serialized9.includes('shuru')
    && !serialized9.includes('* [ ] 输入');

  logTestResult("场景 9 (insertFromComposition 只替换拼音不吃前词)", insertFromCompositionOK, {
    "Insert From Composition": insertFromCompositionOK ? 'OK' : 'FAIL',
    "Serialized Markdown": serialized9
  });
} catch (e) {
  logTestResult("场景 9 (insertFromComposition 只替换拼音不吃前词)", false, { error: e.stack });
}

// =========================================================================
// 场景 10：IME 提交后浏览器补发的段落级替换不能吃掉已存在中文
// =========================================================================
try {
  const md10 = `- [ ] 一`;
  editor.commands.setContent(md10);

  const anchorPos = findTextPosition(editor, '一');
  editor.commands.command(({ tr }) => {
    tr.setSelection(TextSelection.create(tr.doc, anchorPos + '一'.length));
    return true;
  });
  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true, data: 'er' }));
  editor.commands.insertContent('er');
  editor.view.dom.dispatchEvent(new dom.window.InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertFromComposition',
    data: '二',
  }));

  // WebKit/IME can emit a late DOMObserver transaction at the task paragraph
  // start. It must not replace the existing committed prefix "一".
  editor.commands.command(({ state, tr, dispatch }) => {
    const textblockStart = state.selection.$from.start(state.selection.$from.depth);
    const textblockEnd = state.selection.$from.end(state.selection.$from.depth);
    tr.insertText('二', textblockStart, textblockEnd);
    dispatch?.(tr);
    return true;
  });
  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '二' }));

  const serialized10 = editor.storage.markdown.getMarkdown().trim();
  const destructiveCommitBlocked = serialized10.includes('* [ ] 一二')
    && !serialized10.includes('* [ ] 二');

  logTestResult("场景 10 (IME 段落级补发替换不能吃掉前词)", destructiveCommitBlocked, {
    "Destructive Commit Blocked": destructiveCommitBlocked ? 'OK' : 'FAIL',
    "Serialized Markdown": serialized10
  });
} catch (e) {
  logTestResult("场景 10 (IME 段落级补发替换不能吃掉前词)", false, { error: e.stack });
}

// =========================================================================
// 场景 11：未确认拼音退格后补发的清空段落不能删除整行
// =========================================================================
try {
  const md11 = `- [ ] 一`;
  editor.commands.setContent(md11);

  const anchorPos = findTextPosition(editor, '一');
  editor.commands.command(({ tr }) => {
    tr.setSelection(TextSelection.create(tr.doc, anchorPos + '一'.length));
    return true;
  });
  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true, data: 'c' }));
  editor.commands.insertContent('c');
  editor.view.dom.dispatchEvent(new dom.window.InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'deleteCompositionText',
    data: null,
  }));
  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '' }));

  // Some IMEs report cancellation by moving selection back to paragraph start
  // and the observer can try to clear the textblock. The committed prefix must stay.
  editor.commands.command(({ state, tr, dispatch }) => {
    const textblockStart = state.selection.$from.start(state.selection.$from.depth);
    const textblockEnd = state.selection.$from.end(state.selection.$from.depth);
    tr.delete(textblockStart, textblockEnd);
    dispatch?.(tr);
    return true;
  });

  const serialized11 = editor.storage.markdown.getMarkdown().trim();
  const backspaceCancellationSafe = serialized11.includes('* [ ] 一')
    && !serialized11.includes('c')
    && !serialized11.includes('* [ ] 一c');

  logTestResult("场景 11 (IME 退格取消不能删除整行)", backspaceCancellationSafe, {
    "Backspace Cancellation Safe": backspaceCancellationSafe ? 'OK' : 'FAIL',
    "Serialized Markdown": serialized11
  });
} catch (e) {
  logTestResult("场景 11 (IME 退格取消不能删除整行)", false, { error: e.stack });
}

// =========================================================================
// 场景 12：任务行首插入中文时不能吃掉后面的已有文字
// =========================================================================
try {
  const md12 = `- [ ] 后文`;
  editor.commands.setContent(md12);

  const anchorPos = findTextPosition(editor, '后文');
  editor.commands.command(({ tr }) => {
    tr.setSelection(TextSelection.create(tr.doc, anchorPos));
    return true;
  });
  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true, data: 'qian' }));
  editor.commands.insertContent('qian');
  editor.view.dom.dispatchEvent(new dom.window.InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertFromComposition',
    data: '前',
  }));

  // Late paragraph-level replacement may contain only the committed candidate.
  // The original suffix must remain.
  editor.commands.command(({ state, tr, dispatch }) => {
    const textblockStart = state.selection.$from.start(state.selection.$from.depth);
    const textblockEnd = state.selection.$from.end(state.selection.$from.depth);
    tr.insertText('前', textblockStart, textblockEnd);
    dispatch?.(tr);
    return true;
  });
  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '前' }));

  const serialized12 = editor.storage.markdown.getMarkdown().trim();
  const lineStartInsertionSafe = serialized12.includes('* [ ] 前后文')
    && !serialized12.includes('* [ ] 前\n')
    && !serialized12.endsWith('* [ ] 前');

  logTestResult("场景 12 (任务行首中文插入不能吃掉后文)", lineStartInsertionSafe, {
    "Line Start Insertion Safe": lineStartInsertionSafe ? 'OK' : 'FAIL',
    "Serialized Markdown": serialized12
  });
} catch (e) {
  logTestResult("场景 12 (任务行首中文插入不能吃掉后文)", false, { error: e.stack });
}

// =========================================================================
// 场景 13：任务行中间插入中文时不能吃掉后缀文字
// =========================================================================
try {
  const md13 = `- [ ] 前后`;
  editor.commands.setContent(md13);

  const anchorPos = findTextPosition(editor, '前后');
  editor.commands.command(({ tr }) => {
    tr.setSelection(TextSelection.create(tr.doc, anchorPos + '前'.length));
    return true;
  });
  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' }));
  editor.commands.insertContent('zhong');
  editor.view.dom.dispatchEvent(new dom.window.InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertFromComposition',
    data: '中',
  }));

  // Prefix is present in this replacement, but suffix is missing. Guard both.
  editor.commands.command(({ state, tr, dispatch }) => {
    const textblockStart = state.selection.$from.start(state.selection.$from.depth);
    const textblockEnd = state.selection.$from.end(state.selection.$from.depth);
    tr.insertText('前中', textblockStart, textblockEnd);
    dispatch?.(tr);
    return true;
  });
  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '中' }));

  const serialized13 = editor.storage.markdown.getMarkdown().trim();
  const middleInsertionSafe = serialized13.includes('* [ ] 前中后')
    && !serialized13.includes('* [ ] 前中\n')
    && !serialized13.endsWith('* [ ] 前中');

  logTestResult("场景 13 (任务行中间中文插入不能吃掉后缀)", middleInsertionSafe, {
    "Middle Insertion Safe": middleInsertionSafe ? 'OK' : 'FAIL',
    "Serialized Markdown": serialized13
  });
} catch (e) {
  logTestResult("场景 13 (任务行中间中文插入不能吃掉后缀)", false, { error: e.stack });
}

// =========================================================================
// 场景 14：多级任务行首中文插入不能丢失当前缩进层级
// =========================================================================
try {
  const md14 = `- [ ] 一级\n  - [ ] 后文`;
  editor.commands.setContent(md14);

  const anchorPos = findTextPosition(editor, '后文');
  editor.commands.command(({ tr }) => {
    tr.setSelection(TextSelection.create(tr.doc, anchorPos));
    return true;
  });
  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true, data: 'qian' }));
  editor.commands.insertContent('qian');
  editor.view.dom.dispatchEvent(new dom.window.InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertFromComposition',
    data: '前',
  }));

  // A bad IME/DOMObserver transaction can preserve the text but lift the nested
  // task item to level 1. Composition guard must reject structure loss too.
  editor.commands.liftListItem('taskItem');
  editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '前' }));

  const serialized14 = editor.storage.markdown.getMarkdown().trim();
  const nestedInsertionKeepsLevel = serialized14.includes('* [ ] 一级')
    && serialized14.includes('  * [ ] 前后文')
    && !serialized14.includes('* [ ] 一级\n\n* [ ] 前后文');

  logTestResult("场景 14 (多级任务行首中文插入不能丢失缩进)", nestedInsertionKeepsLevel, {
    "Nested Insertion Keeps Level": nestedInsertionKeepsLevel ? 'OK' : 'FAIL',
    "Serialized Markdown": serialized14
  });
} catch (e) {
  logTestResult("场景 14 (多级任务行首中文插入不能丢失缩进)", false, { error: e.stack });
}

// =========================================================================
// 场景 15：顶级段落重输有序列表标记时必须回并前一个同级有序列表
// =========================================================================
try {
  const isolatedEditor = new Editor({
    element: dom.window.document.createElement('div'),
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

  isolatedEditor.commands.setContent({
    type: 'doc',
    content: [
      {
        type: 'orderedList',
        attrs: { start: 1 },
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Parent-A' }],
              },
            ],
          },
        ],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Parent-B' }],
      },
      {
        type: 'orderedList',
        attrs: { start: 1 },
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Child-C' }],
              },
            ],
          },
        ],
      },
    ],
  });

  const parentPos = findTextPosition(isolatedEditor, 'Parent-B');
  isolatedEditor.commands.command(({ tr, dispatch }) => {
    tr.insertText('2.', parentPos);
    tr.setSelection(TextSelection.create(tr.doc, parentPos + 2));
    dispatch?.(tr);
    return true;
  });

  const cursorPos = isolatedEditor.state.selection.from;
  let handled = false;
  isolatedEditor.view.someProp('handleTextInput', (handler) => {
    handled = handler(isolatedEditor.view, cursorPos, cursorPos, ' ') || handled;
  });

  const json15 = isolatedEditor.getJSON();
  const serialized15 = isolatedEditor.storage.markdown.getMarkdown().trim();
  const rebuiltList = json15.content[0];
  const mergedIntoPrevious =
    rebuiltList?.type === 'orderedList' &&
    rebuiltList?.content?.length === 2;
  const secondItemPreserved =
    rebuiltList?.content?.[1]?.content?.[0]?.content?.[0]?.text === 'Parent-B';
  const nestedListPreserved =
    rebuiltList?.content?.[1]?.content?.[1]?.type === 'orderedList' &&
    rebuiltList?.content?.[1]?.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0]?.text === 'Child-C';

  logTestResult("场景 15 (重输 2. 后回并前序有序列表)", handled && mergedIntoPrevious && secondItemPreserved && nestedListPreserved, {
    Handled: handled ? 'OK' : 'FAIL',
    'Merged Into Previous List': mergedIntoPrevious ? 'OK' : 'FAIL',
    'Second Item Preserved': secondItemPreserved ? 'OK' : 'FAIL',
    'Nested List Preserved': nestedListPreserved ? 'OK' : 'FAIL',
    'Serialized Markdown': serialized15,
    'JSON AST': JSON.stringify(json15, null, 2),
  });

  isolatedEditor.destroy();
} catch (e) {
  logTestResult("场景 15 (重输 2. 后回并前序有序列表)", false, { error: e.stack });
}

// =========================================================================
// 场景 16：遗留拆分的顶级有序列表在转无序时必须整簇一起转换
// =========================================================================
try {
  const isolatedEditor = new Editor({
    element: dom.window.document.createElement('div'),
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

  isolatedEditor.commands.setContent({
    type: 'doc',
    content: [
      {
        type: 'orderedList',
        attrs: { start: 1 },
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Level1-1' }],
              },
            ],
          },
        ],
      },
      {
        type: 'orderedList',
        attrs: { start: 2 },
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Level1-2' }],
              },
              {
                type: 'orderedList',
                attrs: { start: 1 },
                content: [
                  {
                    type: 'listItem',
                    content: [
                      {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'Level1-3-1' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  const firstItemPos = findTextPosition(isolatedEditor, 'Level1-1');
  isolatedEditor.commands.command(({ tr, dispatch }) => {
    tr.insertText('-', firstItemPos);
    tr.setSelection(TextSelection.create(tr.doc, firstItemPos + 1));
    dispatch?.(tr);
    return true;
  });

  const cursorPos = isolatedEditor.state.selection.from;
  let handled = false;
  isolatedEditor.view.someProp('handleTextInput', (handler) => {
    handled = handler(isolatedEditor.view, cursorPos, cursorPos, ' ') || handled;
  });

  const json16 = isolatedEditor.getJSON();
  const serialized16 = isolatedEditor.storage.markdown.getMarkdown().trim();
  const convertedList = json16.content[0];
  const clusterConverted =
    convertedList?.type === 'bulletList' &&
    convertedList?.content?.length === 2 &&
    json16.content?.[1]?.type !== 'orderedList';
  const nestedOrderedPreserved =
    convertedList?.content?.[1]?.content?.[1]?.type === 'orderedList' &&
    convertedList?.content?.[1]?.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0]?.text === 'Level1-3-1';

  logTestResult("场景 16 (拆分有序列表转无序时整簇转换)", handled && clusterConverted && nestedOrderedPreserved, {
    Handled: handled ? 'OK' : 'FAIL',
    'Cluster Converted': clusterConverted ? 'OK' : 'FAIL',
    'Nested Ordered Preserved': nestedOrderedPreserved ? 'OK' : 'FAIL',
    'Serialized Markdown': serialized16,
    'JSON AST': JSON.stringify(json16, null, 2),
  });

  isolatedEditor.destroy();
} catch (e) {
  logTestResult("场景 16 (拆分有序列表转无序时整簇转换)", false, { error: e.stack });
}

console.log("\n🏁 E2E Regression Tests Completed.");
process.exit(0);
