const fs = require('fs');
const path = './src/features/settings/AITab.tsx';
let content = fs.readFileSync(path, 'utf8');

// Green -> #006540
content = content.replace(/text-green-600/g, 'text-[#006540]');
content = content.replace(/dark:text-green-400/g, 'dark:text-[#006540]');
content = content.replace(/bg-emerald-500/g, 'bg-[#006540]');
content = content.replace(/hover:bg-emerald-600/g, 'hover:bg-[#005030]');
content = content.replace(/bg-emerald-500\/80/g, 'bg-[#006540]/80');
content = content.replace(/bg-green-50/g, 'bg-[#006540]/10');
content = content.replace(/dark:bg-green-900\/20/g, 'dark:bg-[#006540]/20');
content = content.replace(/bg-green-100/g, 'bg-[#006540]/20');
content = content.replace(/dark:bg-green-900\/30/g, 'dark:bg-[#006540]/30');
content = content.replace(/text-green-700/g, 'text-[#006540]');
content = content.replace(/dark:text-green-300/g, 'dark:text-[#006540]');
content = content.replace(/bg-green-400/g, 'bg-[#006540]');
content = content.replace(/shadow-\[0_0_4px_rgba\(74,222,128,0\.6\)\]/g, 'shadow-[0_0_4px_rgba(0,101,64,0.6)]');

// Yellow -> #EFE0CC
content = content.replace(/text-amber-500/g, 'text-[#EFE0CC]');

// Gray -> #C8C8C8
// To ensure it stays elegant, I'll map border-zinc-200 and border-zinc-700 (dark)
content = content.replace(/border-zinc-200/g, 'border-[#C8C8C8]');
content = content.replace(/dark:border-zinc-700/g, 'dark:border-[#C8C8C8]/30');

// text-zinc-400 and text-zinc-500
content = content.replace(/text-zinc-500/g, 'text-[#C8C8C8]');
content = content.replace(/dark:text-zinc-400/g, 'dark:text-[#C8C8C8]');
content = content.replace(/text-zinc-400/g, 'text-[#C8C8C8]');
content = content.replace(/dark:text-zinc-500/g, 'dark:text-[#C8C8C8]');

// bg-zinc-50 and bg-zinc-100
content = content.replace(/bg-zinc-50/g, 'bg-[#C8C8C8]/10');
content = content.replace(/bg-zinc-100/g, 'bg-[#C8C8C8]/20');

// text-zinc-900 (primary text) - maybe leave alone, or make it slightly tinted? The user specifically said "灰色使用典雅灰，#C8C8C8". 
// I'll leave zinc-900 alone because it's text-primary. 

fs.writeFileSync(path, content);
console.log('Colors replaced in AITab.tsx');
