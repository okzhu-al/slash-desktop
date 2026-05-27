use tauri::{State, command};
use crate::state::SessionStateWrapper;
use keyring::Entry;
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[allow(dead_code)]
#[derive(Serialize)]
pub struct AuthStatus {
    pub is_logged_in: bool,
    pub active_user_id: Option<String>,
}

fn sanitize_url(url: &str) -> String {
    url.replace("https://", "")
       .replace("http://", "")
       .replace("/", "_")
}

#[command]
pub fn secure_store_tokens(
    state: State<'_, SessionStateWrapper>,
    server_url: String,
    user_id: String,
    access_token: String,
    refresh_token: String,
) -> Result<(), String> {
    let service_name = format!("slash_session_{}", sanitize_url(&server_url));
    let entry = Entry::new(&service_name, &user_id)
        .map_err(|e| format!("Keyring init failed: {:?}", e))?;
    
    entry.set_password(&refresh_token)
        .map_err(|e| format!("Failed to save refresh token: {:?}", e))?;

    let mut store = state.0.lock().unwrap();
    store.active_user_id = Some(user_id);
    store.active_server_url = Some(server_url);
    store.cached_access_token = Some(access_token);
    
    Ok(())
}

#[command]
pub fn get_access_token(state: State<'_, SessionStateWrapper>) -> Option<String> {
    let store = state.0.lock().unwrap();
    store.cached_access_token.clone()
}

#[command]
pub async fn secure_logout(
    state: State<'_, SessionStateWrapper>,
    server_url: String,
    user_id: String,
) -> Result<(), String> {
    {
        let mut store = state.0.lock().unwrap();
        store.active_server_url = None;
        store.active_user_id = None;
        store.cached_access_token = None;
    }
    
    // We should notify the backend to invalidate the session!
    // But even if to-backend fails (e.g. offline), we MUST delete local keyring
    if !server_url.is_empty() && !user_id.is_empty() {
        let service_name = format!("slash_session_{}", sanitize_url(&server_url));
        if let Ok(entry) = Entry::new(&service_name, &user_id) {
            // Best effort backend call to delete device_session
            if let Ok(refresh_token) = entry.get_password() {
                let client = Client::new();
                let url = format!("{}/api/auth/logout", server_url.trim_end_matches('/'));
                let _ = client.post(&url)
                    .json(&serde_json::json!({ "refresh_token": refresh_token }))
                    .send()
                    .await;
            }
            // Ignore error if it doesn't exist
            let _ = entry.delete_credential();
        }
    }
    
    Ok(())
}

#[derive(Deserialize)]
struct RefreshResponse {
    access_token: String,
    refresh_token: String,
}

#[command]
pub async fn refresh_session(
    state: State<'_, SessionStateWrapper>,
    server_url: String,
    user_id: String,
) -> Result<String, String> {
    let refresh_token = {
        let service_name = format!("slash_session_{}", sanitize_url(&server_url));
        let entry = Entry::new(&service_name, &user_id)
            .map_err(|e| format!("Keyring init failed: {:?}", e))?;
        entry.get_password()
            .map_err(|_| "No refresh token found in Keyring".to_string())?
    };

    let client = Client::new();
    let url = format!("{}/api/auth/refresh", server_url.trim_end_matches('/'));
    
    let res = client.post(&url)
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !res.status().is_success() {
        return Err("Refresh token rejected or expired".into());
    }

    let refresh_data: RefreshResponse = res.json::<RefreshResponse>()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    // Store new refresh token in Keyring
    {
        let service_name = format!("slash_session_{}", sanitize_url(&server_url));
        let entry = Entry::new(&service_name, &user_id)
            .map_err(|e| format!("Keyring re-init failed: {:?}", e))?;
        entry.set_password(&refresh_data.refresh_token)
            .map_err(|e| format!("Failed to save new refresh token: {:?}", e))?;
    }

    // Update in-memory access token
    {
        let mut store = state.0.lock().unwrap();
        store.cached_access_token = Some(refresh_data.access_token.clone());
    }

    Ok(refresh_data.access_token)
}

#[command]
pub fn save_login_credential(server_url: String, username: String, password: String) -> Result<(), String> {
    let service = format!("slash_saved_pwd_{}", sanitize_url(&server_url));
    let entry = Entry::new(&service, &username)
        .map_err(|e| format!("Keyring init failed: {:?}", e))?;
    
    entry.set_password(&password)
        .map_err(|e| format!("Failed to save password: {:?}", e))?;
        
    Ok(())
}

#[command]
pub fn get_login_credential(server_url: String, username: String) -> Result<String, String> {
    let service = format!("slash_saved_pwd_{}", sanitize_url(&server_url));
    let entry = Entry::new(&service, &username)
        .map_err(|e| format!("Keyring init failed: {:?}", e))?;
        
    entry.get_password()
        .map_err(|_| "No saved password found".to_string())
}

#[command]
pub fn delete_login_credential(server_url: String, username: String) -> Result<(), String> {
    let service = format!("slash_saved_pwd_{}", sanitize_url(&server_url));
    if let Ok(entry) = Entry::new(&service, &username) {
        let _ = entry.delete_credential();
    }
    Ok(())
}
