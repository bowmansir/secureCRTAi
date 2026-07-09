//! SSH 密钥：生成 ed25519 密钥对并写入 ~/.ssh；一键把公钥部署到远端 authorized_keys。

use crate::hostkeys::HostKeyStore;
use crate::terminal::ssh::{connect_and_auth, exec_once, SshParams};
use anyhow::{anyhow, bail, Context};
use serde::Serialize;
use ssh_key::getrandom::SysRng;
use ssh_key::rand_core::UnwrapErr;
use ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey, PublicKey};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedKey {
    pub private_path: String,
    pub public_path: String,
    pub public_key: String,
    pub fingerprint: String,
}

/// 生成 ed25519 密钥对，写入 ~/.ssh/<name> 与 <name>.pub（不覆盖已有文件）。
pub fn generate(name: &str, comment: &str) -> anyhow::Result<GeneratedKey> {
    let name = validate_key_name(name)?;

    let home = dirs::home_dir().context("无法定位用户主目录")?;
    let ssh_dir = home.join(".ssh");

    let mut rng = UnwrapErr(SysRng);
    let mut key = PrivateKey::random(&mut rng, Algorithm::Ed25519)
        .map_err(|e| anyhow!("生成密钥失败: {e}"))?;
    let comment = comment.trim();
    if !comment.is_empty() {
        key.set_comment(comment);
    }

    write_key_pair_to_dir(&ssh_dir, &name, &key)
}

/// 导入 OpenSSH PEM 私钥，规范化写入 ~/.ssh/<name> 和对应 .pub。
pub fn import_openssh_private(
    name: &str,
    pem: &str,
    passphrase: Option<&str>,
) -> anyhow::Result<GeneratedKey> {
    let home = dirs::home_dir().context("无法定位用户主目录")?;
    import_openssh_private_to_dir(&home.join(".ssh"), name, pem, passphrase)
}

fn import_openssh_private_to_dir(
    ssh_dir: &Path,
    name: &str,
    pem: &str,
    passphrase: Option<&str>,
) -> anyhow::Result<GeneratedKey> {
    let name = validate_key_name(name)?;
    let pem = pem.trim();
    if pem.is_empty() {
        bail!("PEM 内容不能为空");
    }
    if pem.contains("-----BEGIN CERTIFICATE-----") {
        bail!("X.509 证书只包含公钥信息，不能生成私钥；请导入 OpenSSH 私钥 PEM");
    }
    if !pem.contains("-----BEGIN OPENSSH PRIVATE KEY-----") {
        bail!(
            "当前支持 OpenSSH 私钥 PEM（BEGIN OPENSSH PRIVATE KEY）；传统 RSA/PKCS8 PEM 后续再接入"
        );
    }

    let parsed = PrivateKey::from_openssh(pem.as_bytes())
        .map_err(|e| anyhow!("解析 OpenSSH PEM 私钥失败: {e}"))?;
    let key = if parsed.is_encrypted() {
        let passphrase = passphrase
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("该 PEM 私钥已加密，请输入 passphrase"))?;
        parsed
            .decrypt(passphrase)
            .map_err(|e| anyhow!("解密 PEM 私钥失败，请检查 passphrase: {e}"))?
    } else {
        parsed
    };

    write_key_pair_to_dir(ssh_dir, &name, &key)
}

fn validate_key_name(name: &str) -> anyhow::Result<String> {
    let name = name.trim();
    if name.is_empty() {
        bail!("密钥文件名不能为空");
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        bail!("密钥文件名不能包含路径分隔符或 ..");
    }
    Ok(name.to_string())
}

fn write_key_pair_to_dir(
    ssh_dir: &Path,
    name: &str,
    key: &PrivateKey,
) -> anyhow::Result<GeneratedKey> {
    std::fs::create_dir_all(ssh_dir).context("创建 ~/.ssh 目录失败")?;

    let priv_path = ssh_dir.join(name);
    let pub_path = ssh_dir.join(format!("{name}.pub"));
    if priv_path.exists() || pub_path.exists() {
        bail!("~/.ssh/{name} 已存在，请换一个名字");
    }

    let priv_pem = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| anyhow!("序列化私钥失败: {e}"))?;
    let pub_ossh = key
        .public_key()
        .to_openssh()
        .map_err(|e| anyhow!("序列化公钥失败: {e}"))?;
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();

    write_private_key_file(&priv_path, priv_pem.as_bytes())?;
    let pub_contents = format!("{pub_ossh}\n");
    if let Err(err) = write_public_key_file(&pub_path, &pub_contents) {
        let _ = std::fs::remove_file(&priv_path);
        return Err(err);
    }

    Ok(GeneratedKey {
        private_path: priv_path.to_string_lossy().to_string(),
        public_path: pub_path.to_string_lossy().to_string(),
        public_key: pub_ossh,
        fingerprint,
    })
}

fn write_private_key_file(path: &Path, contents: &[u8]) -> anyhow::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options.open(path).context("写入私钥失败")?;
    file.write_all(contents).context("写入私钥失败")
}

fn write_public_key_file(path: &Path, contents: &str) -> anyhow::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .context("写入公钥失败")?;
    file.write_all(contents.as_bytes()).context("写入公钥失败")
}

/// 把公钥幂等追加到远端 ~/.ssh/authorized_keys（去重、修正权限）。
pub async fn deploy(
    store: Arc<HostKeyStore>,
    params: SshParams,
    public_key: &str,
) -> anyhow::Result<String> {
    let pk = public_key.trim();
    if pk.is_empty() {
        bail!("公钥内容为空");
    }
    PublicKey::from_openssh(pk).map_err(|_| anyhow!("公钥格式不合法，请检查是否为 .pub 内容"))?;

    let handle = connect_and_auth(store, &params).await?;
    // 单引号包裹避免空格/特殊字符被 shell 拆分；对内部单引号做标准转义
    let escaped = pk.replace('\'', "'\\''");
    let script = format!(
        "set -e; mkdir -p ~/.ssh; chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys; \
         chmod 600 ~/.ssh/authorized_keys; \
         if grep -qF '{escaped}' ~/.ssh/authorized_keys; then echo TERMAI_EXISTS; \
         else echo '{escaped}' >> ~/.ssh/authorized_keys; echo TERMAI_ADDED; fi"
    );
    let (code, out) = exec_once(&handle, &script).await?;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;

    if code.unwrap_or(1) != 0 {
        bail!(
            "部署失败: {}",
            if out.is_empty() {
                "远端命令返回非零"
            } else {
                &out
            }
        );
    }
    Ok(if out.contains("TERMAI_EXISTS") {
        "公钥已存在于 authorized_keys，无需重复部署".to_string()
    } else {
        "公钥已成功部署到远端 authorized_keys".to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fresh_temp_ssh_dir(label: &str) -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "termai-key-import-{label}-{}-{now}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp ssh dir");
        dir
    }

    #[test]
    fn imports_openssh_private_and_writes_real_key_files() {
        let dir = fresh_temp_ssh_dir("ok");
        let mut rng = UnwrapErr(SysRng);
        let key = PrivateKey::random(&mut rng, Algorithm::Ed25519).expect("generate key");
        let pem = key
            .to_openssh(LineEnding::LF)
            .expect("serialize openssh private key");

        let generated =
            import_openssh_private_to_dir(&dir, "id_import_test", &pem, None).expect("import key");

        let private_path = Path::new(&generated.private_path);
        let public_path = Path::new(&generated.public_path);
        assert!(private_path.exists(), "private key should be written");
        assert!(public_path.exists(), "public key should be written");

        let written_private =
            std::fs::read_to_string(private_path).expect("read written private key");
        PrivateKey::from_openssh(written_private.as_bytes()).expect("parse written private key");

        let expected_public = key.public_key().to_openssh().expect("serialize public key");
        assert_eq!(generated.public_key, expected_public);
        assert_eq!(
            std::fs::read_to_string(public_path)
                .expect("read written public key")
                .trim(),
            expected_public
        );
        assert!(generated.fingerprint.starts_with("SHA256:"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_x509_certificates_without_private_key() {
        let dir = fresh_temp_ssh_dir("x509");
        let cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

        let err = import_openssh_private_to_dir(&dir, "id_bad", cert, None)
            .expect_err("x509 certificate should not import as a private key");

        assert!(format!("{err:#}").contains("X.509"));
        assert!(!dir.join("id_bad").exists());
        assert!(!dir.join("id_bad.pub").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
