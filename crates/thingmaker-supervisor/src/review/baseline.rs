//! Content-addressed baselines (REV-02).
//!
//! A baseline records, for every file in review scope, its hash, size and
//! mode, and retains the bytes of text files up to a size cap in the blob
//! store so diffs can be produced later. Large or binary files are recorded
//! with an omission reason instead of being silently excluded.

use std::{collections::BTreeMap, fs, path::Path, time::UNIX_EPOCH};

use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

use super::blobs::BlobStore;
use crate::error::DesktopError;

pub const MAX_RETAINED_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_FILES: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineFile {
    pub hash: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    /// `retained` when the bytes are in the blob store; otherwise why not.
    pub content: ContentState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentState {
    Retained,
    TooLarge,
    Binary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineManifest {
    pub files: BTreeMap<String, BaselineFile>,
    pub omitted: usize,
    pub truncated: bool,
    pub captured_at_unix_ms: u64,
}

impl BaselineManifest {
    pub fn manifest_hash(&self) -> String {
        let mut hasher = blake3::Hasher::new();
        for (path, file) in &self.files {
            hasher.update(path.as_bytes());
            hasher.update(b"\0");
            hasher.update(file.hash.as_bytes());
            hasher.update(b"\n");
        }
        hasher.finalize().to_hex().to_string()
    }
}

pub(crate) fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8192)];
    sample.contains(&0)
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(p) => Some(p.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Walks the workspace (ignore rules applied, `.git` skipped) and records
/// every regular file. Text files up to [`MAX_RETAINED_BYTES`] are stored in
/// `blobs`.
pub fn capture_baseline(root: &Path, blobs: &BlobStore) -> Result<BaselineManifest, DesktopError> {
    let root = fs::canonicalize(root).map_err(|e| DesktopError::io(e.to_string()))?;
    let walker = WalkBuilder::new(&root)
        .hidden(false)
        .require_git(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .follow_links(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build();
    let mut files = BTreeMap::new();
    let mut omitted = 0;
    let mut truncated = false;
    for entry in walker.filter_map(Result::ok) {
        if files.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        let Some(kind) = entry.file_type() else { continue };
        if !kind.is_file() {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::metadata(path) else { continue };
        let mode = mode_of(&metadata);
        let rel = relative(&root, path);
        if metadata.len() > MAX_RETAINED_BYTES {
            // A file that disappears mid-walk (temporary outputs of a running
            // agent) is simply absent from this capture.
            let hash = match hash_file(path) {
                Ok(hash) => hash,
                Err(error) if error.message.contains("No such file") => continue,
                Err(error) => return Err(error),
            };
            files.insert(rel, BaselineFile { hash, bytes: metadata.len(), mode, content: ContentState::TooLarge });
            omitted += 1;
            continue;
        }
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(DesktopError::io(format!("{rel}: {error}"))),
        };
        if looks_binary(&bytes) {
            files.insert(rel, BaselineFile { hash: BlobStore::hash(&bytes), bytes: metadata.len(), mode, content: ContentState::Binary });
            omitted += 1;
            continue;
        }
        let hash = blobs.put(&bytes)?;
        files.insert(rel, BaselineFile { hash, bytes: metadata.len(), mode, content: ContentState::Retained });
    }
    Ok(BaselineManifest {
        files,
        omitted,
        truncated,
        captured_at_unix_ms: std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    })
}

fn hash_file(path: &Path) -> Result<String, DesktopError> {
    use std::io::Read;
    let mut file = fs::File::open(path).map_err(|e| DesktopError::io(e.to_string()))?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = file.read(&mut buffer).map_err(|e| DesktopError::io(e.to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

#[cfg(unix)]
pub(crate) fn mode_of(metadata: &fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(metadata.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
pub(crate) fn mode_of(_metadata: &fs::Metadata) -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_text_binary_and_large_files_with_ignore_rules() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("ws");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::write(root.join(".gitignore"), "target/\n").unwrap();
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(root.join("src/lib.rs"), "pub fn a() {}\n").unwrap();
        fs::write(root.join("logo.bin"), [0u8, 1, 2, 3]).unwrap();
        fs::write(root.join("target/out"), "ignored").unwrap();
        fs::write(root.join("big.txt"), vec![b'x'; (MAX_RETAINED_BYTES + 1) as usize]).unwrap();
        let blobs = BlobStore::new(temp.path().join("blobs"));
        let manifest = capture_baseline(&root, &blobs).unwrap();
        let paths: Vec<&str> = manifest.files.keys().map(String::as_str).collect();
        assert_eq!(paths, [".gitignore", "big.txt", "logo.bin", "src/lib.rs"]);
        assert_eq!(manifest.files["src/lib.rs"].content, ContentState::Retained);
        assert!(blobs.contains(&manifest.files["src/lib.rs"].hash));
        assert_eq!(manifest.files["logo.bin"].content, ContentState::Binary);
        assert_eq!(manifest.files["big.txt"].content, ContentState::TooLarge);
        assert_eq!(manifest.omitted, 2);
        assert!(!manifest.truncated);
        let again = capture_baseline(&root, &blobs).unwrap();
        assert_eq!(again.manifest_hash(), manifest.manifest_hash());
        fs::write(root.join("src/lib.rs"), "changed\n").unwrap();
        assert_ne!(capture_baseline(&root, &blobs).unwrap().manifest_hash(), manifest.manifest_hash());
    }
}
