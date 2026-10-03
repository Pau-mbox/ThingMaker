//! The phones paired with this Mac, and whether the bridge is on.
//!
//! Kept in `remote.json` in the app's data folder, readable by the user
//! only. A phone's token is never stored: only its blake3 hash, so the file
//! leaking does not let anything in. Revoking a phone deletes its entry.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_PORT: u16 = 47321;

fn default_port() -> u16 {
    DEFAULT_PORT
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub devices: Vec<Device>,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_PORT, devices: Vec::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub paired_at: i64,
    #[serde(default)]
    pub last_seen: Option<i64>,
}

fn file(data_dir: &Path) -> PathBuf {
    data_dir.join("remote.json")
}

pub fn load(data_dir: &Path) -> RemoteConfig {
    std::fs::read_to_string(file(data_dir)).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

pub fn save(data_dir: &Path, config: &RemoteConfig) -> std::io::Result<()> {
    let path = file(data_dir);
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec_pretty(config).unwrap_or_default())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(temp, path)
}

/// 244 random bits, as hex.
pub fn new_secret() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// A short code for the pairing QR, also typeable: 10 characters from an
/// alphabet without look-alikes.
pub fn new_pairing_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let id = uuid::Uuid::new_v4();
    // Bytes 6 and 8 carry the version and variant bits: skip them.
    let bytes = id.as_bytes();
    bytes[..6].iter().chain(&bytes[9..13]).map(|byte| ALPHABET[*byte as usize % ALPHABET.len()] as char).collect()
}

pub fn hash(token: &str) -> String {
    blake3::hash(token.as_bytes()).to_hex().to_string()
}

/// Equal without saying where they differ.
pub fn same(left: &str, right: &str) -> bool {
    left.len() == right.len() && left.bytes().zip(right.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

impl RemoteConfig {
    /// The paired phone a token belongs to.
    pub fn device_for(&self, token: &str) -> Option<&Device> {
        let hashed = hash(token);
        self.devices.iter().find(|device| same(&device.token_hash, &hashed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_is_found_by_its_hash_and_only_the_hash_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let token = new_secret();
        let mut config = RemoteConfig::default();
        config.devices.push(Device { id: "d1".into(), name: "Pixel".into(), token_hash: hash(&token), paired_at: 1, last_seen: None });
        save(dir.path(), &config).unwrap();
        let text = std::fs::read_to_string(dir.path().join("remote.json")).unwrap();
        assert!(!text.contains(&token));
        let loaded = load(dir.path());
        assert_eq!(loaded.device_for(&token).map(|device| device.id.as_str()), Some("d1"));
        assert!(loaded.device_for(&new_secret()).is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.path().join("remote.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn a_pairing_code_is_ten_unambiguous_characters() {
        let code = new_pairing_code();
        assert_eq!(code.len(), 10);
        assert!(code.chars().all(|c| !"01IOL".contains(c)));
        assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "ab"));
    }
}
