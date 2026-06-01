import { useState, useEffect } from "react";
import { X, Bot, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/utils/cn";
import { vaultService, VaultInfo } from "@/core/vault/VaultService";

// Tab Components
import { AboutTab } from "./AboutTab";
import { GeneralTab } from "./GeneralTab";
import { AITab } from "./AITab";
import { VaultsTab } from "./VaultsTab";
import { ShortcutsTab } from "./ShortcutsTab";
import { MaintenanceTab } from "./MaintenanceTab";
import { SyncTab } from "./SyncTab";
import { useAiSettingsManager } from "./hooks/useAiSettingsManager";


// ── Types ──────────────────────────────────────────────

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSwitchVault: (path: string) => void;
    initialTab?: Tab;
    vaultPath?: string;
}

type Tab = "about" | "general" | "ai" | "vaults" | "shortcuts" | "maintenance" | "sync";




// ── Component ──────────────────────────────────────────

export const SettingsModal = ({ isOpen, onClose, onSwitchVault, initialTab, vaultPath }: SettingsModalProps) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState<Tab>(initialTab || "general");
    const [closeBlocked, setCloseBlocked] = useState(false);
    const [pinWarning, setPinWarning] = useState(false);

    const handleClose = () => {
        if (closeBlocked) {
            setPinWarning(true);
            setActiveTab('sync');
            setTimeout(() => setPinWarning(false), 3000);
            return;
        }
        onClose();
    };

    // 当 initialTab 变化时（如从 AI 按钮打开）自动切换
    useEffect(() => {
        if (isOpen && initialTab) {
            setActiveTab(initialTab);
        }
    }, [isOpen, initialTab]);

    // ── About State ──
    const [appVersion, setAppVersion] = useState<string>('');

    // ── Vault State ──
    const [vaults, setVaults] = useState<VaultInfo[]>([]);
    const [currentVault, setCurrentVault] = useState<string | null>(vaultPath || null);

    // ── Data Loading & Callbacks ──────────────────────

    const checkAIStatus = async () => {
        // AI 状态探测已下放到 AITab 挂载与在线保存时按需触发，此回调仅作空实现以兼容 useAiSettingsManager
    };

    // ── Provider Config (Moved to Custom Hook) ──
    const aiManager = useAiSettingsManager(checkAIStatus);
    const { state: aiState, actions: aiActions } = aiManager;

    const loadVaults = () => {
        const v = vaultService.getVaults();
        setVaults(v);
        setCurrentVault(vaultPath || vaultService.getLastOpenedVault());
    };

    const handleCreateVault = async () => {
        const path = await vaultService.createVault();
        if (path) { onSwitchVault(path); onClose(); }
    };

    const handleOpenVault = async () => {
        const path = await vaultService.openVault();
        if (path) { onSwitchVault(path); onClose(); }
    };

    const handleSwitchVault = (path: string) => {
        vaultService.addVault(path);
        onSwitchVault(path);
        onClose();
    };

    const handleRemoveVault = (e: React.MouseEvent, path: string) => {
        e.stopPropagation();
        vaultService.removeVault(path);
        loadVaults();
    };

    // ── Effects ───────────────────────────────────────

    useEffect(() => {
        if (isOpen) {
            setActiveTab(initialTab || "about");
            loadVaults();
            import('@tauri-apps/api/app').then(({ getVersion }) => {
                getVersion().then(setAppVersion);
            });
            aiActions.loadProviderConfig();
        }
    }, [isOpen]);

    if (!isOpen) return null;

    // ── Sidebar Tab Config ────────────────────────────

    const tabs: { id: Tab; label: string; icon?: React.ReactNode }[] = [
        { id: "about", label: t("settings.about") || "About" },
        { id: "general", label: t("settings.general") },
        { id: "ai", label: "AI", icon: <Bot size={14} /> },
        { id: "vaults", label: t("settings.vaults") || "Vaults" },
        { id: "shortcuts", label: t("settings.shortcuts") || "Shortcuts" },
        { id: "maintenance", label: t("settings.maintenance") || "Maintenance" },
        { id: "sync", label: t("settings.sync") || "Sync" },
    ];

    // ── Render ────────────────────────────────────────

    return (
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-zinc-50/10 transition-opacity"
            onClick={handleClose}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className="w-[800px] h-[600px] bg-white dark:bg-zinc-900 rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-transparent dark:border-zinc-800">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 dark:border-zinc-800">
                    <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t("settings.title")}</h2>
                    <div className="flex items-center gap-2">
                        {pinWarning && (
                            <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 animate-pulse">
                                <ShieldAlert size={14} />
                                {t('settings.pin_required', '请先设置 PIN 码')}
                            </span>
                        )}
                        <button
                            onClick={handleClose}
                            className="p-1 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        >
                            <X size={20} />
                        </button>
                    </div>
                </div>

                <div className="flex flex-1 overflow-hidden">
                    {/* Sidebar */}
                    <div className="w-40 bg-zinc-50 dark:bg-zinc-950/50 border-r border-zinc-100 dark:border-zinc-800 p-3 space-y-1">
                        {tabs.map(tab => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={cn(
                                    "w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                                    tab.icon && "flex items-center gap-2",
                                    activeTab === tab.id
                                        ? "bg-white dark:bg-zinc-800 text-[#002FA7] dark:text-blue-400 shadow-sm ring-1 ring-zinc-200 dark:ring-zinc-700"
                                        : "text-zinc-600 dark:text-zinc-400 hover:bg-white dark:hover:bg-zinc-800 hover:text-[#002FA7] dark:hover:text-blue-400 hover:shadow-sm hover:ring-1 hover:ring-zinc-200 dark:hover:ring-zinc-700"
                                )}
                            >
                                {tab.icon}
                                {tab.label}
                            </button>
                        ))}
                    </div>

                    {/* Content */}
                    <div className="flex-1 p-6 bg-white dark:bg-zinc-900 overflow-y-auto">
                        {activeTab === "about" && (
                            <AboutTab
                                appVersion={appVersion}
                            />
                        )}

                        {activeTab === "general" && <GeneralTab />}

                        {activeTab === "ai" && (
                            <AITab
                                aiState={aiState}
                                aiActions={aiActions}
                            />
                        )}

                        {activeTab === "vaults" && (
                            <VaultsTab
                                vaults={vaults}
                                currentVault={currentVault}
                                handleCreateVault={handleCreateVault}
                                handleOpenVault={handleOpenVault}
                                handleSwitchVault={handleSwitchVault}
                                handleRemoveVault={handleRemoveVault}
                            />
                        )}

                        {activeTab === "shortcuts" && <ShortcutsTab />}

                        {activeTab === "maintenance" && <MaintenanceTab />}

                        {activeTab === "sync" && (
                            <SyncTab vaultPath={vaultPath || currentVault || undefined} onBlockClose={setCloseBlocked} />
                        )}


                    </div>
                </div>
            </div>
        </div>
    );
};
