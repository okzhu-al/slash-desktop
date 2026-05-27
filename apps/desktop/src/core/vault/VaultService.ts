import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

const STORAGE_KEY_VAULTS = 'slash-vaults-history';
const CONFIG_DIR_NAME = '.slash';

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
}

export const vaultService = new TauriVaultService();
