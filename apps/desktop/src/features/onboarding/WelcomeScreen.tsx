
import { useTranslation } from 'react-i18next';
import { FolderOpen, PlusSquare, ChevronDown, Folder, Minus, Square, X, Copy } from 'lucide-react';
import { vaultService, VaultInfo } from '@/core/vault/VaultService';
import { useState, useEffect, useRef } from 'react';
import { cn } from '@/shared/utils/cn';
import slashLogo from '@/assets/icon.png';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface WelcomeScreenProps {
    onVaultOpened: (path: string) => void;
}

export const WelcomeScreen = ({ onVaultOpened }: WelcomeScreenProps) => {
    const { t } = useTranslation();
    const [isCreating, setIsCreating] = useState(false);
    const [isVaultListOpen, setIsVaultListOpen] = useState(false);
    const [availableVaults, setAvailableVaults] = useState<VaultInfo[]>([]);
    const vaultListRef = useRef<HTMLDivElement>(null);

    const [isMac, setIsMac] = useState(false);
    const [isWindowMaximized, setIsWindowMaximized] = useState(false);

    // Load existing vaults on mount and register window resize listeners
    useEffect(() => {
        vaultService.cleanupDeletedVaults().then(setAvailableVaults);

        const isMacOS = navigator.userAgent.includes("Mac");
        setIsMac(isMacOS);

        if (!isMacOS) {
            const checkMaximized = async () => {
                try {
                    const maximized = await getCurrentWindow().isMaximized();
                    setIsWindowMaximized(maximized);
                } catch (e) {
                    // Ignore
                }
            };
            checkMaximized();

            let unlisten: (() => void) | undefined;
            getCurrentWindow().onResized(async () => {
                checkMaximized();
            }).then(fn => {
                unlisten = fn;
            }).catch(() => {});

            return () => {
                if (unlisten) unlisten();
            };
        }
    }, []);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (vaultListRef.current && !vaultListRef.current.contains(e.target as Node)) {
                setIsVaultListOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleSelectVault = (path: string) => {
        vaultService.addVault(path); // Update lastUsed
        onVaultOpened(path);
        setIsVaultListOpen(false);
    };

    const handleCreateVault = async () => {
        setIsCreating(true);
        const path = await vaultService.createVault();
        if (path) {
            onVaultOpened(path);
        }
        setIsCreating(false);
    };

    const minimize = () => getCurrentWindow().minimize();
    const maximize = async () => {
        await getCurrentWindow().toggleMaximize();
        try {
            const maximized = await getCurrentWindow().isMaximized();
            setIsWindowMaximized(maximized);
        } catch (e) {
            // Ignore
        }
    };
    const close = () => getCurrentWindow().close();

    return (
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-900 select-none">
            {/* Top title bar area for frameless support */}
            <div data-tauri-drag-region className="fixed top-0 left-0 right-0 h-8 flex justify-end select-none z-50">
                {/* Window Controls (Windows only) */}
                {!isMac && (
                    <div className="flex text-zinc-800 dark:text-zinc-200 shrink-0 h-full bg-transparent">
                        <button onClick={minimize} className="inline-flex justify-center items-center w-[46px] h-full hover:bg-zinc-200 dark:hover:bg-zinc-800/80 transition-colors duration-200 ease-in-out rounded-none focus:outline-none no-drag">
                            <Minus size={14} strokeWidth={1.5} />
                        </button>
                        <button onClick={maximize} className="inline-flex justify-center items-center w-[46px] h-full hover:bg-zinc-200 dark:hover:bg-zinc-800/80 transition-colors duration-200 ease-in-out rounded-none focus:outline-none no-drag">
                            {isWindowMaximized ? <Copy size={12} strokeWidth={1.5} /> : <Square size={12} strokeWidth={1.5} />}
                        </button>
                        <button onClick={close} className="inline-flex justify-center items-center w-[46px] h-full hover:bg-[#e81123] hover:text-white transition-colors duration-200 ease-in-out rounded-none focus:outline-none no-drag">
                            <X size={14} strokeWidth={1.5} />
                        </button>
                    </div>
                )}
            </div>

            <div className="mb-12 flex flex-col items-center animate-in fade-in zoom-in-95 duration-500">
                <img 
                    src={slashLogo} 
                    alt="Slash" 
                    className="w-20 h-20 mb-6 shadow-xl shadow-indigo-900/20 select-none pointer-events-none"
                    style={{ borderRadius: '22.5%' }}
                />
                <h1 className="text-4xl font-bold text-zinc-900 dark:text-zinc-100 mb-2 font-serif">
                    {t('onboarding.welcome')}
                </h1>
                <p className="text-zinc-500 dark:text-zinc-400 text-md">
                    {t('onboarding.description')}
                </p>
            </div>

            <div className="flex flex-col gap-4 w-80 animate-in slide-in-from-bottom-4 duration-700 delay-150">
                {/* Open Existing Vault - Shows vault list */}
                <div className="relative" ref={vaultListRef}>
                    <button
                        onClick={() => setIsVaultListOpen(!isVaultListOpen)}
                        disabled={isCreating || availableVaults.length === 0}
                        className="group relative w-full flex items-center gap-4 p-4 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl hover:border-indigo-500 dark:hover:border-indigo-500 hover:shadow-md transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <div className="p-3 bg-zinc-100 dark:bg-zinc-700/50 rounded-lg group-hover:bg-indigo-50 dark:group-hover:bg-indigo-900/20 text-zinc-500 dark:text-zinc-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                            <FolderOpen size={24} />
                        </div>
                        <div className="flex-1">
                            <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                                {t('onboarding.open_vault')}
                            </div>
                            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                                {availableVaults.length > 0
                                    ? t('onboarding.open_vault_desc')
                                    : '暂无已有笔记库'}
                            </div>
                        </div>
                        {availableVaults.length > 0 && (
                            <ChevronDown
                                size={20}
                                className={cn(
                                    "text-zinc-400 transition-transform",
                                    isVaultListOpen && "rotate-180"
                                )}
                            />
                        )}
                    </button>

                    {/* Vault List Dropdown */}
                    {isVaultListOpen && availableVaults.length > 0 && (
                        <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                            {availableVaults
                                .sort((a, b) => b.lastUsed - a.lastUsed)
                                .map((vault) => (
                                    <button
                                        key={vault.path}
                                        onClick={() => handleSelectVault(vault.path)}
                                        className="w-full flex items-center gap-3 px-4 py-3 text-left text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                                    >
                                        <Folder size={18} className="text-zinc-400" />
                                        <div className="flex-1 min-w-0">
                                            <div className="font-medium truncate">{vault.name}</div>
                                            <div className="text-xs text-zinc-400 truncate">{vault.path}</div>
                                        </div>
                                    </button>
                                ))}
                        </div>
                    )}
                </div>

                {/* Create New Vault - Opens file picker */}
                <button
                    onClick={handleCreateVault}
                    disabled={isCreating}
                    className="group relative flex items-center gap-4 p-4 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl hover:border-indigo-500 dark:hover:border-indigo-500 hover:shadow-md transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <div className="p-3 bg-zinc-100 dark:bg-zinc-700/50 rounded-lg group-hover:bg-indigo-50 dark:group-hover:bg-indigo-900/20 text-zinc-500 dark:text-zinc-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                        <PlusSquare size={24} />
                    </div>
                    <div>
                        <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                            {t('onboarding.create_vault')}
                        </div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                            {t('onboarding.create_vault_desc')}
                        </div>
                    </div>
                </button>
            </div>
        </div>
    );
};
