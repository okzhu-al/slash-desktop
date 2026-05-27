type IpcStat = {
    total: number;
    window: number;
    lastAt: number;
};

type IpcStatsSnapshot = Array<{
    command: string;
    total: number;
    window: number;
    perMinute: number;
    lastSeenMsAgo: number;
}>;

const REPORT_INTERVAL_MS = 30_000;

declare global {
    interface Window {
        __slashIpcStats?: {
            enable: () => void;
            disable: () => void;
            reset: () => void;
            print: () => void;
            snapshot: () => IpcStatsSnapshot;
        };
        __slashIpcStatsInstalled?: boolean;
    }
}

const stats = new Map<string, IpcStat>();
let enabled = false;
let reportTimer: ReturnType<typeof setInterval> | null = null;
let originalFetch: typeof window.fetch | null = null;

function decodeCommand(input: RequestInfo | URL): string | null {
    const raw = typeof input === 'string'
        ? input
        : input instanceof URL
            ? input.href
            : input.url;

    let url: URL;
    try {
        url = new URL(raw, window.location.href);
    } catch {
        return null;
    }

    if (url.hostname !== 'ipc.localhost') return null;

    const path = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return path || url.pathname;
}

function record(command: string) {
    if (!enabled) return;
    const now = Date.now();
    const item = stats.get(command) ?? { total: 0, window: 0, lastAt: now };
    item.total += 1;
    item.window += 1;
    item.lastAt = now;
    stats.set(command, item);
}

function snapshot(): IpcStatsSnapshot {
    const now = Date.now();
    return Array.from(stats.entries())
        .map(([command, item]) => ({
            command,
            total: item.total,
            window: item.window,
            perMinute: Math.round(item.window * (60_000 / REPORT_INTERVAL_MS)),
            lastSeenMsAgo: now - item.lastAt,
        }))
        .sort((a, b) => b.window - a.window || b.total - a.total);
}

function print() {
    const rows = snapshot().filter((row) => row.total > 0).slice(0, 20);
    if (rows.length === 0) return;

    const totalWindow = rows.reduce((sum, row) => sum + row.window, 0);
    const totalAll = Array.from(stats.values()).reduce((sum, row) => sum + row.total, 0);
    console.groupCollapsed(`[IPC Stats] ${totalWindow} calls / ${REPORT_INTERVAL_MS / 1000}s, total=${totalAll}`);
    console.table(rows);
    console.groupEnd();

    for (const item of stats.values()) {
        item.window = 0;
    }
}

function startReporting() {
    if (reportTimer) return;
    reportTimer = setInterval(print, REPORT_INTERVAL_MS);
}

function stopReporting() {
    if (!reportTimer) return;
    clearInterval(reportTimer);
    reportTimer = null;
}

function enable() {
    enabled = true;
    startReporting();
}

function disable() {
    enabled = false;
    stopReporting();
}

function reset() {
    stats.clear();
}

export function installIpcStats() {
    if (typeof window === 'undefined' || window.__slashIpcStatsInstalled) return;
    window.__slashIpcStatsInstalled = true;

    originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const command = decodeCommand(input);
        if (command) record(command);
        return originalFetch!(input, init);
    }) as typeof window.fetch;

    window.__slashIpcStats = { enable, disable, reset, print, snapshot };
}
