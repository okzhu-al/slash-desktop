
import { Buffer } from 'buffer';
// @ts-ignore
window.Buffer = Buffer;

import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

import App from "./App";

import "./core/i18n/config"; // Import i18n config

import "./index.css"; // Ensure standard CSS is imported (or Tailwind if configured there)

import { ThemeProvider } from "./core/theme/ThemeProvider";
import { KeybindingProvider } from "./modules/keybindings/KeybindingProvider";
import { GlobalErrorBoundary } from "./shared/ui/error/GlobalErrorBoundary";
import { attachConsole } from "@tauri-apps/plugin-log";
import { installIpcStats } from "./debug/ipcStats";

// Attaches the frontend console.log to the Rust tauri-plugin-log system to capture UI errors globally.
attachConsole().catch(console.error);
installIpcStats();

// Suppress benign ResizeObserver errors caused by ReactFlow's layout engine competing with WebKit's paint timing
if (typeof window !== 'undefined' && typeof window.ResizeObserver !== 'undefined') {
    const _ResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class ResizeObserver extends _ResizeObserver {
        constructor(callback: ResizeObserverCallback) {
            super((entries, observer) => {
                window.requestAnimationFrame(() => callback(entries, observer));
            });
        }
    };
    window.addEventListener('error', (e: ErrorEvent) => {
        if (e.message.includes('ResizeObserver')) {
            e.stopImmediatePropagation();
            const overlay = document.querySelector('vite-error-overlay');
            if (overlay) overlay.remove();
        }
    });
}

// 动态注入 CSS Custom Highlight API 样式以彻底消除打包工具对实验性伪元素的静态编译警告
try {
    const styleEl = document.createElement('style');
    styleEl.id = 'slash-custom-highlight-styles';
    styleEl.textContent = `
      ::highlight(editor-selection) {
        background-color: rgba(99, 102, 241, 0.2);
      }
      .dark ::highlight(editor-selection) {
        background-color: rgba(99, 102, 241, 0.45);
      }
    `;
    document.head.appendChild(styleEl);
} catch (e) {
    console.error('Failed to inject custom highlight style:', e);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <GlobalErrorBoundary>
      <KeybindingProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </KeybindingProvider>
    </GlobalErrorBoundary>
);

(window as any).__slashBootstrapped = true;
window.clearTimeout((window as any).__slashBootFallback);

if (!import.meta.env.DEV) {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            getCurrentWindow().show().catch(console.error);
        });
    });
}
