import { FileSystemItem } from "@/core/fs/types";
import { TeamTreeNode } from "@/services/SyncService";

export interface FileSystemActions {
    onRename: (item: FileSystemItem) => void;
    onConfirmRename: (item: FileSystemItem, newName: string) => Promise<void>;
    onDelete: (item: FileSystemItem) => void;
    onDuplicate: (item: FileSystemItem) => void;
    onReveal: (item: FileSystemItem) => void;
    onNewNote: (parent: FileSystemItem) => void;
    onNewFolder: (parent: FileSystemItem) => void;
    onMoveFile: (sourcePath: string, destFolder: string) => Promise<void>;
    // Centralized editing state
    editingPath: string | null;
    onStartEditing: (path: string) => void;
    onStopEditing: () => void;
    // Notes with pending AI title suggestions (relative paths)
    pendingTitlePaths?: Set<string>;
    // Project folder selection (Kanban view)
    onSelectProjectFolder?: (item: FileSystemItem) => void;
    // Team directory management
    onPromoteToTeam?: (item: FileSystemItem, targetParaDir: string) => void;
    teamDirectories?: Map<string, { vaultId: string; remotePath: string }>;
    teamDirectoryOptions?: string[];
    teamTree?: TeamTreeNode[];
    teamRoots?: Set<string>;
    isMaintenanceMode?: boolean;
}
