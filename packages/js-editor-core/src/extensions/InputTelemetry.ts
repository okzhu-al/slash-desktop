import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export const InputTelemetry = Extension.create({
    name: 'inputTelemetry',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey('inputTelemetry'),
                props: {
                    handleKeyDown(_view, _event) {
                        const now = performance.now();
                        (window as any).__slashLastInputTime = now;
                        return false;
                    },
                    handleTextInput(_view, _from, _to, _text) {
                        const now = performance.now();
                        (window as any).__slashLastInputTime = now;
                        return false;
                    }
                },
                appendTransaction(transactions, _oldState, _newState) {
                    if (transactions.some(tr => tr.docChanged)) {
                        const now = performance.now();
                        const lastTime = (window as any).__slashLastInputTime;
                        if (lastTime) {
                            const diff = now - lastTime;
                            // Only log if it took longer than 16ms (1 frame delay) to avoid spam
                            // But for diagnostic purposes, let's log everything if it's over 10ms
                            if (diff > 5) {

                            }
                            (window as any).__slashLastInputTime = null;
                        }
                    }
                    return null;
                }
            })
        ];
    }
});
