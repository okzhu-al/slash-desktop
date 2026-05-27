use tokio::sync::{mpsc, oneshot};
use tauri::{AppHandle, Emitter};

use crate::commands::ai::orchestrator::{RenameResult, SkillResult};
use crate::commands::ai::classification::ClassificationResult;

#[derive(Clone, serde::Serialize)]
pub struct AiJobStatusPayload {
    pub note_path: String,
    pub skill: String,
    pub status: String,
    pub message: Option<String>,
}

/// A job to be processed by the fast queue (e.g., local embedding)
pub struct FastJob {
    pub note_path: String,
    pub content: String,
    pub hash: String,
    pub trigger_type: String,
}

/// A job to be processed by the heavy queue (e.g., summarizing, tagging via LLM)
pub enum HeavyJob {
    Summarize {
        note_path: String,
        content: String,
        hash: String,
        responder: oneshot::Sender<Result<SkillResult, String>>,
    },
    Tagging {
        note_path: String,
        content: String,
        hash: String,
        responder: oneshot::Sender<Result<SkillResult, String>>,
    },
    SmartRename {
        note_path: String,
        content: String,
        hash: String,
        responder: oneshot::Sender<Result<RenameResult, String>>,
    },
    GhostLinkReason {
        source_path: String,
        target_path: String,
        candidate_summary: String, // Stringified target candidate summary
        source_mtime: i64,
        target_mtime: i64,
        source_title: String,
        source_summary: String,
        provider_key: String,
    },
    Classification {
        note_path: String,
        content_hash: String,
        responder: oneshot::Sender<Result<ClassificationResult, String>>,
    },
    WikiLinkRelation {
        source_path: String,
        target_path: String,
    },
}

#[derive(Clone)]
pub struct AIQueueManager {
    fast_tx: mpsc::Sender<FastJob>,
    heavy_tx: mpsc::Sender<HeavyJob>,
    app_handle: AppHandle,
}

impl AIQueueManager {
    /// Initialize the queue manager with workers spawned into the provided tokio runtime
    pub fn new(
        runtime: std::sync::Arc<tokio::runtime::Runtime>,
        app_handle: AppHandle,
    ) -> Self {
        // Fast queue for embeddings
        let (fast_tx, mut fast_rx) = mpsc::channel::<FastJob>(100);
        
        // Heavy queue for LLM requests
        let (heavy_tx, mut heavy_rx) = mpsc::channel::<HeavyJob>(20);

        let app_clone1 = app_handle.clone();
        let runtime_clone1 = runtime.clone();
        
        // 🚀 Fast Queue Worker Loop (Native Thread)
        std::thread::spawn(move || {
            while let Some(job) = fast_rx.blocking_recv() {
                let _ = app_clone1.emit("ai:job-status", AiJobStatusPayload {
                    note_path: job.note_path.clone(),
                    skill: "embedding".to_string(),
                    status: "processing".to_string(),
                    message: None,
                });
                
                runtime_clone1.block_on(async {
                    let _ = crate::commands::ai::orchestrator::process_fast_job(
                        app_clone1.clone(), 
                        job.trigger_type, 
                        job.note_path.clone(), 
                        job.content, 
                        job.hash
                    ).await;
                });
                
                let _ = app_clone1.emit("ai:job-status", AiJobStatusPayload {
                    note_path: job.note_path.clone(),
                    skill: "embedding".to_string(),
                    status: "success".to_string(),
                    message: None,
                });
            }
        });

        let app_clone2 = app_handle.clone();
        let runtime_clone2 = runtime.clone();
        
        // 🐢 Heavy Queue Worker Loop (Native Thread)
        std::thread::spawn(move || {
            while let Some(job) = heavy_rx.blocking_recv() {
                let (path, skill) = match &job {
                    HeavyJob::Summarize { note_path, .. } => (note_path.clone(), "summarization"),
                    HeavyJob::Tagging { note_path, .. } => (note_path.clone(), "tagging"),
                    HeavyJob::SmartRename { note_path, .. } => (note_path.clone(), "smart_rename"),
                    HeavyJob::GhostLinkReason { target_path, .. } => (target_path.clone(), "ghost_links"),
                    HeavyJob::Classification { note_path, .. } => (note_path.clone(), "classification"),
                    HeavyJob::WikiLinkRelation { source_path, .. } => (source_path.clone(), "wikilink_relation"),
                };
                let _ = app_clone2.emit("ai:job-status", AiJobStatusPayload {
                    note_path: path.clone(),
                    skill: skill.to_string(),
                    status: "processing".to_string(),
                    message: None,
                });

                runtime_clone2.block_on(async {
                    let (res_status, res_msg) = match job {
                        HeavyJob::Summarize { note_path, content, hash, responder } => {
                            let res = crate::commands::ai::orchestrator::process_heavy_summary(
                                app_clone2.clone(), note_path, content, hash
                            ).await;
                            let status = if res.is_ok() { "success" } else { "failed" }.to_string();
                            let msg = res.as_ref().err().cloned();
                            let _ = responder.send(res);
                            (status, msg)
                        }
                        HeavyJob::Tagging { note_path, content, hash, responder } => {
                            let res = crate::commands::ai::orchestrator::process_heavy_tagging(
                                app_clone2.clone(), note_path, content, hash
                            ).await;
                            let status = if res.is_ok() { "success" } else { "failed" }.to_string();
                            let msg = res.as_ref().err().cloned();
                            let _ = responder.send(res);
                            (status, msg)
                        }
                        HeavyJob::SmartRename { note_path, content, hash, responder } => {
                            let res = crate::commands::ai::orchestrator::process_heavy_rename(
                                app_clone2.clone(), note_path, content, hash
                            ).await;
                            let status = if res.is_ok() { "success" } else { "failed" }.to_string();
                            let msg = res.as_ref().err().cloned();
                            let _ = responder.send(res);
                            (status, msg)
                        }
                        HeavyJob::GhostLinkReason {
                            source_path, target_path, candidate_summary,
                            source_mtime, target_mtime, source_title, source_summary, provider_key
                        } => {
                            // Forward to the refactored ghostlink function
                            crate::commands::ai::ghostlink::process_heavy_ghostlink_reason(
                                app_clone2.clone(), source_path, target_path.clone(), candidate_summary,
                                source_mtime, target_mtime, source_title, source_summary, provider_key
                            ).await;
                            ("success".to_string(), None)
                        }
                        HeavyJob::Classification { note_path, content_hash, responder } => {
                            let res = crate::commands::ai::classification::process_heavy_classification(
                                app_clone2.clone(), note_path, content_hash
                            ).await;
                            let status = if res.is_ok() { "success" } else { "failed" }.to_string();
                            let msg = res.as_ref().err().cloned();
                            let _ = responder.send(res);
                            (status, msg)
                        }
                        HeavyJob::WikiLinkRelation { source_path, target_path } => {
                            crate::commands::ai::wikilink_relation::process_heavy_wikilink_relation(
                                app_clone2.clone(), source_path, target_path
                            ).await;
                            ("success".to_string(), None)
                        }
                    };
                    
                    let _ = app_clone2.emit("ai:job-status", AiJobStatusPayload {
                        note_path: path,
                        skill: skill.to_string(),
                        status: res_status,
                        message: res_msg,
                    });
                });
            }
        });

        Self {
            fast_tx,
            heavy_tx,
            app_handle,
        }
    }

    pub async fn submit_fast(&self, job: FastJob) -> Result<(), String> {
        let payload = AiJobStatusPayload {
            note_path: job.note_path.clone(),
            skill: "embedding".to_string(),
            status: "queued".to_string(),
            message: None,
        };
        let _ = self.app_handle.emit("ai:job-status", payload);
        self.fast_tx.send(job).await.map_err(|e| format!("Failed to submit fast job: {}", e))
    }

    pub async fn submit_heavy(&self, job: HeavyJob) -> Result<(), String> {
        let (path, skill) = match &job {
            HeavyJob::Summarize { note_path, .. } => (note_path.clone(), "summarization"),
            HeavyJob::Tagging { note_path, .. } => (note_path.clone(), "tagging"),
            HeavyJob::SmartRename { note_path, .. } => (note_path.clone(), "smart_rename"),
            HeavyJob::GhostLinkReason { target_path, .. } => (target_path.clone(), "ghost_links"),
            HeavyJob::Classification { note_path, .. } => (note_path.clone(), "classification"),
            HeavyJob::WikiLinkRelation { source_path, .. } => (source_path.clone(), "wikilink_relation"),
        };
        let payload = AiJobStatusPayload {
            note_path: path,
            skill: skill.to_string(),
            status: "queued".to_string(),
            message: None,
        };
        let _ = self.app_handle.emit("ai:job-status", payload);
        self.heavy_tx.send(job).await.map_err(|e| format!("Failed to submit heavy job: {}", e))
    }
}
