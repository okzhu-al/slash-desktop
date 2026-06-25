import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor-a"></div><div id="editor-b"></div></body></html>');
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
    configurable: true,
  });
}
global.KeyboardEvent = dom.window.KeyboardEvent;
global.MouseEvent = dom.window.MouseEvent;
global.FocusEvent = dom.window.FocusEvent;
global.Event = dom.window.Event;
global.InputEvent = dom.window.InputEvent;
global.CustomEvent = dom.window.CustomEvent;
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { Image } from '@tiptap/extension-image';

const TestImageExtension = Image.extend({
  group: 'block',
  inline: false,
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
      },
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const { alt, src, width } = node.attrs;
          let altText = alt || '';
          if (width) {
            altText += `|${width}`;
          }
          state.write(`![${altText}](${src})`);
          state.ensureNewLine();
        },
      },
    };
  },
}).configure({
  inline: false,
  allowBase64: true,
});

const TestTableExtension = Table.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const rows = node.content.content;
          if (!rows || rows.length === 0) return;

          const wasInTable = state.inTable;
          state.inTable = true;

          rows.forEach((row, rowIndex) => {
            const cells = row.content?.content || [];

            state.write('|');
            cells.forEach((cell) => {
              state.write(' ');
              const serializableChildren = (cell.content?.content || []).filter((childNode) => {
                if (childNode.type.name !== 'paragraph') return true;
                if (childNode.childCount > 0) return true;
                return (childNode.textContent || '').trim().length > 0;
              });
              const startLen = state.out.length;

              if (serializableChildren.length > 0) {
                serializableChildren.forEach((childNode, idx) => {
                  if (childNode.type.name === 'paragraph') {
                    state.renderInline(childNode);
                  } else if (childNode.isText) {
                    state.text(childNode.text || '', false);
                  } else {
                    state.render(childNode, cell, idx);
                  }

                  if (idx < serializableChildren.length - 1) {
                    state.write('<br>');
                  }
                });
              }

              let cellContent = state.out.slice(startLen).replace(/\n+$/, '');
              state.out = state.out.slice(0, startLen);
              cellContent = cellContent.replace(/\|/g, '\\|');
              cellContent = cellContent.replace(/\n/g, '<br>').trim();

              state.write(cellContent);
              state.write(' |');
            });
            state.write('\n');

            if (rowIndex === 0) {
              state.write('|');
              cells.forEach((cell) => {
                const align = cell.attrs?.textAlign || 'left';
                const separator = align === 'center' ? ':---:'
                  : align === 'right' ? '---:'
                    : '---';
                state.write(` ${separator} |`);
              });
              state.write('\n');
            }
          });

          state.inTable = wasInTable;
        },
      },
    };
  },
});

function createEditor(elementId) {
  return new Editor({
    element: dom.window.document.getElementById(elementId),
    extensions: [
      StarterKit.configure({
        codeBlock: false,
      }),
      TestTableExtension.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TestImageExtension,
      Markdown.configure({
        html: false,
        breaks: true,
        tightLists: true,
        bulletListMarker: '-',
      }),
    ],
  });
}

function hasImageInTableCell(json) {
  return json.content?.some((node) =>
    node.type === 'table' &&
    node.content?.some((row) =>
      row.content?.some((cell) =>
        cell.content?.some((childNode) =>
          childNode.type === 'image' ||
          (
            childNode.type === 'paragraph' &&
            childNode.content?.some((child) => child.type === 'image')
          )
        )
      )
    )
  );
}

function hasTopLevelBodyImage(json) {
  return json.content?.some((node) => node.type === 'image')
    || json.content?.some((node) =>
      node.type === 'paragraph' &&
      node.content?.some((child) => child.type === 'image')
    );
}

const sourceEditor = createEditor('editor-a');
const reloadEditor = createEditor('editor-b');

sourceEditor.commands.setContent({
  type: 'doc',
  content: [
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'col' }],
                },
              ],
            },
          ],
        },
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'image',
                      attrs: {
                        src: 'assets/test.png',
                        alt: 'img',
                      },
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

const markdown = sourceEditor.storage.markdown.getMarkdown().trim();
reloadEditor.commands.setContent(markdown);
const reloadedJson = reloadEditor.getJSON();

const serializationOK = markdown.includes('![img](assets/test.png)');
const reparseOK = hasImageInTableCell(reloadedJson);

sourceEditor.commands.setContent({
  type: 'doc',
  content: [
    {
      type: 'image',
      attrs: {
        src: 'assets/body.png',
        alt: 'body',
      },
    },
  ],
});

const bodyMarkdown = sourceEditor.storage.markdown.getMarkdown().trim();
reloadEditor.commands.setContent(bodyMarkdown);
const bodyReparseOK = hasTopLevelBodyImage(reloadEditor.getJSON());

console.log(JSON.stringify({
  serializationOK,
  reparseOK,
  bodySerializationOK: bodyMarkdown.includes('![body](assets/body.png)'),
  bodyReparseOK,
  markdown,
  bodyMarkdown,
  reloadedJson,
}, null, 2));

sourceEditor.destroy();
reloadEditor.destroy();

if (!serializationOK || !reparseOK || !bodyMarkdown.includes('![body](assets/body.png)') || !bodyReparseOK) {
  process.exit(1);
}
