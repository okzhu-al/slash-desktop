import { TFunction } from 'i18next';

export interface OnlineProvider {
    id: string;
    label: string | ((t: TFunction) => string);
    baseUrl: string;
    defaultModel: string;
    keyPrefix: string;
}

export class OnlineProviderRegistry {
    static getProviders(t: TFunction): OnlineProvider[] {
        return [
            { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.0-flash', keyPrefix: 'AIza...' },
            { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat', keyPrefix: 'sk-...' },
            { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com', defaultModel: 'gpt-4o-mini', keyPrefix: 'sk-...' },
            { id: 'qwen', label: `${t('settings.online_qwen')} (Qwen)`, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode', defaultModel: 'qwen-plus', keyPrefix: 'sk-...' },
            { id: 'custom', label: t('settings.online_custom'), baseUrl: '', defaultModel: '', keyPrefix: 'sk-...' },
        ];
    }

    static getPreset(t: TFunction, id: string | null): OnlineProvider {
        const providers = this.getProviders(t);
        return providers.find(p => p.id === id) || providers[0];
    }

    static getEffectiveBaseUrl(t: TFunction, id: string | null, customUrl: string): string {
        const preset = this.getPreset(t, id);
        return customUrl || preset.baseUrl;
    }

    static canFetchModels(t: TFunction, id: string | null, customUrl: string, apiKey: string, hasSavedKey: boolean): boolean {
        const effectiveUrl = this.getEffectiveBaseUrl(t, id, customUrl);
        return Boolean(effectiveUrl) && (Boolean(apiKey) || hasSavedKey);
    }
}
