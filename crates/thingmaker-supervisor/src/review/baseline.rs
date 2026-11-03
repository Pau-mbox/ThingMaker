//! Content-addressed baselines (REV-02).
//!
//! A baseline records, for every file in review scope, its hash, size and
//! mode, and retains the bytes of text files up to a size cap in the blob
//! store so diffs can be produced later. Large or binary files are recorded
//! with an omission reason instead of being silently excluded.

use std::{collections::BTreeMap, fs, path::{Path, PathBuf}, time::{Instant, SystemTime, UNIX_EPOCH}};

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
    capture(root, blobs, &mut BTreeMap::new(), false)
}

/// Reuses file content only when its filesystem identity and change metadata
/// still match. Every capture walks the tree again, including ignore rules,
/// so new/deleted/renamed files and external edits are visible before dispatch.
pub struct BaselineCache {
    root: PathBuf,
    blobs: BlobStore,
    files: BTreeMap<String, (FileStamp, BaselineFile)>,
}

impl BaselineCache {
    pub fn new(root: PathBuf, blobs: BlobStore) -> Self {
        Self { root, blobs, files: BTreeMap::new() }
    }

    pub fn capture(&mut self) -> Result<BaselineManifest, DesktopError> {
        capture(&self.root, &self.blobs, &mut self.files, true)
    }
}

#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    modified: SystemTime,
    bytes: u64,
    mode: Option<u32>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

impl FileStamp {
    fn of(metadata: &fs::Metadata) -> Option<Self> {
        // mtime and size alone miss edits with restored timestamps. Unix ctime
        // covers those, and device/inode cover atomic replacement. Platforms
        // without that change stamp conservatively reread the file.
        #[cfg(not(unix))]
        { let _ = metadata; None }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Some(Self {
                modified: metadata.modified().ok()?, bytes: metadata.len(), mode: mode_of(metadata),
                identity: (metadata.dev(), metadata.ino(), metadata.ctime(), metadata.ctime_nsec()),
            })
        }
    }
}

fn capture(root: &Path, blobs: &BlobStore, cache: &mut BTreeMap<String, (FileStamp, BaselineFile)>, retain: bool) -> Result<BaselineManifest, DesktopError> {
    let started = Instant::now();
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
    let mut next_cache = BTreeMap::new();
    let mut reused = 0usize;
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
        let stamp = if retain { FileStamp::of(&metadata) } else { None };
        if let Some((old_stamp, file)) = cache.get(&rel)
            && stamp.as_ref() == Some(old_stamp)
        {
            omitted += usize::from(file.content != ContentState::Retained);
            files.insert(rel.clone(), file.clone());
            next_cache.insert(rel, (old_stamp.clone(), file.clone()));
            reused += 1;
            continue;
        }
        let file = if metadata.len() > MAX_RETAINED_BYTES {
            let hash = match hash_file(path) {
                Ok(hash) => hash,
                Err(error) if error.message.contains("No such file") => continue,
                Err(error) => return Err(error),
            };
            BaselineFile { hash, bytes: metadata.len(), mode, content: ContentState::TooLarge }
        } else {
            let bytes = match fs::read(path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(DesktopError::io(format!("{rel}: {error}"))),
            };
            let (hash, content) = if looks_binary(&bytes) {
                (BlobStore::hash(&bytes), ContentState::Binary)
            } else {
                (blobs.put(&bytes)?, ContentState::Retained)
            };
            BaselineFile { hash, bytes: metadata.len(), mode, content }
        };
        omitted += usize::from(file.content != ContentState::Retained);
        // Cache only files stable throughout the read.
        if let Some(stamp) = stamp
            && fs::metadata(path).ok().as_ref().and_then(FileStamp::of).as_ref() == Some(&stamp)
        {
            next_cache.insert(rel.clone(), (stamp, file.clone()));
        }
        files.insert(rel, file);
    }
    *cache = next_cache;
    tracing::debug!(elapsed_ms = started.elapsed().as_millis() as u64, files = files.len(), reused, "workspace snapshot captured");
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
    fn cached_capture_matches_fresh_after_edits_replacements_deletes_and_ignore_changes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("ws");
        fs::create_dir(&root).unwrap();
        let blobs = BlobStore::new(temp.path().join("blobs"));
        let mut cache = BaselineCache::new(root.clone(), blobs.clone());
        fs::write(root.join("edit.txt"), "before").unwrap();
        fs::write(root.join("remove.txt"), "remove").unwrap();
        fs::write(root.join("ignored.txt"), "ignore me").unwrap();
        fs::write(root.join("binary"), [0, 1, 2]).unwrap();
        fs::write(root.join("large"), vec![b'x'; (MAX_RETAINED_BYTES + 1) as usize]).unwrap();
        let first = cache.capture().unwrap();
        assert_eq!(cache.capture().unwrap().files, first.files);
        let old_time = fs::metadata(root.join("edit.txt")).unwrap().modified().unwrap();
        fs::write(root.join("edit.txt"), "after!").unwrap();
        // Same size and restored mtime must not fool the cache.
        fs::File::options().write(true).open(root.join("edit.txt")).unwrap().set_modified(old_time).unwrap();
        fs::rename(root.join("remove.txt"), root.join("renamed.txt")).unwrap();
        fs::write(root.join("new.txt"), "new").unwrap();
        fs::write(root.join("binary"), [0, 3, 4]).unwrap();
        fs::write(root.join("large"), vec![b'y'; (MAX_RETAINED_BYTES + 1) as usize]).unwrap();
        fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        let cached = cache.capture().unwrap();
        let fresh = capture_baseline(&root, &blobs).unwrap();
        assert_eq!(cached.files, fresh.files);
        assert_eq!(cached.omitted, fresh.omitted);
        assert_eq!(cached.truncated, fresh.truncated);
        assert!(!cached.files.contains_key("ignored.txt"));
        assert!(!cached.files.contains_key("remove.txt"));
        assert_ne!(cached.files["edit.txt"].hash, first.files["edit.txt"].hash);
        fs::write(root.join("replacement"), "atomic").unwrap();
        fs::rename(root.join("replacement"), root.join("edit.txt")).unwrap();
        fs::remove_file(root.join(".gitignore")).unwrap();
        fs::remove_file(root.join("new.txt")).unwrap();
        assert_eq!(cache.capture().unwrap().files, capture_baseline(&root, &blobs).unwrap().files);
    }

    #[cfg(unix)]
    #[test]
    fn cached_capture_notices_mode_changes_and_never_follows_symlinks() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("ws");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("script"), "hello").unwrap();
        let blobs = BlobStore::new(temp.path().join("blobs"));
        let mut cache = BaselineCache::new(root.clone(), blobs.clone());
        cache.capture().unwrap();
        fs::set_permissions(root.join("script"), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(cache.capture().unwrap().files["script"].mode, Some(0o755));
        fs::write(temp.path().join("outside"), "outside scope").unwrap();
        fs::remove_file(root.join("script")).unwrap();
        symlink(temp.path().join("outside"), root.join("script")).unwrap();
        assert!(cache.capture().unwrap().files.is_empty());
    }

    #[test]
    #[ignore = "manual timing against a workspace supplied through SNAPSHOT_TIMING_ROOT"]
    fn snapshot_timing() {
        let root = PathBuf::from(std::env::var_os("SNAPSHOT_TIMING_ROOT").expect("SNAPSHOT_TIMING_ROOT"));
        let temp = tempfile::tempdir().unwrap();
        let blobs = BlobStore::new(temp.path().join("blobs"));
        let mut cache = BaselineCache::new(root.clone(), blobs.clone());
        cache.capture().unwrap();
        for _ in 0..3 {
            let start = Instant::now();
            let fresh = capture_baseline(&root, &blobs).unwrap();
            let full = start.elapsed();
            let start = Instant::now();
            let cached = cache.capture().unwrap();
            let incremental = start.elapsed();
            assert_eq!(fresh.files, cached.files);
            eprintln!("files={} full_ms={:.1} cached_ms={:.1}", fresh.files.len(), full.as_secs_f64() * 1000.0, incremental.as_secs_f64() * 1000.0);
        }
    }

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
