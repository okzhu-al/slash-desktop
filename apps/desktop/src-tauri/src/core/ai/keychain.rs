//! Keychain wrapper for secure API key storage
//!
//! 使用系统钥匙串（macOS Keychain / Windows Credential Manager / Linux Secret Service）
//! 安全存储 AI Provider 的 API Key，避免明文存储在 SQLite 中。

use keyring::Entry;

const SERVICE: &str = "com.slash.ai-provider";
const ACCOUNT: &str = "online_api_key";

/// 将 API Key 存入系统钥匙串
pub fn store_api_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        // 空 key 时删除已有条目
        return delete_api_key();
    }
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("Keychain entry error: {}", e))?;
    entry
        .set_password(key)
        .map_err(|e| format!("Keychain store error: {}", e))
}

/// 从系统钥匙串读取 API Key，不存在时返回 None
pub fn load_api_key() -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("Keychain entry error: {}", e))?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Keychain load error: {}", e)),
    }
}

/// 从系统钥匙串删除 API Key
pub fn delete_api_key() -> Result<(), String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("Keychain entry error: {}", e))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // 不存在也算成功
        Err(e) => Err(format!("Keychain delete error: {}", e)),
    }
}

// ============================================================================
// Per-Provider API Key Storage
// ============================================================================

/// 按 Provider ID 存储 API Key（e.g., provider_id = "qwen" → account = "online_api_key_qwen"）
pub fn store_api_key_for(provider_id: &str, key: &str) -> Result<(), String> {
    let account = format!("{}_{}", ACCOUNT, provider_id);
    if key.is_empty() {
        return delete_api_key_for(provider_id);
    }
    let entry =
        Entry::new(SERVICE, &account).map_err(|e| format!("Keychain entry error: {}", e))?;
    entry
        .set_password(key)
        .map_err(|e| format!("Keychain store error: {}", e))
}

/// 按 Provider ID 读取 API Key
pub fn load_api_key_for(provider_id: &str) -> Result<Option<String>, String> {
    let account = format!("{}_{}", ACCOUNT, provider_id);
    let entry =
        Entry::new(SERVICE, &account).map_err(|e| format!("Keychain entry error: {}", e))?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Keychain load error: {}", e)),
    }
}

/// 按 Provider ID 删除 API Key
pub fn delete_api_key_for(provider_id: &str) -> Result<(), String> {
    let account = format!("{}_{}", ACCOUNT, provider_id);
    let entry =
        Entry::new(SERVICE, &account).map_err(|e| format!("Keychain entry error: {}", e))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Keychain delete error: {}", e)),
    }
}
