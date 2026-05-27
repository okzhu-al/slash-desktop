import { useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';

export interface OnlineProviderView {
    id: string;
    label: string;
    base_url: string;
    model: string;
    active: boolean;
    has_key: boolean;
}

export function useAiSettingsManager(checkAIStatus: () => void) {
    const { t } = useTranslation();
    
    // Core generic states
    const [providerType, setProviderType] = useState<'local'|'online'>('local');
    const [configLoaded, setConfigLoaded] = useState(false);

    // Local model states
    const [ollamaHost, setOllamaHost] = useState('http://localhost');
    const [ollamaPort, setOllamaPort] = useState(11434);
    const [generationModel, setGenerationModel] = useState('');
    const [embeddingModel, setEmbeddingModel] = useState('bge-m3');

    // Online API states
    const [onlineBaseUrl, setOnlineBaseUrl] = useState('');
    const [onlineApiKey, setOnlineApiKey] = useState('');
    const [onlineModel, setOnlineModel] = useState('');
    const [showApiKey, setShowApiKey] = useState(false);
    
    // UI Feedback states
    const [providerSaving, setProviderSaving] = useState(false);
    const [providerTestResult, setProviderTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [modelsFetching, setModelsFetching] = useState(false);
    
    // Providers tracking
    const [savedProviders, setSavedProviders] = useState<OnlineProviderView[]>([]);
    const savedProviderConfig = useRef(new Map<string, { apiKey: string; model: string }>());

    const loadOnlineProviders = async () => {
        try {
            const providers = await invoke<OnlineProviderView[]>('get_online_providers');
            setSavedProviders(providers);
            const active = providers.find(p => p.active);
            if (active) {
                setOnlineBaseUrl(active.base_url);
                setOnlineModel(active.model);
            }
        } catch (e) {
            console.error('Failed to load online providers:', e);
        }
    };

    const loadProviderConfig = async () => {
        try {
            const cfg = await invoke<{
                provider_type: string;
                ollama_host: string;
                ollama_port: number;
                generation_model: string;
                embedding_model: string;
                online_api_key: string;
                online_base_url: string;
                online_model: string;
            }>('get_ai_provider_config');
            setProviderType((cfg.provider_type as 'local' | 'online') || 'local');
            setOllamaHost(cfg.ollama_host || 'http://localhost');
            setOllamaPort(cfg.ollama_port || 11434);
            setGenerationModel(cfg.generation_model || '');
            setEmbeddingModel(cfg.embedding_model || 'bge-m3');
            
            await loadOnlineProviders();
            setConfigLoaded(true);
        } catch (e) {
            console.error('Failed to load provider config:', e);
            setConfigLoaded(true);
        }
    };

    const handleSaveProvider = async (type: 'local' | 'online', overrides?: { generationModel?: string; embeddingModel?: string; ollamaHost?: string; ollamaPort?: number }) => {
        setProviderSaving(true);
        setProviderTestResult(null);
        try {
            await invoke('set_ai_provider_config', {
                config: {
                    provider_type: type,
                    ollama_host: overrides?.ollamaHost ?? ollamaHost,
                    ollama_port: overrides?.ollamaPort ?? ollamaPort,
                    generation_model: overrides?.generationModel ?? generationModel,
                    embedding_model: overrides?.embeddingModel ?? embeddingModel,
                    online_api_key: '',
                    online_base_url: '',
                    online_model: '',
                },
            });
            if (type === 'local') {
                const status = await invoke<{ generation_model_available: boolean }>('check_ai_connection');
                setProviderTestResult({
                    ok: status.generation_model_available,
                    msg: status.generation_model_available ? t('settings.online_connected', '连接成功') : t('settings.online_failed', '连接失败'),
                });
            }
            checkAIStatus();
            window.dispatchEvent(new CustomEvent('ai_settings_changed'));
        } catch (e) {
            setProviderTestResult({ ok: false, msg: `${e}` });
        } finally {
            setProviderSaving(false);
        }
    };

    const handleSaveOnlineProvider = async (providerId: string, label: string, baseUrl: string, model: string, apiKey: string) => {
        setProviderSaving(true);
        setProviderTestResult(null);
        try {
            await invoke('save_online_provider', { id: providerId, label, baseUrl, model, apiKey });
            const status = await invoke<{ generation_model_available: boolean }>('check_ai_connection');
            setProviderTestResult({
                ok: status.generation_model_available,
                msg: status.generation_model_available ? t('settings.online_connected', '连接成功') : t('settings.online_failed', '连接失败'),
            });
            setOnlineApiKey('');
            savedProviderConfig.current?.delete(providerId);
            await loadOnlineProviders();
            checkAIStatus();
            window.dispatchEvent(new CustomEvent('ai_settings_changed'));
        } catch (e) {
            setProviderTestResult({ ok: false, msg: `${e}` });
        } finally {
            setProviderSaving(false);
        }
    };

    const handleActivateProvider = async (providerId: string) => {
        try {
            await invoke('activate_online_provider', { id: providerId });
            await loadOnlineProviders();
            checkAIStatus();
            window.dispatchEvent(new CustomEvent('ai_settings_changed'));
        } catch (e) {
            console.error('Failed to activate provider:', e);
        }
    };

    const handleDeleteProvider = async (providerId: string) => {
        try {
            await invoke('delete_online_provider', { id: providerId });
            savedProviderConfig.current?.delete(providerId);
            await loadOnlineProviders();
            // Thoroughly reset UI to unconfigured state AFTER loadOnlineProviders
            // (override any values loadOnlineProviders might have set)
            const remaining = await invoke<OnlineProviderView[]>('get_online_providers');
            const stillExists = remaining.some(p => p.id === providerId);
            if (!stillExists) {
                setOnlineApiKey('');
                setOnlineModel('');
                setAvailableModels([]);
                setProviderTestResult(null);
            }
            checkAIStatus();
            window.dispatchEvent(new CustomEvent('ai_settings_changed'));
        } catch (e) {
            console.error('Failed to delete provider:', e);
        }
    };

    return {
        state: {
            providerType, configLoaded, ollamaHost, ollamaPort, generationModel, embeddingModel,
            onlineBaseUrl, onlineApiKey, onlineModel, showApiKey,
            providerSaving, providerTestResult, availableModels, modelsFetching,
            savedProviders, savedProviderConfig
        },
        actions: {
            setProviderType, setOllamaHost, setOllamaPort, setGenerationModel, setEmbeddingModel,
            setOnlineBaseUrl, setOnlineApiKey, setOnlineModel, setShowApiKey,
            setProviderTestResult, setAvailableModels, setModelsFetching,
            loadProviderConfig, loadOnlineProviders,
            handleSaveProvider, handleSaveOnlineProvider, handleActivateProvider, handleDeleteProvider
        }
    };
}
