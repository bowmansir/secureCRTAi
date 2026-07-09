//! 配置导入导出：用用户口令派生密钥（PBKDF2-SHA256）加密整个配置包，
//! 与机器无关，可在多台电脑间迁移。导入时敏感字段重新用本机保管库加密。

use crate::store::{AiProviderConfig, SessionProfile, Store};
use crate::vault;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, Context};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const PBKDF2_ITERS: u32 = 200_000;
const MAGIC: &str = "termai-export";

#[derive(Serialize, Deserialize)]
struct ExportFile {
    magic: String,
    version: u32,
    salt: String,
    nonce: String,
    data: String,
}

/// 解密后的明文负载：敏感字段为明文，仅存在于内存与加密文件内
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    sessions: Vec<PlainSession>,
    providers: Vec<PlainProvider>,
    active_provider: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlainSession {
    id: String,
    name: String,
    group: String,
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    key_path: Option<String>,
    key_passphrase: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlainProvider {
    id: String,
    name: String,
    kind: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
}

fn derive_key(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, PBKDF2_ITERS, &mut key);
    key
}

fn decrypt_opt(enc: &Option<String>) -> anyhow::Result<Option<String>> {
    match enc {
        Some(e) if !e.is_empty() => Ok(Some(vault::decrypt(e)?)),
        _ => Ok(None),
    }
}

fn encrypt_opt(plain: &Option<String>) -> anyhow::Result<Option<String>> {
    match plain {
        Some(p) if !p.is_empty() => Ok(Some(vault::encrypt(p)?)),
        _ => Ok(None),
    }
}

pub fn export(store: &Store, path: &str, passphrase: &str) -> anyhow::Result<()> {
    if passphrase.len() < 6 {
        return Err(anyhow!("口令至少 6 位"));
    }
    let sessions = store
        .sessions()
        .into_iter()
        .map(|s| {
            Ok(PlainSession {
                password: decrypt_opt(&s.password_enc)?,
                key_passphrase: decrypt_opt(&s.key_passphrase_enc)?,
                id: s.id,
                name: s.name,
                group: s.group,
                host: s.host,
                port: s.port,
                username: s.username,
                auth_type: s.auth_type,
                key_path: s.key_path,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let (providers, active) = store.providers();
    let providers = providers
        .into_iter()
        .map(|p| {
            Ok(PlainProvider {
                api_key: decrypt_opt(&p.api_key_enc)?,
                id: p.id,
                name: p.name,
                kind: p.kind,
                base_url: p.base_url,
                model: p.model,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    let payload = serde_json::to_vec(&Payload {
        sessions,
        providers,
        active_provider: active,
    })?;

    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new((&derive_key(passphrase, &salt)).into());
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), payload.as_slice())
        .map_err(|e| anyhow!("加密失败: {e}"))?;

    let file = ExportFile {
        magic: MAGIC.to_string(),
        version: 1,
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        data: B64.encode(ct),
    };
    std::fs::write(path, serde_json::to_string_pretty(&file)?)
        .with_context(|| format!("写入导出文件失败: {path}"))?;
    Ok(())
}

/// 返回 (导入会话数, 导入 Provider 数)
pub fn import(store: &Store, path: &str, passphrase: &str) -> anyhow::Result<(usize, usize)> {
    let raw = std::fs::read_to_string(path).with_context(|| format!("读取文件失败: {path}"))?;
    let file: ExportFile = serde_json::from_str(&raw).context("不是有效的 TermAI 导出文件")?;
    if file.magic != MAGIC {
        return Err(anyhow!("不是有效的 TermAI 导出文件"));
    }
    let salt = B64.decode(&file.salt)?;
    let nonce = B64.decode(&file.nonce)?;
    let ct = B64.decode(&file.data)?;
    let cipher = Aes256Gcm::new((&derive_key(passphrase, &salt)).into());
    let plain = cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_slice())
        .map_err(|_| anyhow!("解密失败：口令错误或文件损坏"))?;
    let payload: Payload = serde_json::from_slice(&plain).context("导出文件内容损坏")?;

    let n_sessions = payload.sessions.len();
    for s in payload.sessions {
        store.upsert_session(SessionProfile {
            password_enc: encrypt_opt(&s.password)?,
            key_passphrase_enc: encrypt_opt(&s.key_passphrase)?,
            id: s.id,
            name: s.name,
            group: s.group,
            host: s.host,
            port: s.port,
            username: s.username,
            auth_type: s.auth_type,
            key_path: s.key_path,
        })?;
    }
    let n_providers = payload.providers.len();
    for p in payload.providers {
        store.upsert_provider(AiProviderConfig {
            api_key_enc: encrypt_opt(&p.api_key)?,
            id: p.id,
            name: p.name,
            kind: p.kind,
            base_url: p.base_url,
            model: p.model,
        })?;
    }
    if let Some(active) = payload.active_provider {
        let _ = store.set_active_provider(&active);
    }
    Ok((n_sessions, n_providers))
}
