import { JSDOM } from 'jsdom';

// Initialize jsdom to mock browser globals
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
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

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { Markdown } from 'tiptap-markdown';

const editor = new Editor({
  extensions: [
    StarterKit,
    TaskList,
    TaskItem,
    Markdown.configure({
      html: false,
      breaks: true,
      tightLists: true,
      bulletListMarker: '-', // bullet list uses '-'
    }),
  ],
});

// Use '*' for task item, and '-' for bullet list
const md = `1. 有序列表1

- 无序

- [ ] 任务列表1`;

editor.commands.setContent(md);
console.log("JSON Output:\n", JSON.stringify(editor.getJSON(), null, 2));

