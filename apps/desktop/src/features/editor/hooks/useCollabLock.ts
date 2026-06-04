import { useState, useEffect, useRef, useCallback } from 'react';
import { collabService } from '@/services/CollabService';
import { autoSyncManager } from '@/services/AutoSyncManager';

export type CollabLockState = 'acquired' | 'locked_by_other' | 'idle' | 'offline' | 'loading' | 'unavailable';

interface UseCollabLockResult {
    lockState: CollabLockState;
    lockedByName: string | null;
    canEdit: boolean;
    reportActivity: (mode?: 'request' | 'renew') => void;
}

const HEARTBEAT_INTERVAL = 15000; // 15s
const IDLE_TIMEOUT = 60000; // 60s

export function useCollabLock(
    vaultId: string | null | undefined,
    fileId: string | null | undefined,
    docStatus: string,
    isTeamNote: boolean
): UseCollabLockResult {
    const isCollab = isTeamNote && docStatus === 'collab';
    const [lockState, setLockState] = useState<CollabLockState>(isCollab ? 'idle' : 'acquired');
    const [lockedByName, setLockedByName] = useState<string | null>(null);

    const lockStateRef = useRef(lockState);
    lockStateRef.current = lockState;

    const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const isOfflineRef = useRef(!navigator.onLine);

    // Stable refs for isCollab/vaultId/fileId to use in callbacks without stale closures
    const isCollabRef = useRef(isCollab);
    isCollabRef.current = isCollab;
    const vaultIdRef = useRef(vaultId);
    vaultIdRef.current = vaultId;
    const fileIdRef = useRef(fileId);
    fileIdRef.current = fileId;

    const stopHeartbeat = useCallback(() => {
        if (heartbeatTimerRef.current) {
            clearInterval(heartbeatTimerRef.current);
            heartbeatTimerRef.current = null;
        }
    }, []);

    const enforceOffline = useCallback(() => {
        if (!isCollabRef.current) {
            setLockState('acquired');
            setLockedByName(null);
            stopHeartbeat();
            return;
        }
        console.warn(`🔌 [Collab/Lock] Enforcing offline lock state (network offline or error) for vaultId: ${vaultIdRef.current}, fileId: ${fileIdRef.current}`);
        setLockState('offline');
        setLockedByName(null);
        stopHeartbeat();
    }, [stopHeartbeat]);

    const releaseLock = useCallback(async () => {
        if (!isCollabRef.current || !vaultIdRef.current || !fileIdRef.current) return;
        console.info(`🔓 [Collab/Lock] Releasing lock for vaultId: ${vaultIdRef.current}, fileId: ${fileIdRef.current}`);
        try {
            await collabService.releaseLock(vaultIdRef.current, fileIdRef.current);
        } catch (err) {
            console.warn(`⚠️ [Collab/Lock] Failed to release lock:`, err);
        }
    }, []);

    const scheduleIdleRelease = useCallback(() => {
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        idleTimerRef.current = setTimeout(() => {
            if (lockStateRef.current === 'acquired') {
                stopHeartbeat();
                releaseLock();
                setLockState('idle');
                setLockedByName(null);
            }
        }, IDLE_TIMEOUT);
    }, [releaseLock, stopHeartbeat]);

    const startHeartbeat = useCallback((acquireFn: (isHeartbeat: boolean) => Promise<void>) => {
        if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = setInterval(() => {
            acquireFn(true);
        }, HEARTBEAT_INTERVAL);
    }, []);

    const attemptAcquire = useCallback(async (isHeartbeat = false) => {
        if (!isCollabRef.current || !vaultIdRef.current || !fileIdRef.current) return;
        if (isOfflineRef.current && !navigator.onLine) { enforceOffline(); return; }

        console.info(`🔒 [Collab/Lock] Attempting to acquire lock for vaultId: ${vaultIdRef.current}, fileId: ${fileIdRef.current} (isHeartbeat: ${isHeartbeat})`);
        try {
            const { success, lockedByName: locked } = await collabService.acquireLock(vaultIdRef.current, fileIdRef.current);
            if (success) {
                console.info(`🔑 [Collab/Lock] Successfully acquired lock for vaultId: ${vaultIdRef.current}, fileId: ${fileIdRef.current}`);
                setLockState('acquired');
                setLockedByName(null);
                autoSyncManager.reportNetworkRestored();
                if (!isHeartbeat) {
                    startHeartbeat(attemptAcquire);
                    scheduleIdleRelease();
                }
            } else {
                console.warn(`⚠️ [Collab/Lock] Lock conflict for vaultId: ${vaultIdRef.current}, fileId: ${fileIdRef.current}. Locked by: ${locked}`);
                setLockState('locked_by_other');
                setLockedByName(locked);
                autoSyncManager.reportNetworkRestored();
                // We rely on pollTimer to keep checking if the lock is released
            }
        } catch (err) {
            console.error(`❌ [Collab/Lock] Failed to acquire lock due to network or server error for vaultId: ${vaultIdRef.current}, fileId: ${fileIdRef.current}:`, err);
            if (!navigator.onLine) {
                autoSyncManager.reportNetworkError('browser offline');
                enforceOffline();
                return;
            }
            // A single collab-lock fetch failure can be transient WebView pressure
            // (for example ERR_INSUFFICIENT_RESOURCES). It must not poison the
            // global sync/server status; real physical disconnects are promoted
            // by AutoSyncManager's sync/token/server probes or browser offline.
            setLockState('unavailable');
            setLockedByName(null);
            stopHeartbeat();
        }
    }, [enforceOffline, scheduleIdleRelease, startHeartbeat, stopHeartbeat]);

    // Sync online/offline status using AutoSyncManager as the single source of truth
    useEffect(() => {
        const unsubscribe = autoSyncManager.onStatusChange((event) => {
            if (event.status === 'offline') {
                isOfflineRef.current = true;
                enforceOffline();
            } else if (['idle', 'success', 'syncing'].includes(event.status)) {
                if (isOfflineRef.current) {
                    isOfflineRef.current = false;
                    setLockState(isCollabRef.current ? 'idle' : 'acquired');
                } else if (lockStateRef.current === 'unavailable') {
                    setLockState(isCollabRef.current ? 'idle' : 'acquired');
                }
            }
        });

        return () => {
            unsubscribe();
        };
    }, [attemptAcquire, enforceOffline]);

    // Expose activity reporting so the editor can acquire only after edit intent.
    // Programmatic editor updates may renew an existing lock, but must never acquire one.
    const reportActivity = useCallback((mode: 'request' | 'renew' = 'request') => {
        if (!isCollabRef.current || isOfflineRef.current) return;
        if (lockStateRef.current === 'acquired') {
            scheduleIdleRelease();
            return;
        }
        if (mode === 'renew') return;
        if (lockStateRef.current === 'loading') return;
        setLockState('loading');
        attemptAcquire();
    }, [attemptAcquire, scheduleIdleRelease]);

    // Main Mount / Teardown
    useEffect(() => {
        if (!isCollab) {
            setLockState('acquired'); // No lock needed
            return;
        }

        if (!navigator.onLine) {
            enforceOffline();
            return;
        }

        setLockState('idle');
        setLockedByName(null);

        // Also poll every 15s if the lock is unavailable, offline, or held by
        // someone else, so transient fetch/WebView failures can recover locally.
        const pollTimer = setInterval(() => {
            if (lockStateRef.current === 'locked_by_other' || lockStateRef.current === 'offline' || lockStateRef.current === 'unavailable') {
                if (navigator.onLine) attemptAcquire();
            }
        }, HEARTBEAT_INTERVAL);

        const activeVaultId = vaultId;
        const activeFileId = fileId;

        return () => {
            clearInterval(pollTimer);
            stopHeartbeat();
            if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
            if (lockStateRef.current === 'acquired' && activeVaultId && activeFileId) {
                collabService.releaseLock(activeVaultId, activeFileId).catch(() => {});
            }
        };
    }, [isCollab, vaultId, fileId, attemptAcquire, enforceOffline, stopHeartbeat]);

    // canEdit：collab 下仅 acquired 可编辑；idle 需要用户点击编辑区后先抢锁。
    const canEdit = !isCollab || lockState === 'acquired';

    return {
        lockState,
        lockedByName,
        canEdit,
        reportActivity
    };
}
