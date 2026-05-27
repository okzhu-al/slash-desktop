import { Plus, FolderOpen, Trash2, Check, Database } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/utils/cn";
import { VaultInfo } from "@/core/vault/VaultService";

interface VaultsTabProps {
    vaults: VaultInfo[];
    currentVault: string | null;
    handleCreateVault: () => void;
    handleOpenVault: () => void;
    handleSwitchVault: (path: string) => void;
    handleRemoveVault: (e: React.MouseEvent, path: string) => void;
}

export const VaultsTab = ({
    vaults,
    currentVault,
    handleCreateVault,
    handleOpenVault,
    handleSwitchVault,
    handleRemoveVault,
}: VaultsTabProps) => {
    const { t } = useTranslation();

    return (
        <div className="space-y-6">
            <div>
                <div className="flex items-center justify-between mb-1">
                    <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                        <Database size={16} className="text-[#545454] dark:text-[#C8C8C8]" />
                        {t("settings.manage_vaults") || "Manage Vaults"}
                    </h3>
                    <div className="flex gap-2">
                        <button
                            onClick={handleOpenVault}
                            className="p-1.5 text-[#545454] dark:text-[#C8C8C8] hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md transition-colors flex items-center justify-center"
                            title={t("onboarding.open_vault")}
                        >
                            <FolderOpen size={16} />
                        </button>
                        <button
                            onClick={handleCreateVault}
                            className="p-1.5 bg-[#002FA7] hover:bg-[#002FA7]/90 text-white rounded-md transition-colors shadow-sm flex items-center justify-center"
                            title={t("onboarding.create_vault")}
                        >
                            <Plus size={16} />
                        </button>
                    </div>
                </div>
                <p className="text-sm text-[#545454] dark:text-[#C8C8C8] mb-3">
                    {t("settings.manage_vaults_desc") || "Switch between your note vaults or create new ones."}
                </p>

                <div className="space-y-2">
                    {vaults.map((vault) => (
                        <div
                            key={vault.path}
                            onClick={() => handleSwitchVault(vault.path)}
                            className={cn(
                                "group flex items-center justify-between p-3 rounded-lg border transition-all cursor-pointer",
                                currentVault === vault.path
                                    ? "bg-[#002FA7]/10 dark:bg-[#002FA7]/20 border-[#002FA7]/30 dark:border-[#002FA7]/50"
                                    : "bg-white dark:bg-zinc-900 border-[#C8C8C8] dark:border-[#C8C8C8]/30 hover:border-[#002FA7]/40 dark:hover:border-[#002FA7]/40"
                            )}
                        >
                            <div className="flex items-center gap-3 overflow-hidden">
                                <div className={cn(
                                    "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                                    currentVault === vault.path
                                        ? "bg-[#002FA7] text-white shadow-sm"
                                        : "bg-zinc-100 dark:bg-zinc-800 text-[#545454] dark:text-[#C8C8C8]"
                                )}>
                                    {currentVault === vault.path ? <Check size={16} /> : <span className="text-xs font-bold font-mono">/</span>}
                                </div>
                                <div className="min-w-0">
                                    <div className="font-medium text-sm text-zinc-900 dark:text-zinc-100 truncate">
                                        {vault.name}
                                    </div>
                                    <div className="text-xs text-[#545454] dark:text-[#C8C8C8] truncate font-mono opacity-70 group-hover:opacity-100 transition-opacity">
                                        {vault.path}
                                    </div>
                                </div>
                            </div>

                            {currentVault !== vault.path && (
                                <button
                                    onClick={(e) => handleRemoveVault(e, vault.path)}
                                    className="p-2 text-[#545454] hover:text-[#A42227] dark:text-[#C8C8C8] dark:hover:text-[#A42227] opacity-0 group-hover:opacity-100 transition-all hover:bg-[#A42227]/10 rounded-md"
                                    title={t('settings.remove_from_history')}
                                >
                                    <Trash2 size={16} />
                                </button>
                            )}
                        </div>
                    ))}

                    {vaults.length === 0 && (
                        <div className="text-center py-8 text-[#545454] dark:text-[#C8C8C8] text-sm">
                            {t('settings.no_vaults')}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
