import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["@slash/editor-core"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    cssMinify: 'esbuild',
    rollupOptions: {
      onwarn(warning, warn) {
        // 1. 过滤第三方 eval 警告噪音（如 gray-matter 内部的动态解析风险提示）
        if (warning.code === 'EVAL') return;
        // 2. 过滤动态和静态混合导入的块拆分警报（如 useSessionStore / store.ts 等混合导入警告）
        if (warning.code === 'MIXED_EXPORTS' || warning.message.includes('dynamic import will not move module')) return;
        // 3. 其他非噪音警告正常打印
        warn(warning);
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('@tauri-apps')) {
              return 'vendor-tauri';
            }
            if (id.includes('@tiptap') || id.includes('prosemirror')) {
              return 'vendor-tiptap';
            }
            if (id.includes('@xyflow') || id.includes('d3-')) {
              return 'vendor-graph';
            }
            if (id.includes('lucide-react') || id.includes('sonner')) {
              return 'vendor-ui';
            }
            if (id.includes('pdfjs')) {
              return 'vendor-pdf';
            }
            // Let Vite handle react, react-dom, and tldraw naturally to prevent execution order / circular dependency issues
          }
        }
      }
    }
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and markdown data files
      ignored: ["**/src-tauri/**", "**/*.md"],
    },
  },
}));
