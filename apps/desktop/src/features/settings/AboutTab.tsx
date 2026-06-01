import { useState } from "react";
import { useTranslation } from "react-i18next";
import slashLogo from '@/assets/icon.png';
import { UpdateCheckerModal } from "./UpdateCheckerModal";

interface AboutTabProps {
    appVersion: string;
}

export const AboutTab = ({
    appVersion,
}: AboutTabProps) => {
    const { t } = useTranslation();
    const [showUpdateModal, setShowUpdateModal] = useState(false);

    return (
        <div className="relative flex flex-col items-center justify-center h-full">
            {/* Logo */}
            <img 
                src={slashLogo} 
                alt="Slash" 
                className="w-24 h-24 mb-6 shadow-2xl shadow-indigo-900/20 select-none pointer-events-none"
                style={{ borderRadius: '22.5%' }}
            />

            {/* App Name */}
            <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 mb-2 font-serif">
                Slash
            </h1>

            {/* Version */}
            <p className="text-sm text-[#545454] dark:text-[#C8C8C8]">
                {t("settings.version", "Version")} {appVersion || "..."}
            </p>

            {/* Optional: Additional info */}
            <p className="text-xs text-[#545454] dark:text-[#C8C8C8] mt-4 mb-8">
                {t("settings.about_desc", "Local-first structured thinking space.")}
            </p>

            {/* Check for Updates */}
            <button 
                onClick={() => setShowUpdateModal(true)}
                className="absolute bottom-2 right-2 text-xs font-medium text-[#002FA7] hover:text-[#002FA7]/80 dark:text-blue-400 dark:hover:text-blue-300 transition-colors px-3 py-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
                {t("settings.check_updates", "检查版本更新")}
            </button>

            {/* Update Checker Modal */}
            {showUpdateModal && (
                <UpdateCheckerModal onClose={() => setShowUpdateModal(false)} />
            )}
        </div>
    );
};
