//! AI Provider 抽象：Anthropic / OpenAI 兼容 / Ollama，统一流式输出。

use crate::store::AiProviderConfig;
use crate::vault;
use anyhow::{anyhow, Context};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::ipc::Channel;

#[derive(Clone, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiEvent {
    Delta { text: String },
    Done,
    Error { message: String },
}

pub async fn chat_stream(
    cfg: AiProviderConfig,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    on_event: Channel<AiEvent>,
) {
    let result = match cfg.kind.as_str() {
        "anthropic" => anthropic(&cfg, system, messages, &on_event).await,
        "openai" => {
            let url = format!(
                "{}/v1/chat/completions",
                base(&cfg, "https://api.openai.com")
            );
            openai_compat(&cfg, url, system, messages, &on_event).await
        }
        // DeepSeek 走 OpenAI 兼容协议，但端点不带 /v1 前缀
        "deepseek" => {
            let url = format!(
                "{}/chat/completions",
                base(&cfg, "https://api.deepseek.com")
            );
            openai_compat(&cfg, url, system, messages, &on_event).await
        }
        "ollama" => ollama(&cfg, system, messages, &on_event).await,
        other => Err(anyhow!("未知的 Provider 类型: {other}")),
    };
    match result {
        Ok(()) => {
            let _ = on_event.send(AiEvent::Done);
        }
        Err(e) => {
            let _ = on_event.send(AiEvent::Error {
                message: format!("{e:#}"),
            });
        }
    }
}

fn api_key(cfg: &AiProviderConfig) -> anyhow::Result<String> {
    let enc = cfg
        .api_key_enc
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("该 Provider 未配置 API Key"))?;
    vault::decrypt(enc)
}

fn base(cfg: &AiProviderConfig, default: &str) -> String {
    let b = cfg.base_url.trim().trim_end_matches('/');
    if b.is_empty() {
        default.to_string()
    } else {
        b.to_string()
    }
}

/// 逐行消费一个 HTTP 字节流（SSE 与 NDJSON 都是按行分帧）。
async fn for_each_line(
    resp: reqwest::Response,
    mut on_line: impl FnMut(&str) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("读取响应流失败")?;
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim();
            if !line.is_empty() {
                on_line(line)?;
            }
        }
    }
    Ok(())
}

async fn check_status(resp: reqwest::Response) -> anyhow::Result<reqwest::Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    Err(anyhow!("API 返回 {status}: {body}"))
}

async fn anthropic(
    cfg: &AiProviderConfig,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    on_event: &Channel<AiEvent>,
) -> anyhow::Result<()> {
    let mut body = json!({
        "model": cfg.model,
        "max_tokens": 4096,
        "messages": messages,
        "stream": true,
    });
    if let Some(sys) = system {
        body["system"] = json!(sys);
    }
    let resp = reqwest::Client::new()
        .post(format!(
            "{}/v1/messages",
            base(cfg, "https://api.anthropic.com")
        ))
        .header("x-api-key", api_key(cfg)?)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .context("请求 Anthropic API 失败")?;
    let resp = check_status(resp).await?;

    for_each_line(resp, |line| {
        if let Some(data) = line.strip_prefix("data:") {
            let v: serde_json::Value = match serde_json::from_str(data.trim()) {
                Ok(v) => v,
                Err(_) => return Ok(()),
            };
            if v["type"] == "content_block_delta" {
                if let Some(text) = v["delta"]["text"].as_str() {
                    let _ = on_event.send(AiEvent::Delta {
                        text: text.to_string(),
                    });
                }
            }
        }
        Ok(())
    })
    .await
}

/// OpenAI 兼容协议（OpenAI / DeepSeek / 各类中转网关通用）
async fn openai_compat(
    cfg: &AiProviderConfig,
    url: String,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    on_event: &Channel<AiEvent>,
) -> anyhow::Result<()> {
    let mut all = Vec::new();
    if let Some(sys) = system {
        all.push(ChatMessage {
            role: "system".into(),
            content: sys,
        });
    }
    all.extend(messages);

    let resp = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key(cfg)?)
        .json(&json!({ "model": cfg.model, "messages": all, "stream": true }))
        .send()
        .await
        .context("请求 OpenAI 兼容 API 失败")?;
    let resp = check_status(resp).await?;

    for_each_line(resp, |line| {
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if data == "[DONE]" {
                return Ok(());
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(text) = v["choices"][0]["delta"]["content"].as_str() {
                    let _ = on_event.send(AiEvent::Delta {
                        text: text.to_string(),
                    });
                }
            }
        }
        Ok(())
    })
    .await
}

async fn ollama(
    cfg: &AiProviderConfig,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    on_event: &Channel<AiEvent>,
) -> anyhow::Result<()> {
    let mut all = Vec::new();
    if let Some(sys) = system {
        all.push(ChatMessage {
            role: "system".into(),
            content: sys,
        });
    }
    all.extend(messages);

    let resp = reqwest::Client::new()
        .post(format!("{}/api/chat", base(cfg, "http://localhost:11434")))
        .json(&json!({ "model": cfg.model, "messages": all, "stream": true }))
        .send()
        .await
        .context("请求 Ollama 失败（本地服务是否已启动？）")?;
    let resp = check_status(resp).await?;

    for_each_line(resp, |line| {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(text) = v["message"]["content"].as_str() {
                let _ = on_event.send(AiEvent::Delta {
                    text: text.to_string(),
                });
            }
        }
        Ok(())
    })
    .await
}
