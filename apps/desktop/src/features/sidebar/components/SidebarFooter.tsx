import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, Plus, LogOut, ChevronUp, Settings } from 'lucide-react';
import { vaultService, type VaultInfo } from '@/core/vault/VaultService';
import { SyncStatusIndicator } from './SyncStatusIndicator';
import { cn } from '@/shared/utils/cn';


export interface SidebarFooterProps {
    rootDir?: string;
    vaultName?: string;
    teamVaultName?: string;
    activeSpace: 'personal' | 'team';
    hasTeamVault: boolean;
    onSwitchVault: (path: string | null) => void;
    onOpenSyncSettings?: () => void;
    onSettingsClick?: () => void;
}

export function SidebarFooter({
    rootDir,
    vaultName,
    teamVaultName: _teamVaultName,
    activeSpace: _activeSpace,
    hasTeamVault,
    onSwitchVault,
    onOpenSyncSettings,
    onSettingsClick
}: SidebarFooterProps) {
    const { t } = useTranslation();
    const [isVaultMenuOpen, setIsVaultMenuOpen] = useState(false);
    const [availableVaults, setAvailableVaults] = useState<VaultInfo[]>([]);
    const vaultMenuRef = useRef<HTMLDivElement>(null);
    

    useEffect(() => {
        if (isVaultMenuOpen) {
            vaultService.cleanupDeletedVaults().then(setAvailableVaults);
        }
    }, [isVaultMenuOpen]);

    useEffect(() => {
        if (!isVaultMenuOpen) return;
        const handleOutsideClick = (e: MouseEvent) => {
            if (vaultMenuRef.current && !vaultMenuRef.current.contains(e.target as Node)) {
                setIsVaultMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleOutsideClick);
        return () => {
            document.removeEventListener('mousedown', handleOutsideClick);
        };
    }, [isVaultMenuOpen]);

    const handleCreateVault = async () => {
        setIsVaultMenuOpen(false);
        const path = await vaultService.createVault();
        if (path) onSwitchVault(path);
    };

    const handleBackToWelcome = () => {
        setIsVaultMenuOpen(false);
        onSwitchVault(null);
    };

    return (
        <div className={cn("relative mt-auto shrink-0", hasTeamVault && "bg-[#E6A23C]/10 dark:bg-[#002FA7]/15")} ref={vaultMenuRef}>
            {isVaultMenuOpen && (
                <div className="absolute bottom-full left-2 right-2 mb-2 bg-white dark:bg-zinc-800 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-700 p-1 overflow-hidden animate-in fade-in zoom-in-95 duration-200 z-50 overflow-y-auto">
                    {/* Existing Vaults List */}
                    {availableVaults.length > 0 && (
                        <>
                            <div className="px-3 py-1.5 text-xs font-medium text-zinc-400 dark:text-zinc-500">
                                {t("sidebar.vault_menu.recent")}
                            </div>
                            {availableVaults
                                .sort((a, b) => b.lastUsed - a.lastUsed)
                                .map((vault) => {
                                    const isCurrentVault = rootDir === vault.path;
                                    return (
                                        <button
                                            key={vault.path}
                                            onClick={() => {
                                                if (!isCurrentVault) {
                                                    onSwitchVault?.(vault.path);
                                                    setIsVaultMenuOpen(false);
                                                }
                                            }}
                                            className={cn(
                                                "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors",
                                                isCurrentVault
                                                    ? "text-indigo-600 dark:text-blue-400 bg-indigo-50 dark:bg-indigo-900/20"
                                                    : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                                            )}
                                        >
                                            <Folder size={16} className={isCurrentVault ? "text-indigo-500 dark:text-blue-400" : ""} />
                                            <span className="truncate flex-1 text-left">{vault.name}</span>
                                            {isCurrentVault && <span className="text-xs text-indigo-500 dark:text-blue-400">✓</span>}
                                        </button>
                                    );
                                })}
                            <div className="h-px bg-zinc-100 dark:bg-zinc-700 my-1" />
                        </>
                    )}

                    {/* Create New Vault */}
                    <button
                        onClick={handleCreateVault}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                    >
                        <Plus size={16} />
                        <span>{t("sidebar.vault_menu.create")}</span>
                    </button>

                    <div className="h-px bg-zinc-100 dark:bg-zinc-700 my-1" />

                    {/* Return to Welcome */}
                    <button
                        onClick={handleBackToWelcome}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors"
                    >
                        <LogOut size={16} />
                        <span>{t("sidebar.vault_menu.welcome")}</span>
                    </button>
                </div>
            )}
            
            <div className="flex flex-row p-2 gap-3 border-t border-zinc-200 dark:border-zinc-700 w-full min-w-0">
                <div
                    className="flex-1 min-w-0 w-full flex items-center gap-1 px-2 py-1 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/5 rounded-md transition-colors cursor-pointer select-none"
                    onClick={() => setIsVaultMenuOpen(!isVaultMenuOpen)}
                >
                    <ChevronUp size={18} strokeWidth={1.5} className={cn("transition-transform duration-200 shrink-0", isVaultMenuOpen ? "rotate-180" : "")} />
                    <span className="font-bold text-zinc-800 dark:text-zinc-200 ml-1 truncate flex-1 min-w-0">
                        {vaultName || "Vault"}
                    </span>
                </div>
                
                <SyncStatusIndicator vaultPath={rootDir} onOpenSyncSettings={onOpenSyncSettings} />
                <button
                    onClick={onSettingsClick}
                    className="w-7 h-7 flex items-center justify-center px-1 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-black/5 dark:hover:bg-white/5 rounded-md transition-colors"
                >
                    <Settings size={18} strokeWidth={1.5} />
                </button>
            </div>
        </div>
    );
}
