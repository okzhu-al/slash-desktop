import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export interface OllamaPullProgress {
    model: string;
    status: string;
    completed: number;
    total: number;
    done: boolean;
    error: string | null;
}

export interface OllamaDownloadState {
    model: string;
    status: 'downloading' | 'done' | 'error';
    progress: { status: string; completed: number; total: number } | null;
    error: string | null;
    updatedAt: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();
const ollamaDownloads = new Map<string, OllamaDownloadState>();
let ollamaProgressUnlisten: Promise<UnlistenFn> | null = null;

function emitChange() {
    listeners.forEach(listener => listener());
}

function setOllamaState(model: string, next: Omit<OllamaDownloadState, 'model' | 'updatedAt'>) {
    ollamaDownloads.set(model, {
        model,
        ...next,
        updatedAt: Date.now(),
    });
    emitChange();
}

function ensureOllamaProgressListener() {
    if (ollamaProgressUnlisten) return;
    ollamaProgressUnlisten = listen<OllamaPullProgress>('ollama:pull-progress', event => {
        const progress = event.payload;
        if (progress.error) {
            setOllamaState(progress.model, {
                status: 'error',
                progress: null,
                error: progress.error,
            });
            return;
        }

        if (progress.done) {
            setOllamaState(progress.model, {
                status: 'done',
                progress: null,
                error: null,
            });
            return;
        }

        setOllamaState(progress.model, {
            status: 'downloading',
            progress: {
                status: progress.status,
                completed: progress.completed,
                total: progress.total,
            },
            error: null,
        });
    });
    ollamaProgressUnlisten.catch(error => {
        console.error('[ModelDownloadStore] Failed to listen for Ollama progress:', error);
        ollamaProgressUnlisten = null;
    });
}

export function subscribeModelDownloads(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getOllamaDownload(model: string): OllamaDownloadState | null {
    if (!model) return null;
    return ollamaDownloads.get(model) ?? null;
}

export function startOllamaDownload(host: string, port: number, model: string) {
    if (!model) return;
    const current = ollamaDownloads.get(model);
    if (current?.status === 'downloading') return;

    ensureOllamaProgressListener();
    setOllamaState(model, {
        status: 'downloading',
        progress: { status: 'starting', completed: 0, total: 0 },
        error: null,
    });

    void invoke('pull_ollama_model', { host, port, modelName: model }).catch(error => {
        setOllamaState(model, {
            status: 'error',
            progress: null,
            error: `${error}`,
        });
    });
}
