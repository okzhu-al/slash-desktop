import type { Note } from '@/core/storage/types';
import type { DeletedFileInfo } from '@/services/SyncService';
import { normalizePath } from '@/shared/utils/pathUtils';
import { parseTeamNoteId } from '@/shared/utils/teamNoteIdentity';

const TOMBSTONE_TTL_MS = 5 * 60 * 1000;

interface DeletedTeamNoteTombstone {
    fileIds: Set<string>;
    paths: Set<string>;
    noteIds: Set<string>;
    expiresAt: number;
}

let tombstone: DeletedTeamNoteTombstone = {
    fileIds: new Set(),
    paths: new Set(),
    noteIds: new Set(),
    expiresAt: 0,
};

function pruneExpired(now = Date.now()) {
    if (tombstone.expiresAt > now) return;
    tombstone = {
        fileIds: new Set(),
        paths: new Set(),
        noteIds: new Set(),
        expiresAt: 0,
    };
}

function normalizeDeletedPath(path?: string | null): string {
    return normalizePath(path || '').replace(/^__team__\//, '').toLowerCase();
}

export function matchesDeletedTeamPath(candidate: string, deletedPath: string): boolean {
    if (!candidate || !deletedPath) return false;
    if (candidate === deletedPath
        || candidate.startsWith(`${deletedPath}/`)
        || candidate.endsWith(`/${deletedPath}`)
        || deletedPath.endsWith(`/${candidate}`)) {
        return true;
    }

    const parts = candidate.split('/');
    for (let i = parts.length - 1; i > 0; i -= 1) {
        const parent = parts.slice(0, i).join('/');
        if (deletedPath === parent || deletedPath.endsWith(`/${parent}`)) {
            return true;
        }
    }
    return false;
}

function noteIdentity(note: Note | { id?: string | null; metadata?: Record<string, unknown> | null } | null | undefined) {
    const id = note?.id || '';
    const parsed = parseTeamNoteId(id);
    const metadata = note?.metadata;
    const metadataPath = typeof metadata?.team_path === 'string' ? metadata.team_path : undefined;
    const metadataFileId = typeof metadata?.slash_id === 'string' ? metadata.slash_id : undefined;

    return {
        id,
        fileId: metadataFileId || parsed.fileId || null,
        path: normalizeDeletedPath(metadataPath || parsed.filePath || id),
    };
}

export function markDeletedTeamNotes(deletedFiles: DeletedFileInfo[] | undefined): void {
    if (!deletedFiles?.length) return;

    pruneExpired();
    for (const deletedFile of deletedFiles) {
        const fileId = deletedFile.file_id || null;
        const path = normalizeDeletedPath(deletedFile.path);

        if (fileId) tombstone.fileIds.add(fileId);
        if (path) tombstone.paths.add(path);
    }
    tombstone.expiresAt = Date.now() + TOMBSTONE_TTL_MS;
}

export function isDeletedTeamNote(note: Note | { id?: string | null; metadata?: Record<string, unknown> | null } | null | undefined): boolean {
    pruneExpired();
    if (!note?.id || tombstone.expiresAt === 0) return false;
    if (!note.id.startsWith('__team__/') && typeof note.metadata?.team_path !== 'string') return false;

    const identity = noteIdentity(note);
    if (identity.id && tombstone.noteIds.has(identity.id)) return true;
    if (identity.fileId && tombstone.fileIds.has(identity.fileId)) return true;
    if (identity.path) {
        for (const deletedPath of tombstone.paths) {
            if (matchesDeletedTeamPath(identity.path, deletedPath)) return true;
        }
    }
    return false;
}
