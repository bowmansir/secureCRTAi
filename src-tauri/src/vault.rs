//! 凭据保管库：主密钥托管在 OS 凭据管理器（Windows Credential Manager 等），
//! 敏感字段用 AES-256-GCM 加密后才允许落盘。

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use anyhow::{anyhow, Context};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;

const SERVICE: &str = "com.termai.app";
const MASTER_KEY_USER: &str = "master-key";
const NONCE_LEN: usize = 12;

fn master_key() -> anyhow::Result<Key<Aes256Gcm>> {
    let entry = keyring::Entry::new(SERVICE, MASTER_KEY_USER).context("打开系统凭据管理器失败")?;
    let key_bytes: [u8; 32] = match entry.get_password() {
        Ok(b64) => B64
            .decode(b64)?
            .try_into()
            .map_err(|_| anyhow!("主密钥损坏"))?,
        Err(keyring::Error::NoEntry) => {
            let key = Aes256Gcm::generate_key(OsRng);
            entry
                .set_password(&B64.encode(key))
                .context("写入主密钥失败")?;
            key.into()
        }
        Err(e) => return Err(e).context("读取主密钥失败"),
    };
    Ok(key_bytes.into())
}

/// 加密明文，返回 base64(nonce || ciphertext)
pub fn encrypt(plain: &str) -> anyhow::Result<String> {
    let cipher = Aes256Gcm::new(&master_key()?);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, plain.as_bytes())
        .map_err(|e| anyhow!("加密失败: {e}"))?;
    let mut out = nonce.to_vec();
    out.extend(ct);
    Ok(B64.encode(out))
}

pub fn decrypt(encoded: &str) -> anyhow::Result<String> {
    let raw = B64.decode(encoded).context("密文格式错误")?;
    if raw.len() < NONCE_LEN {
        return Err(anyhow!("密文格式错误"));
    }
    let (nonce, ct) = raw.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(&master_key()?);
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| anyhow!("解密失败：主密钥不匹配"))?;
    Ok(String::from_utf8(plain)?)
}
