import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { exists, mkdir, writeTextFile } from '@tauri-apps/plugin-fs';
import i18n from '@/core/i18n/config';
import aboutSlashGuide from '../../../../../docs/user/desktop/README.md?raw';
import aiGuide from '../../../../../docs/user/desktop/ai-guide.md?raw';
import inputGuide from '../../../../../docs/user/desktop/input-guide.md?raw';
import aboutSlashGuideEn from '../../../../../docs/user/desktop/en/README.md?raw';
import aiGuideEn from '../../../../../docs/user/desktop/en/ai-guide.md?raw';
import inputGuideEn from '../../../../../docs/user/desktop/en/input-guide.md?raw';

const STORAGE_KEY_VAULTS = 'slash-vaults-history';
const CONFIG_DIR_NAME = '.slash';

const DESKTOP_USER_GUIDE_PATHS = {
    aboutSlash: '00_Inbox/About Slash.md',
    inputGuide: '03_Resources/Slash Input Guide.md',
    aiGuide: '03_Resources/Slash AI Guide.md',
} as const;

const DESKTOP_USER_GUIDES_BY_LANGUAGE = {
    zh: [
        {
            seedKey: 'about-slash',
            path: DESKTOP_USER_GUIDE_PATHS.aboutSlash,
            content: aboutSlashGuide,
        },
        {
            seedKey: 'input-guide',
            path: DESKTOP_USER_GUIDE_PATHS.inputGuide,
            content: inputGuide,
        },
        {
            seedKey: 'ai-guide',
            path: DESKTOP_USER_GUIDE_PATHS.aiGuide,
            content: aiGuide,
        },
    ],
    en: [
        {
            seedKey: 'about-slash',
            path: DESKTOP_USER_GUIDE_PATHS.aboutSlash,
            content: aboutSlashGuideEn,
        },
        {
            seedKey: 'input-guide',
            path: DESKTOP_USER_GUIDE_PATHS.inputGuide,
            content: inputGuideEn,
        },
        {
            seedKey: 'ai-guide',
            path: DESKTOP_USER_GUIDE_PATHS.aiGuide,
            content: aiGuideEn,
        },
    ],
} as const;

type SeedLanguage = keyof typeof DESKTOP_USER_GUIDES_BY_LANGUAGE;

function getDesktopGuideSeedLanguage(): SeedLanguage {
    const language = i18n.resolvedLanguage || i18n.language || localStorage.getItem('i18nextLng') || navigator.language || 'en';
    return language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export interface VaultInfo {
    path: string;
    name: string;
    lastUsed: number;
}

export interface VaultService {
    getVaults(): VaultInfo[];
    getLastOpenedVault(): string | null;
    openVault(): Promise<string | null>;
    createVault(): Promise<string | null>;
    initializeVault(path: string): Promise<void>;
    addVault(path: string): void;
    removeVault(path: string): void;
    cleanupDeletedVaults(): Promise<VaultInfo[]>;
}

class TauriVaultService implements VaultService {

    getVaults(): VaultInfo[] {
        const stored = localStorage.getItem(STORAGE_KEY_VAULTS);
        if (!stored) return [];
        try {
            const vaults: VaultInfo[] = JSON.parse(stored);

            // Deduplicate by case-insensitive path (macOS filesystem is case-insensitive)
            // Keep the most recently used one
            const seen = new Map<string, VaultInfo>();
            for (const vault of vaults) {
                const key = vault.path.toLowerCase();
                const existing = seen.get(key);
                if (!existing || vault.lastUsed > existing.lastUsed) {
                    seen.set(key, vault);
                }
            }

            const deduped = Array.from(seen.values());

            // If we removed duplicates, save the cleaned list
            if (deduped.length < vaults.length) {
                this.saveVaults(deduped);
            }

            return deduped;
        } catch (e) {
            console.error("Failed to parse vaults history", e);
            return [];
        }
    }

    private saveVaults(vaults: VaultInfo[]) {
        localStorage.setItem(STORAGE_KEY_VAULTS, JSON.stringify(vaults));
    }

    getLastOpenedVault(): string | null {
        const vaults = this.getVaults();
        if (vaults.length === 0) return null;
        // Sort by lastUsed desc
        return vaults.sort((a, b) => b.lastUsed - a.lastUsed)[0].path;
    }

    addVault(path: string) {
        let vaults = this.getVaults();
        // Remove if exists to update position/timestamp (case-insensitive for macOS)
        vaults = vaults.filter(v => v.path.toLowerCase() !== path.toLowerCase());

        // Add to top
        // We need to get basename. For now, simple string split.
        const name = path.split(/[/\\]/).pop() || 'Untitled Vault';

        vaults.push({
            path,
            name,
            lastUsed: Date.now()
        });

        this.saveVaults(vaults);
    }

    removeVault(path: string) {
        let vaults = this.getVaults();
        // Case-insensitive for macOS
        vaults = vaults.filter(v => v.path.toLowerCase() !== path.toLowerCase());
        this.saveVaults(vaults);
    }

    async cleanupDeletedVaults(): Promise<VaultInfo[]> {
        const vaults = this.getVaults();
        const validVaults: VaultInfo[] = [];

        for (const vault of vaults) {
            try {
                const vaultExists = await invoke<boolean>('safe_dir_exists', { path: vault.path });
                if (vaultExists) {
                    validVaults.push(vault);
                } else {
                    console.log(`🗑️ [VaultService] Removing deleted vault: ${vault.name}`);
                }
            } catch (e) {
                // If we can't check, assume it exists to be safe
                validVaults.push(vault);
            }
        }

        // Only save if something changed
        if (validVaults.length !== vaults.length) {
            this.saveVaults(validVaults);
        }

        return validVaults;
    }

    async openVault(): Promise<string | null> {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: 'Open Slash Vault'
            });

            if (selected && typeof selected === 'string') {
                await this.initializeVault(selected);
                await this.seedDesktopUserGuides(selected);
                this.addVault(selected);
                return selected;
            }
            return null;
        } catch (error) {
            console.error('Failed to open vault dialog:', error);
            return null;
        }
    }

    async createVault(): Promise<string | null> {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: 'Select Folder for New Vault'
            });

            if (selected && typeof selected === 'string') {
                await this.initializeVault(selected);
                this.addVault(selected);
                await this.seedDesktopUserGuides(selected);
                return selected;
            }
            return null;
        } catch (error) {
            console.error('Failed to create vault dialog:', error);
            return null;
        }
    }

    async initializeVault(path: string): Promise<void> {
        // Ensure .slash directory exists
        const { join } = await import('@tauri-apps/api/path');
        const configPath = await join(path, CONFIG_DIR_NAME);

        const configExists = await invoke<boolean>('safe_dir_exists', { path: configPath });
        if (!configExists) {
            try {
                await invoke<void>('safe_create_dir', { path: configPath });
            } catch (error) {
                console.error('Failed to create config directory:', error);
                throw new Error('Could not initialize vault configuration.');
            }
        }
    }

    private withSeedFrontmatter(seedKey: string, seedLanguage: SeedLanguage, content: string): string {
        const normalized = content.replace(/\r\n/g, '\n').trimStart();
        return [
            '---',
            'slash_seed: user-guide',
            `slash_seed_key: ${seedKey}`,
            `slash_seed_lang: ${seedLanguage}`,
            '---',
            '',
            normalized,
        ].join('\n');
    }

    private async seedDesktopUserGuides(vaultPath: string): Promise<void> {
        const { join, dirname } = await import('@tauri-apps/api/path');

        await invoke<string[]>('ensure_para_structure', { vaultPath });
        const seedLanguage = getDesktopGuideSeedLanguage();
        const guides = DESKTOP_USER_GUIDES_BY_LANGUAGE[seedLanguage];

        for (const guide of guides) {
            const targetPath = await join(vaultPath, guide.path);

            if (await exists(targetPath)) {
                continue;
            }

            const parentPath = await dirname(targetPath);
            await mkdir(parentPath, { recursive: true });
            await writeTextFile(targetPath, this.withSeedFrontmatter(guide.seedKey, seedLanguage, guide.content));
        }
    }
}

export const vaultService = new TauriVaultService();
