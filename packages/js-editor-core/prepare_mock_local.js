const fs = require('fs');
const path = require('path');

const originalPath = path.resolve(__dirname, './src/extensions/MixedListExtension.ts');
let content = fs.readFileSync(originalPath, 'utf-8');

// 1. 移除 CSS 导入
content = content.replace("import './Task/TaskItemStyles.css';", "// Removed CSS import for headless test");

// 2. 移除 React Component 导入
content = content.replace("import { TaskItemComponent } from './Task/TaskItemComponent';", "// Removed Component import for headless test");

// 3. 将 ReactNodeViewRenderer 替换为普通的 ProseMirror 视图节点生成器
content = content.replace("ReactNodeViewRenderer(TaskItemComponent)", "() => { return { dom: document.createElement('li') }; }");

const outputPath = path.resolve(__dirname, './src/extensions/MixedListExtension.mock.ts');
fs.writeFileSync(outputPath, content, 'utf-8');
console.log('✅ Local MixedListExtension.mock.ts generated.');
