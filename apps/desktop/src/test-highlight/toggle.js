const fs = require('fs');
const path = require('path');
const cssPath = '/Users/junior/Projects/slash/apps/desktop/src/index.css';
let css = fs.readFileSync(cssPath, 'utf8');
if (css.includes('background: transparent !important;')) {
    css = css.replace(/background: transparent !important;/g, '/* background: transparent !important; */');
    css = css.replace(/color: inherit !important;/g, '/* color: inherit !important; */');
} else {
    css = css.replace(/\/\* background: transparent !important; \*\//g, 'background: transparent !important;');
    css = css.replace(/\/\* color: inherit !important; \*\//g, 'color: inherit !important;');
}
fs.writeFileSync(cssPath, css);
