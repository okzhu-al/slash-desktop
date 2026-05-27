const core = require('@tiptap/core');
const Editor = core.Editor || core.default.Editor;
const StarterKit = require('@tiptap/starter-kit').default || require('@tiptap/starter-kit');
const { Markdown } = require('tiptap-markdown');
const { MixedListItem, MixedTaskList, MixedTaskItem, MixedListKeymap } = require('./src/extensions/MixedListExtension');

// Setup editor
const editor = new Editor({
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

const md1 = `1. aaa
- bbb
- [ ] ccc`;

const md2 = `1. aaa
   - bbb
     - [ ] ccc`;

console.log("=== Testing Flat Markdown ===");
editor.commands.setContent(md1);
console.log("JSON:", JSON.stringify(editor.getJSON(), null, 2));
console.log("HTML:", editor.getHTML());
console.log("Serialized Markdown:", editor.storage.markdown.getMarkdown());

console.log("\n=== Testing Nested Markdown ===");
editor.commands.setContent(md2);
console.log("JSON:", JSON.stringify(editor.getJSON(), null, 2));
console.log("HTML:", editor.getHTML());
console.log("Serialized Markdown:", editor.storage.markdown.getMarkdown());
