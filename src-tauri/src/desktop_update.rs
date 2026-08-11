use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use rsa::pkcs8::DecodePublicKey;
use rsa::traits::PublicKeyParts;
use rsa::{Oaep, RsaPublicKey};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const APP_KEY: &str = "termexa";
const CHANNEL: &str = "stable";
#[cfg(test)]
const PROBE_PATH: &str = "/api/desktop-probe/termexa";
const PROBE_URL: &str = "https://update-task.bowsu.com/api/desktop-probe/termexa";
const PROBE_AAD: &str = "encrypted-api-envelope:v1\nPOST\n/api/desktop-probe/termexa\ntermexa";
const PROBE_KEY_ID: &str = "desktop-probe-2026-07";
const PROBE_PUBLIC_KEY_DER_BASE64: &str = "MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAx5JzQzKEeSgAvW1x/XEN6kDvhoALG9CMiFHX4aN4z+woqQ8LkVaTuC/S4ENbeUb5+mESY5wFNiHOAP6M6chYQTID1cPC3J/v9IXDdOQxFgcJI1LlbrhXnnlSPiJh96lRQAoXL/Po3batskeTbvY4zg/QEXK3ENRfxfMCaoBmtkLxf9wApKTvi9b/eVykI+Cjl2UFBLuSn8gPm0IlyOs4jSf+rJjXutoKnKUbFj3N5NiKriC/rMg1fWmsbfKU7l+M+izcvicOJqduIPjaQXWq1q7oNoUEBQfYIs5ZirkWOiN/GA1LLYLutz1NXOy75mabg29zQN815rkXM4C98BBBksAazRNFwc+GICRq/3uqEIWnVhMEQp9GsNGCRQRXK8wY1NOc8IBaQOOoh1mbFy7aYSD0Ns9ungMBjRaPLAllHHPhfnFduld6ynVIItAGq5hJGvUER0pkZfVaNoqIAfpfafDdbBYw1yZG1Y4Yi+dzd0xeJIIcYgvUmJttycaPhmRrAgMBAAE=";
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProbeInput {
    event: String,
    status: String,
    target_version: Option<String>,
    error_code: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopProbePayload {
    app_key: &'static str,
    install_id: String,
    app_version: String,
    target_version: Option<String>,
    channel: &'static str,
    device_name: String,
    username: String,
    os: String,
    os_version: String,
    arch: String,
    locale: String,
    event: String,
    status: String,
    error_code: Option<String>,
    timestamp: u128,
    nonce: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedProbeEnvelope {
    version: u8,
    kid: String,
    encrypted_key: String,
    iv: String,
    ciphertext: String,
}

fn sanitize(value: impl AsRef<str>, max_chars: usize) -> String {
    value
        .as_ref()
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string()
}

fn validate_input(input: &DesktopProbeInput) -> Result<(), &'static str> {
    const EVENTS: &[&str] = &[
        "startup",
        "update_check",
        "update_available",
        "update_up_to_date",
        "update_install",
        "update_error",
    ];
    const STATUSES: &[&str] = &["started", "succeeded", "failed"];
    const ERRORS: &[&str] = &["configuration", "network", "signature", "generic"];
    if !EVENTS.contains(&input.event.as_str()) || !STATUSES.contains(&input.status.as_str()) {
        return Err("invalid desktop probe event");
    }
    if input
        .error_code
        .as_deref()
        .is_some_and(|value| !ERRORS.contains(&value))
    {
        return Err("invalid desktop probe error code");
    }
    if input
        .target_version
        .as_deref()
        .is_some_and(|value| value.len() > 64 || value.chars().any(char::is_control))
    {
        return Err("invalid desktop probe target version");
    }
    Ok(())
}

fn read_valid_install_id(path: &Path) -> Option<String> {
    let value = fs::read_to_string(path).ok()?;
    let parsed = Uuid::parse_str(value.trim()).ok()?;
    Some(parsed.to_string())
}

fn persist_stable_install_id(directory: &Path) -> Result<String, String> {
    fs::create_dir_all(&directory).map_err(|_| "desktop identity unavailable".to_string())?;
    let path = directory.join("install-id");
    if let Some(value) = read_valid_install_id(&path) {
        return Ok(value);
    }

    if path.exists() {
        fs::remove_file(&path).map_err(|_| "desktop identity unavailable".to_string())?;
    }

    let value = Uuid::new_v4().to_string();
    let temporary = directory.join(format!("install-id.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, value.as_bytes())
        .map_err(|_| "desktop identity unavailable".to_string())?;
    match fs::rename(&temporary, &path) {
        Ok(()) => Ok(value),
        Err(_) => {
            let _ = fs::remove_file(&temporary);
            read_valid_install_id(&path).ok_or_else(|| "desktop identity unavailable".to_string())
        }
    }
}

fn stable_install_id(app: &AppHandle) -> Result<String, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "desktop identity unavailable".to_string())?;
    persist_stable_install_id(&directory)
}

fn encrypt_payload(
    public_key_der_base64: &str,
    kid: &str,
    plaintext: &[u8],
) -> Result<EncryptedProbeEnvelope, String> {
    let public_key_der = BASE64
        .decode(public_key_der_base64.trim())
        .map_err(|_| "desktop probe configuration invalid".to_string())?;
    let public_key = RsaPublicKey::from_public_key_der(&public_key_der)
        .map_err(|_| "desktop probe configuration invalid".to_string())?;
    if public_key.size() < 384 {
        return Err("desktop probe configuration invalid".to_string());
    }

    let mut aes_key = [0u8; 32];
    let mut iv = [0u8; 12];
    OsRng.fill_bytes(&mut aes_key);
    OsRng.fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new_from_slice(&aes_key)
        .map_err(|_| "desktop probe encryption failed".to_string())?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: plaintext,
                aad: PROBE_AAD.as_bytes(),
            },
        )
        .map_err(|_| "desktop probe encryption failed".to_string())?;
    let encrypted_key = public_key
        .encrypt(&mut OsRng, Oaep::new::<Sha256>(), &aes_key)
        .map_err(|_| "desktop probe encryption failed".to_string())?;

    Ok(EncryptedProbeEnvelope {
        version: 1,
        kid: kid.to_string(),
        encrypted_key: BASE64.encode(encrypted_key),
        iv: BASE64.encode(iv),
        ciphertext: BASE64.encode(ciphertext),
    })
}

#[tauri::command]
pub async fn desktop_probe_report(
    app: AppHandle,
    input: DesktopProbeInput,
) -> Result<bool, String> {
    validate_input(&input).map_err(str::to_string)?;
    let install_id = stable_install_id(&app)?;

    let os = os_info::get();
    let payload = DesktopProbePayload {
        app_key: APP_KEY,
        install_id,
        app_version: app.package_info().version.to_string(),
        target_version: input.target_version.map(|value| sanitize(value, 64)),
        channel: CHANNEL,
        device_name: sanitize(hostname::get().unwrap_or_default().to_string_lossy(), 128),
        username: sanitize(std::env::var("USERNAME").unwrap_or_default(), 128),
        os: sanitize(std::env::consts::OS, 64),
        os_version: sanitize(os.version().to_string(), 128),
        arch: sanitize(std::env::consts::ARCH, 64),
        locale: sanitize(sys_locale::get_locale().unwrap_or_default(), 32),
        event: input.event,
        status: input.status,
        error_code: input.error_code,
        timestamp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "desktop probe clock unavailable".to_string())?
            .as_millis(),
        nonce: Uuid::new_v4().to_string(),
    };
    let plaintext = serde_json::to_vec(&payload)
        .map_err(|_| "desktop probe serialization failed".to_string())?;
    let envelope = encrypt_payload(PROBE_PUBLIC_KEY_DER_BASE64, PROBE_KEY_ID, &plaintext)?;
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|_| "desktop probe unavailable".to_string())?;
    let response = client
        .post(PROBE_URL)
        .json(&envelope)
        .send()
        .await
        .map_err(|_| "desktop probe unavailable".to_string())?;
    if !response.status().is_success() {
        return Err("desktop probe rejected".to_string());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::Aead;
    use rsa::pkcs8::EncodePublicKey;
    use rsa::RsaPrivateKey;

    #[test]
    fn aad_matches_the_service_contract() {
        assert_eq!(
            PROBE_AAD,
            format!("encrypted-api-envelope:v1\nPOST\n{PROBE_PATH}\n{APP_KEY}")
        );
    }

    #[test]
    fn configured_probe_key_is_rsa_3072_and_has_a_kid() {
        let public_key_der = BASE64
            .decode(PROBE_PUBLIC_KEY_DER_BASE64)
            .expect("decode configured probe public key");
        let public_key = RsaPublicKey::from_public_key_der(&public_key_der)
            .expect("parse configured probe public key");
        assert_eq!(public_key.size(), 384);
        assert!(!PROBE_KEY_ID.trim().is_empty());
        assert_eq!(PROBE_TIMEOUT, Duration::from_secs(15));
    }

    #[test]
    fn probe_input_rejects_unknown_values() {
        let invalid = DesktopProbeInput {
            event: "arbitrary".to_string(),
            status: "succeeded".to_string(),
            target_version: None,
            error_code: None,
        };
        assert!(validate_input(&invalid).is_err());

        let invalid_error = DesktopProbeInput {
            event: "update_error".to_string(),
            status: "failed".to_string(),
            target_version: None,
            error_code: Some("C:\\secret".to_string()),
        };
        assert!(validate_input(&invalid_error).is_err());
    }

    #[test]
    fn encrypted_probe_round_trips_and_rejects_changed_aad() {
        let private_key = RsaPrivateKey::new(&mut OsRng, 3072).expect("generate test key");
        let public_key = RsaPublicKey::from(&private_key);
        let public_der = public_key.to_public_key_der().expect("encode public key");
        let plaintext = br#"{"event":"startup","status":"succeeded"}"#;
        let envelope =
            encrypt_payload(&BASE64.encode(public_der.as_bytes()), "test-kid", plaintext)
                .expect("encrypt probe");

        let encrypted_key = BASE64.decode(envelope.encrypted_key).expect("decode key");
        let aes_key = private_key
            .decrypt(Oaep::new::<Sha256>(), &encrypted_key)
            .expect("decrypt key");
        let iv = BASE64.decode(envelope.iv).expect("decode iv");
        let ciphertext = BASE64
            .decode(envelope.ciphertext)
            .expect("decode ciphertext");
        let cipher = Aes256Gcm::new_from_slice(&aes_key).expect("create cipher");
        let decrypted = cipher
            .decrypt(
                Nonce::from_slice(&iv),
                Payload {
                    msg: &ciphertext,
                    aad: PROBE_AAD.as_bytes(),
                },
            )
            .expect("decrypt payload");
        assert_eq!(decrypted, plaintext);

        assert!(cipher
            .decrypt(
                Nonce::from_slice(&iv),
                Payload {
                    msg: &ciphertext,
                    aad: b"encrypted-api-envelope:v1\nPOST\n/changed\ntermexa",
                },
            )
            .is_err());
    }

    #[test]
    fn install_id_is_stable_and_recovers_from_corrupt_storage() {
        let directory =
            std::env::temp_dir().join(format!("termexa-install-id-test-{}", Uuid::new_v4()));
        let first = persist_stable_install_id(&directory).expect("create install id");
        assert_eq!(
            persist_stable_install_id(&directory).expect("reuse install id"),
            first
        );

        fs::write(directory.join("install-id"), "corrupt").expect("corrupt install id");
        let recovered = persist_stable_install_id(&directory).expect("recover install id");
        assert_ne!(recovered, first);
        assert_eq!(
            Uuid::parse_str(&recovered).expect("valid uuid").to_string(),
            recovered
        );

        fs::remove_dir_all(directory).expect("remove test directory");
    }
}
