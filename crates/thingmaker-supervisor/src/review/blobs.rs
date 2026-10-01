//! Private content-addressed blob storage for baselines (spec section 15.1).
//!
//! Blobs live under the application data directory, keyed by BLAKE3 hash, so
//! identical content is stored once and a baseline can be diffed later even
//! after the working tree changed. Writes are atomic; nothing is deleted here
//! (retention is a separate, previewed operation).

use std::{fs, path::{Path, PathBuf}};

use crate::error::DesktopError;

#[derive(Debug, Clone)]
pub struct BlobStore {
    dir: PathBuf,
}

impl BlobStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path_for(&self, hash: &str) -> PathBuf {
        let (prefix, rest) = hash.split_at(hash.len().min(2));
        self.dir.join(prefix).join(rest)
    }

    pub fn hash(bytes: &[u8]) -> String {
        blake3::hash(bytes).to_hex().to_string()
    }

    /// Stores bytes and returns their hash. Existing blobs are left untouched.
    pub fn put(&self, bytes: &[u8]) -> Result<String, DesktopError> {
        let hash = Self::hash(bytes);
        let path = self.path_for(&hash);
        if path.exists() {
            return Ok(hash);
        }
        let parent = path.parent().ok_or_else(|| DesktopError::io("blob path has no parent"))?;
        fs::create_dir_all(parent).map_err(|e| DesktopError::io(e.to_string()))?;
        let temp = parent.join(format!(".{}.tmp-{}", hash, std::process::id()));
        fs::write(&temp, bytes).map_err(|e| DesktopError::io(e.to_string()))?;
        fs::rename(&temp, &path).or_else(|error| {
            let _ = fs::remove_file(&temp);
            if path.exists() { Ok(()) } else { Err(DesktopError::io(error.to_string())) }
        })?;
        Ok(hash)
    }

    pub fn get(&self, hash: &str) -> Result<Option<Vec<u8>>, DesktopError> {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(DesktopError::io("invalid blob hash"));
        }
        match fs::read(self.path_for(hash)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(DesktopError::io(error.to_string())),
        }
    }

    pub fn contains(&self, hash: &str) -> bool {
        self.path_for(hash).exists()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blobs_are_deduplicated_and_verified() {
        let temp = tempfile::tempdir().unwrap();
        let store = BlobStore::new(temp.path().join("blobs"));
        let hash = store.put(b"hello").unwrap();
        assert_eq!(store.put(b"hello").unwrap(), hash);
        assert_eq!(store.get(&hash).unwrap().unwrap(), b"hello");
        assert!(store.get(&"0".repeat(64)).unwrap().is_none());
        assert!(store.get("not-a-hash").is_err());
        assert!(store.contains(&hash));
    }
}
