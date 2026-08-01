//! OS keychain access. The COROS password and the device signing key live ONLY
//! here (macOS Keychain / Windows Credential Manager / Secret Service). Nothing
//! is written to config files, logs, argv, or environment variables.

use keyring::Entry;

const SERVICE: &str = "com.rungarden.desktop";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("keychain_open_failed: {e}"))
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    entry(key)?
        .set_password(value)
        .map_err(|e| format!("keychain_set_failed: {e}"))
}

pub fn get(key: &str) -> Option<String> {
    entry(key).ok().and_then(|e| e.get_password().ok())
}

pub fn delete(key: &str) {
    if let Ok(e) = entry(key) {
        let _ = e.delete_credential();
    }
}

/// Credential keys.
pub const K_COROS_EMAIL: &str = "coros_email";
pub const K_COROS_PASSWORD: &str = "coros_password";
pub const K_COROS_REGION: &str = "coros_region";
pub const K_DEVICE_ID: &str = "device_id";
pub const K_DEVICE_PRIVATE_KEY: &str = "device_private_key";
pub const K_CLOUD_URL: &str = "cloud_url";

pub fn erase_all() {
    for k in [
        K_COROS_EMAIL,
        K_COROS_PASSWORD,
        K_COROS_REGION,
        K_DEVICE_ID,
        K_DEVICE_PRIVATE_KEY,
    ] {
        delete(k);
    }
}
