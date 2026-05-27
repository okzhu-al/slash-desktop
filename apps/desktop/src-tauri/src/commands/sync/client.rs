//! SyncClient — HTTP 客户端封装
//!
//! 统一封装与 Server 的 HTTP 交互：negotiate / push / pull / health / team-scope
//! 消除 sync_vault / push_directory_to_vault / sync_team_full 三处重复的 HTTP 模板代码

use slash_sync_proto::{
    SyncNegotiateRequest, SyncNegotiateResponse, SyncPullRequest, SyncPullResponse,
    SyncPushRequest, SyncPushResponse,
};

/// 封装与 Slash Server 的 HTTP 同步交互
pub struct SyncClient {
    client: reqwest::Client,
    base_url: String,
    access_token: String,
}

impl SyncClient {
    /// 创建 SyncClient（默认无超时）
    pub fn new(server_url: &str, access_token: &str) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: server_url.trim_end_matches('/').to_string(),
            access_token: access_token.to_string(),
        }
    }

    /// 创建带超时的 SyncClient（用于 Promote 等场景）
    pub fn with_timeout(
        server_url: &str,
        access_token: &str,
        timeout_secs: u64,
    ) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .build()
            .map_err(|e| format!("Client build failed: {e}"))?;
        Ok(Self {
            client,
            base_url: server_url.trim_end_matches('/').to_string(),
            access_token: access_token.to_string(),
        })
    }

    /// 差异协商
    pub async fn negotiate(
        &self,
        req: &SyncNegotiateRequest,
    ) -> Result<SyncNegotiateResponse, String> {
        let resp = self
            .client
            .post(format!("{}/api/sync/negotiate", self.base_url))
            .header("Authorization", format!("Bearer {}", self.access_token))
            .json(req)
            .send()
            .await
            .map_err(|e| format!("Negotiate failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Negotiate HTTP {status}: {body}"));
        }

        resp.json()
            .await
            .map_err(|e| format!("Negotiate parse failed: {e}"))
    }

    /// 差异协商（返回原始 body 用于诊断日志）
    pub async fn negotiate_with_raw(
        &self,
        req: &SyncNegotiateRequest,
    ) -> Result<(SyncNegotiateResponse, String), String> {
        let resp = self
            .client
            .post(format!("{}/api/sync/negotiate", self.base_url))
            .header("Authorization", format!("Bearer {}", self.access_token))
            .json(req)
            .send()
            .await
            .map_err(|e| format!("Negotiate failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Negotiate HTTP {status}: {body}"));
        }

        let body = resp
            .text()
            .await
            .map_err(|e| format!("Read negotiate body failed: {e}"))?;
        let parsed: SyncNegotiateResponse =
            serde_json::from_str(&body).map_err(|e| format!("Negotiate parse failed: {e}"))?;
        Ok((parsed, body))
    }

    /// 推送文件
    pub async fn push(&self, req: &SyncPushRequest) -> Result<SyncPushResponse, String> {
        let resp = self
            .client
            .post(format!("{}/api/sync/push", self.base_url))
            .header("Authorization", format!("Bearer {}", self.access_token))
            .json(req)
            .send()
            .await
            .map_err(|e| format!("Push failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Push HTTP {status}: {body}"));
        }

        resp.json()
            .await
            .map_err(|e| format!("Push parse failed: {e}"))
    }

    /// 拉取文件
    pub async fn pull(&self, req: &SyncPullRequest) -> Result<SyncPullResponse, String> {
        let resp = self
            .client
            .post(format!("{}/api/sync/pull", self.base_url))
            .header("Authorization", format!("Bearer {}", self.access_token))
            .json(req)
            .send()
            .await
            .map_err(|e| format!("Pull failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Pull HTTP {status}: {body}"));
        }

        resp.json()
            .await
            .map_err(|e| format!("Pull parse failed: {e}"))
    }

    /// 健康检查
    pub async fn check_health(&self) -> Result<bool, String> {
        match self
            .client
            .get(format!("{}/api/health", self.base_url))
            .send()
            .await
        {
            Ok(resp) => Ok(resp.status().is_success()),
            Err(_) => Ok(false),
        }
    }

    /// 查询团队 scope
    pub async fn get_team_scope(
        &self,
        vault_id: Option<&str>,
    ) -> Result<slash_sync_proto::TeamScopeResponse, String> {
        let mut url = format!("{}/api/team/my-scope", self.base_url);
        if let Some(vid) = vault_id {
            url = format!("{url}?vault_id={vid}");
        }

        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.access_token))
            .send()
            .await
            .map_err(|e| format!("TeamSync my-scope request failed: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("TeamSync my-scope HTTP {}", resp.status()));
        }

        resp.json()
            .await
            .map_err(|e| format!("TeamSync my-scope parse failed: {e}"))
    }

    /// 获取内部 reqwest::Client 引用（兼容过渡期使用）
    #[allow(dead_code)]
    pub fn inner(&self) -> &reqwest::Client {
        &self.client
    }

    /// 获取 base_url
    #[allow(dead_code)]
    pub fn base_url(&self) -> &str {
        &self.base_url
    }
}
