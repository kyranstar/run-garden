//! Encrypted, machine-bound credential store.
//!
//! The COROS password and device signing key live ONLY on this Mac, in an
//! AES-256-GCM encrypted file under Application Support (0600), keyed to this
//! machine's hardware UUID. We deliberately do NOT use the OS Keychain: macOS
//! pins Keychain items to the exact code signature that created them, and this
//! app is unsigned, so every self-update produces a new signature that would be
//! locked out of the old items. The encrypted file is not tied to the signature,
//! so credentials survive updates. Nothing is written in plaintext, to logs,
//! argv, or environment variables; the file is unreadable if copied off this Mac.

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

/// Credential keys.
pub const K_COROS_EMAIL: &str = "coros_email";
pub const K_COROS_PASSWORD: &str = "coros_password";
pub const K_COROS_REGION: &str = "coros_region";
pub const K_DEVICE_ID: &str = "device_id";
pub const K_DEVICE_PRIVATE_KEY: &str = "device_private_key";
pub const K_CLOUD_URL: &str = "cloud_url";

fn store_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join("Library/Application Support/com.rungarden.desktop/creds.enc"))
}

/// Stable per-machine 32-byte key derived from the hardware UUID. Falls back to
/// a constant if ioreg is unavailable — still functional (0600 file perms remain
/// the primary protection), just without cross-machine binding.
fn machine_key() -> [u8; 32] {
    let id = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .find(|l| l.contains("IOPlatformUUID"))
                .and_then(|l| l.split('=').nth(1))
                .map(|v| v.trim().trim_matches('"').to_string())
        })
        .unwrap_or_else(|| "run-garden-default-machine".to_string());
    let mut hasher = Sha256::new();
    hasher.update(b"run-garden-creds-v1:");
    hasher.update(id.as_bytes());
    let digest = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

fn cipher() -> Aes256Gcm {
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&machine_key()))
}

/// Decrypt + parse the store. Any error (missing file, wrong machine, corrupt)
/// yields an empty map — the app then behaves as "not connected yet".
fn load() -> BTreeMap<String, String> {
    let Some(path) = store_path() else {
        return BTreeMap::new();
    };
    let bytes = match std::fs::read(&path) {
        Ok(b) if b.len() > 12 => b,
        _ => return BTreeMap::new(),
    };
    let (nonce, ct) = bytes.split_at(12);
    match cipher().decrypt(Nonce::from_slice(nonce), ct) {
        Ok(plain) => serde_json::from_slice(&plain).unwrap_or_default(),
        Err(_) => BTreeMap::new(),
    }
}

fn save(map: &BTreeMap<String, String>) -> Result<(), String> {
    let path = store_path().ok_or("no_home_dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir_failed: {e}"))?;
    }
    let plain = serde_json::to_vec(map).map_err(|e| e.to_string())?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher()
        .encrypt(&nonce, plain.as_ref())
        .map_err(|_| "encrypt_failed".to_string())?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ct);
    // Write via a temp file + rename so a crash can't truncate the store.
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("write_failed: {e}"))?;
        f.write_all(&out).map_err(|e| format!("write_failed: {e}"))?;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod_failed: {e}"))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename_failed: {e}"))
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let mut map = load();
    map.insert(key.to_string(), value.to_string());
    save(&map)
}

pub fn get(key: &str) -> Option<String> {
    load().get(key).cloned()
}

pub fn erase_all() {
    let mut map = load();
    for k in [
        K_COROS_EMAIL,
        K_COROS_PASSWORD,
        K_COROS_REGION,
        K_DEVICE_ID,
        K_DEVICE_PRIVATE_KEY,
    ] {
        map.remove(k);
    }
    let _ = save(&map);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_encryption() {
        let key = machine_key();
        let c = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let msg = br#"{"coros_password":"hunter2"}"#;
        let ct = c.encrypt(&nonce, msg.as_ref()).unwrap();
        let pt = c.decrypt(&nonce, ct.as_ref()).unwrap();
        assert_eq!(pt, msg);
    }
}
