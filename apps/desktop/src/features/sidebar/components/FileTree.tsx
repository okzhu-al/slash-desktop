import { useTranslation } from "react-i18next";
import { FileSystemItem } from "@/core/fs/types";
import { FileTreeItem } from "./FileTreeItem";
import { FileSystemActions } from "./types";

// Folders hidden from sidebar at root level
const HIDDEN_ROOT_FOLDERS = ['assets', '.slash'];

interface FileTreeProps {
    root: FileSystemItem | null;
    onSelect: (item: FileSystemItem) => void;
    activeId?: string;
    actions?: FileSystemActions;
}

export const FileTree = ({ root, onSelect, activeId, actions }: FileTreeProps) => {
    const { t } = useTranslation();

    if (!root) {
        return <div className="p-4 text-zinc-400 text-sm text-center">{t("sidebar.loading_vault")}</div>;
    }

    if (!root.children || root.children.length === 0) {
        return <div className="p-4 text-zinc-400 text-sm text-center italic">{t("sidebar.vault_empty")}</div>;
    }

    // Filter out hidden folders at root level
    const visibleChildren = root.children.filter(child =>
        !HIDDEN_ROOT_FOLDERS.includes(child.name)
    );

    if (visibleChildren.length === 0) {
        return <div className="p-4 text-zinc-400 text-sm text-center italic">{t("sidebar.vault_empty")}</div>;
    }

    return (
        <div className="flex flex-col gap-0.5 p-1 pb-20">
            {visibleChildren.map(child => (
                <FileTreeItem
                    key={child.id}
                    item={child}
                    level={0}
                    onSelect={onSelect}
                    activeId={activeId}
                    actions={actions}
                />
            ))}
        </div>
    );
};
