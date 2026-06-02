import { RotateCcw, Keyboard } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/utils/cn";
import { getCommandsByCategory } from "@/modules/keybindings/registry";
import { useKeybindingsStore, captureKeyCombo } from "@/modules/keybindings/KeybindingsStore";
import { useState } from "react";

export const ShortcutsTab = () => {
    const { t } = useTranslation();
    const commandsByCategory = getCommandsByCategory();
    const { customKeys, setCustomKey, resetKey, getEffectiveKey } = useKeybindingsStore();
    const [editingCommandId, setEditingCommandId] = useState<string | null>(null);

    return (
        <div className="space-y-6">
            <div>
                <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-1 flex items-center gap-2">
                    <Keyboard size={16} className="text-[#545454] dark:text-[#C8C8C8]" />
                    {t("commands.title")}
                </h3>
                <p className="text-sm text-[#545454] dark:text-[#C8C8C8] mb-3">
                    {t("settings.shortcuts_hint") || "Click on a shortcut to change it. Press Escape to cancel."}
                </p>
                <div className="space-y-6">
                    {Object.entries(commandsByCategory).map(([category, commands]) => (
                        <div key={category}>
                            <h4 className="text-xs font-semibold text-[#545454] dark:text-[#C8C8C8] uppercase tracking-wider mb-2 px-1">
                                {t(`commands.categories.${category.toLowerCase()}`) || category}
                            </h4>
                            <div className="bg-white dark:bg-zinc-900 rounded-lg p-1 border border-[#C8C8C8] dark:border-[#C8C8C8]/30">
                                {commands.map((cmd) => {
                                    const effectiveKey = getEffectiveKey(cmd.id);
                                    const isCustom = customKeys[cmd.id] !== undefined;
                                    const isEditing = editingCommandId === cmd.id;

                                    return (
                                        <div key={cmd.id} className="flex items-center justify-between px-2 py-2">
                                            <span className="text-sm text-zinc-900 dark:text-zinc-100">
                                                {t(`commands.${cmd.id}`) !== `commands.${cmd.id}` ? t(`commands.${cmd.id}`) : cmd.label}
                                            </span>
                                            <div className="flex items-center gap-2">
                                                {isEditing ? (
                                                    <div
                                                        className="px-3 py-1 bg-indigo-100 dark:bg-indigo-900/30 border-2 border-indigo-500 dark:border-blue-400/60 rounded text-xs font-medium text-indigo-700 dark:text-blue-300 animate-pulse"
                                                        tabIndex={0}
                                                        autoFocus
                                                        onKeyDown={(e) => {
                                                            e.preventDefault();
                                                            e.stopPropagation();

                                                            if (e.key === 'Escape') {
                                                                setEditingCommandId(null);
                                                                return;
                                                            }

                                                            const combo = captureKeyCombo(e.nativeEvent);
                                                            if (combo) {
                                                                setCustomKey(cmd.id, combo);
                                                                setEditingCommandId(null);
                                                            }
                                                        }}
                                                        onBlur={() => setEditingCommandId(null)}
                                                    >
                                                        {t("settings.press_key") || "Press new key..."}
                                                    </div>
                                                ) : (
                                                    <button
                                                        onClick={() => setEditingCommandId(cmd.id)}
                                                        className={cn(
                                                            "flex gap-1 cursor-pointer hover:ring-2 hover:ring-indigo-300 dark:hover:ring-blue-400/40 rounded transition-all",
                                                            isCustom && "ring-1 ring-indigo-400 dark:ring-blue-400/60"
                                                        )}
                                                        title={t("settings.click_to_change") || "Click to change"}
                                                    >
                                                        {effectiveKey.split('+').map((k, i) => (
                                                            <kbd key={i} className="px-1 py-0.5 bg-zinc-100 dark:bg-zinc-800 border border-[#C8C8C8]/50 dark:border-[#C8C8C8]/30 rounded text-xs font-sans font-medium text-[#545454] dark:text-[#C8C8C8] shadow-sm min-w-[20px] text-center">
                                                                {k === 'Mod' ? (navigator.platform.includes('Mac') ? '⌘' : 'Ctrl') : k}
                                                            </kbd>
                                                        ))}
                                                    </button>
                                                )}
                                                {isCustom && !isEditing && (
                                                    <button
                                                        onClick={() => resetKey(cmd.id)}
                                                        className="p-1 text-[#545454] hover:text-zinc-900 dark:text-[#C8C8C8] dark:hover:text-white transition-colors"
                                                        title={t("settings.reset_to_default") || "Reset to default"}
                                                    >
                                                        <RotateCcw size={14} />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
