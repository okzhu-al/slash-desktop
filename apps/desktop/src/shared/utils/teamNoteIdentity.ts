const TEAM_NOTE_PREFIX = '__team__/';
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface ParsedTeamNoteId {
    isTeamNote: boolean;
    isStable: boolean;
    teamVaultId: string | null;
    fileId: string | null;
    filePath: string | null;
}

export function isTeamNoteId(noteId?: string | null): boolean {
    return Boolean(noteId?.startsWith(TEAM_NOTE_PREFIX));
}

export function buildStableTeamNoteId(teamVaultId: string, fileId: string): string {
    return `${TEAM_NOTE_PREFIX}${teamVaultId}/${fileId}`;
}

export function buildLegacyTeamNoteId(filePath: string): string {
    return `${TEAM_NOTE_PREFIX}${filePath.replace(/^\/+/, '')}`;
}

export function parseTeamNoteId(noteId?: string | null): ParsedTeamNoteId {
    if (!noteId?.startsWith(TEAM_NOTE_PREFIX)) {
        return {
            isTeamNote: false,
            isStable: false,
            teamVaultId: null,
            fileId: null,
            filePath: null,
        };
    }

    const payload = noteId.slice(TEAM_NOTE_PREFIX.length).replace(/^\/+/, '');
    const parts = payload.split('/');
    const teamVaultId = parts[0] ?? null;
    const fileId = parts[1] ?? null;
    const isStable = Boolean(teamVaultId && fileId && UUID_RE.test(teamVaultId) && UUID_RE.test(fileId));

    return {
        isTeamNote: true,
        isStable,
        teamVaultId: isStable ? teamVaultId : null,
        fileId: isStable ? fileId : null,
        filePath: isStable ? null : payload,
    };
}

export function getTeamNoteDisplayPath(noteId?: string | null, fallbackPath?: string | null): string {
    const parsed = parseTeamNoteId(noteId);
    return parsed.filePath ?? fallbackPath ?? '';
}
