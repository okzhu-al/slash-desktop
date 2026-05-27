import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import common_en from '../../locales/en/common.json';
import common_zh from '../../locales/zh-CN/common.json';

i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
        resources: {
            en: { common: common_en },
            zh: { common: common_zh },
            'zh-CN': { common: common_zh }
        },
        fallbackLng: 'en',
        defaultNS: 'common',
        debug: false,
        interpolation: {
            escapeValue: false,
        },
    });

// ── 同步 <html lang> 属性 ──
// 确保浏览器的 CJK 字体回退链使用正确的地区字形（简体中文）。
// macOS 上 <html lang="en"> 会导致 monospace CJK 回退到日文/繁体字形。
function syncHtmlLang(lng: string) {
    const mapped = lng.startsWith('zh') ? 'zh-CN' : lng;
    document.documentElement.lang = mapped;
}
syncHtmlLang(i18n.language);
i18n.on('languageChanged', syncHtmlLang);

export default i18n;
