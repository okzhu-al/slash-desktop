import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { ArrowDownAZ, ArrowUpAZ, Calendar, Clock, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFileSystemStore } from "@/core/fs/store";
import { SortField, SortDirection } from "@/core/fs/sortUtils";

interface SortOption {
    field: SortField;
    direction: SortDirection;
    label: string;
    icon: React.ReactNode;
}

export const SortDropdown = () => {
    const { t } = useTranslation();
    const { sortConfig, setSortConfig } = useFileSystemStore();
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const portalRef = useRef<HTMLDivElement>(null);

    const sortOptions: SortOption[] = [
        { field: 'name', direction: 'asc', label: t('sidebar.sort.name_asc', '名称 A → Z'), icon: <ArrowDownAZ size={16} /> },
        { field: 'name', direction: 'desc', label: t('sidebar.sort.name_desc', '名称 Z → A'), icon: <ArrowUpAZ size={16} /> },
        { field: 'created', direction: 'desc', label: t('sidebar.sort.created_new', '创建时间 新 → 旧'), icon: <Calendar size={16} /> },
        { field: 'created', direction: 'asc', label: t('sidebar.sort.created_old', '创建时间 旧 → 新'), icon: <Calendar size={16} /> },
        { field: 'modified', direction: 'desc', label: t('sidebar.sort.modified_new', '修改时间 新 → 旧'), icon: <Clock size={16} /> },
        { field: 'modified', direction: 'asc', label: t('sidebar.sort.modified_old', '修改时间 旧 → 新'), icon: <Clock size={16} /> },
    ];

    const isSelected = (option: SortOption) =>
        sortConfig.field === option.field && sortConfig.direction === option.direction;

    const handleSelect = (option: SortOption) => {
        setSortConfig(option.field, option.direction);
        setIsOpen(false);
    };

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node;
            // 排除触发按钮和 Portal 菜单内的点击
            if (dropdownRef.current?.contains(target)) return;
            if (portalRef.current?.contains(target)) return;
            setIsOpen(false);
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    return (
        <div ref={dropdownRef} className="relative">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-7 h-7 flex items-center justify-center px-1 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/5 rounded-md transition-colors"
                title={t('sidebar.sort.title', '排序')}
            >
                <ArrowUpAZ size={18} strokeWidth={1.5} />
            </button>

            {isOpen && createPortal(
                <div ref={portalRef} className="fixed w-56 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 z-9999" style={{ top: (dropdownRef.current?.getBoundingClientRect().bottom ?? 0) + 4, left: dropdownRef.current?.getBoundingClientRect().left ?? 0 }}>
                    <div className="px-3 py-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                        {t('sidebar.sort.title', '排序方式')}
                    </div>
                    <div className="h-px bg-zinc-200 dark:bg-zinc-700 my-1" />
                    {sortOptions.map((option) => (
                        <button
                            key={`${option.field}-${option.direction}`}
                            onClick={() => handleSelect(option)}
                            className="w-full flex items-center justify-between px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 transition-colors"
                        >
                            <div className="flex items-center gap-2">
                                <span className="text-zinc-500 dark:text-zinc-400">{option.icon}</span>
                                <span>{option.label}</span>
                            </div>
                            {isSelected(option) && (
                                <Check size={16} className="text-indigo-500" />
                            )}
                        </button>
                    ))}
                </div>,
                document.body
            )}
        </div>
    );
};
