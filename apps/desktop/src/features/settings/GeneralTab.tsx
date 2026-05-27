import { useTranslation } from "react-i18next";
import { cn } from "@/shared/utils/cn";
import { useTheme } from "@/core/theme/ThemeProvider";
import { Monitor, Languages } from "lucide-react";

export const GeneralTab = () => {
    const { t, i18n } = useTranslation();
    const { theme, setTheme, editorWidth, setEditorWidth } = useTheme();

    const handleLanguageChange = (lang: string) => {
        i18n.changeLanguage(lang);
        localStorage.setItem("i18nextLng", lang);
    };

    return (
        <div className="space-y-6">
            {/* ── 外观与排版 ── */}
            <div>
                <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-1 flex items-center gap-2">
                    <Monitor size={16} className="text-[#545454] dark:text-[#C8C8C8]" />
                    {t("settings.appearance")}
                </h3>
                <p className="text-sm text-[#545454] dark:text-[#C8C8C8] mb-3">
                    {t("settings.appearance_desc") || "调整应用的主题配色与编辑器的显示宽度。"}
                </p>
                <div className="space-y-4">
                    
                    {/* 主题 */}
                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <label className="text-xs font-medium text-[#545454] dark:text-[#C8C8C8]">{t("settings.theme")}</label>
                        </div>
                        <div className="flex bg-white dark:bg-zinc-900 border border-[#C8C8C8] dark:border-[#C8C8C8]/30 p-1 rounded-lg w-max">
                            {(['light', 'dark', 'system'] as const).map((tMode) => (
                                <button
                                    key={tMode}
                                    onClick={() => setTheme(tMode)}
                                    className={cn(
                                        "px-4 py-1.5 rounded-md text-sm font-medium transition-all capitalize",
                                        theme === tMode
                                            ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm"
                                            : "text-[#545454] dark:text-[#C8C8C8] hover:text-zinc-700 dark:hover:text-zinc-200"
                                    )}
                                >
                                    {t(`settings.theme_${tMode}`)}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="border-t border-[#C8C8C8] dark:border-[#C8C8C8]/30" />

                    {/* 宽度 */}
                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <label className="text-xs font-medium text-[#545454] dark:text-[#C8C8C8]">{t("settings.editor_width")}</label>
                        </div>
                        <div className="flex bg-white dark:bg-zinc-900 border border-[#C8C8C8] dark:border-[#C8C8C8]/30 p-1 rounded-lg w-max">
                            {(['standard', 'full'] as const).map((wMode) => (
                                <button
                                    key={wMode}
                                    onClick={() => setEditorWidth && setEditorWidth(wMode)}
                                    className={cn(
                                        "px-4 py-1.5 rounded-md text-sm font-medium transition-all",
                                        editorWidth === wMode
                                            ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm"
                                            : "text-[#545454] dark:text-[#C8C8C8] hover:text-zinc-700 dark:hover:text-zinc-200"
                                    )}
                                >
                                    {t(`settings.width_${wMode}`)}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* ── 语言 ── */}
            <div className="pt-4 border-t border-zinc-100 dark:border-zinc-800">
                <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-1 flex items-center gap-2">
                    <Languages size={16} className="text-[#545454] dark:text-[#C8C8C8]" />
                    {t("settings.language")}
                </h3>
                <p className="text-sm text-[#545454] dark:text-[#C8C8C8] mb-3">
                    {t("settings.language_desc") || "设置应用的显示语言。"}
                </p>
                <div className="space-y-4">
                    <div>
                        <div className="flex bg-white dark:bg-zinc-900 border border-[#C8C8C8] dark:border-[#C8C8C8]/30 p-1 rounded-lg w-max">
                            <button
                                onClick={() => handleLanguageChange("en")}
                                className={cn(
                                    "px-4 py-1.5 rounded-md text-sm font-medium transition-all",
                                    i18n.language === "en" || i18n.language.startsWith("en-")
                                        ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm"
                                        : "text-[#545454] dark:text-[#C8C8C8] hover:text-zinc-700 dark:hover:text-zinc-200"
                                )}
                            >
                                English
                            </button>
                            <button
                                onClick={() => handleLanguageChange("zh-CN")}
                                className={cn(
                                    "px-4 py-1.5 rounded-md text-sm font-medium transition-all",
                                    i18n.language === "zh-CN" || i18n.language.startsWith("zh")
                                        ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm"
                                        : "text-[#545454] dark:text-[#C8C8C8] hover:text-zinc-700 dark:hover:text-zinc-200"
                                )}
                            >
                                中文
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
