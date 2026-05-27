export const DEFAULT_THRESHOLD = 0.60;
const THRESHOLD_STORAGE_KEY = 'slash:ghost-link-thresholds';

function loadThresholdCache(): Map<string, number> {
    try {
        const raw = localStorage.getItem(THRESHOLD_STORAGE_KEY);
        if (raw) return new Map(JSON.parse(raw));
    } catch { /* ignore parse errors */ }
    return new Map();
}

export const thresholdCache = loadThresholdCache();

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveThresholdCache() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        try {
            localStorage.setItem(THRESHOLD_STORAGE_KEY, JSON.stringify([...thresholdCache.entries()]));
        } catch { /* quota errors etc. */ }
    }, 300);
}

const _origSet = thresholdCache.set.bind(thresholdCache);
thresholdCache.set = (key: string, value: number) => {
    const result = _origSet(key, value);
    saveThresholdCache();
    return result;
};
