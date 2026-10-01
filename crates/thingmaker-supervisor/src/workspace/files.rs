//! Checked file reads and writes (FS-03, EDT-02).
//!
//! Reads return a content hash and metadata; writes require the expected hash
//! of the current content and fail with `CONFLICT` when the file changed
//! underneath (agent, another editor). Newline style and permissions are
//! preserved. Binary and oversized files are reported, never edited here.

use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

use super::explorer::resolve_contained;
use crate::error::DesktopError;

pub const MAX_EDITABLE_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_READ_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRead {
    pub relative_path: String,
    /// Text content (lossy for invalid UTF-8) or empty when `binary`.
    pub content: String,
    /// BLAKE3 of the full file bytes, the token for checked writes.
    pub content_hash: String,
    pub bytes: u64,
    pub total_lines: usize,
    /// First line index (0-based) included in `content`.
    pub offset_line: usize,
    pub returned_lines: usize,
    pub truncated: bool,
    pub binary: bool,
    pub editable: bool,
    pub crlf: bool,
    pub modified_unix_ms: Option<u64>,
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8192)];
    sample.contains(&0) || std::str::from_utf8(sample).is_err() && sample.iter().filter(|b| **b < 9).count() > 0
}

/// Reads up to `limit` lines starting at `offset_line`. Always hashes the
/// whole file so the returned hash is valid for a checked write.
pub fn read_text(root: &Path, relative: &str, offset_line: usize, limit: usize) -> Result<FileRead, DesktopError> {
    let path = resolve_contained(root, relative)?;
    let metadata = fs::metadata(&path).map_err(|e| DesktopError::io(format!("{relative}: {e}")))?;
    if !metadata.is_file() {
        return Err(DesktopError::io("not a regular file"));
    }
    if metadata.len() > MAX_READ_BYTES {
        return Err(DesktopError::limit_exceeded(format!(
            "{relative} is {} bytes; files above {MAX_READ_BYTES} bytes open externally",
            metadata.len()
        )));
    }
    let bytes = fs::read(&path).map_err(|e| DesktopError::io(e.to_string()))?;
    let content_hash = hash_bytes(&bytes);
    let modified_unix_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let binary = looks_binary(&bytes);
    if binary {
        return Ok(FileRead {
            relative_path: relative.to_string(),
            content: String::new(),
            content_hash,
            bytes: metadata.len(),
            total_lines: 0,
            offset_line: 0,
            returned_lines: 0,
            truncated: false,
            binary: true,
            editable: false,
            crlf: false,
            modified_unix_ms,
        });
    }
    let text = String::from_utf8_lossy(&bytes);
    let crlf = text.contains("\r\n");
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let total_lines = lines.len();
    let slice: Vec<&str> = lines.iter().skip(offset_line).take(limit.max(1)).copied().collect();
    let returned_lines = slice.len();
    Ok(FileRead {
        relative_path: relative.to_string(),
        content: slice.concat(),
        content_hash,
        bytes: metadata.len(),
        total_lines,
        offset_line,
        returned_lines,
        truncated: offset_line + returned_lines < total_lines,
        binary: false,
        editable: metadata.len() <= MAX_EDITABLE_BYTES,
        crlf,
        modified_unix_ms,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub relative_path: String,
    pub content_hash: String,
    pub bytes: u64,
}

/// Writes `content` only if the file's current hash equals `expected_hash`
/// (`None` means the file must not exist yet). Newlines follow the existing
/// style; permissions are preserved; the replacement is atomic.
pub fn write_checked(root: &Path, relative: &str, expected_hash: Option<&str>, content: &str) -> Result<WriteOutcome, DesktopError> {
    let path = resolve_contained(root, relative)?;
    let existing = match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(DesktopError::io(error.to_string())),
    };
    match (&existing, expected_hash) {
        (Some(bytes), Some(expected)) if hash_bytes(bytes) != expected => {
            return Err(DesktopError::conflict(format!("{relative} changed on disk since it was read; reload before saving")));
        }
        (Some(_), None) => return Err(DesktopError::conflict(format!("{relative} already exists"))),
        (None, Some(_)) => return Err(DesktopError::conflict(format!("{relative} was deleted since it was read"))),
        _ => {}
    }
    if content.len() as u64 > MAX_EDITABLE_BYTES {
        return Err(DesktopError::limit_exceeded("content exceeds the editable size limit"));
    }
    let crlf = existing.as_ref().is_some_and(|b| b.windows(2).any(|w| w == b"\r\n"));
    let normalized = content.replace("\r\n", "\n");
    let bytes = if crlf { normalized.replace('\n', "\r\n") } else { normalized };
    let temp = path.with_extension(format!("{}.kw-tmp", path.extension().and_then(|e| e.to_str()).unwrap_or("")));
    fs::write(&temp, bytes.as_bytes()).map_err(|e| DesktopError::io(e.to_string()))?;
    if let Some(meta) = existing.as_ref().and(fs::metadata(&path).ok()) {
        let _ = fs::set_permissions(&temp, meta.permissions());
    }
    fs::rename(&temp, &path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        DesktopError::io(e.to_string())
    })?;
    Ok(WriteOutcome {
        relative_path: relative.to_string(),
        content_hash: hash_bytes(bytes.as_bytes()),
        bytes: bytes.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ranges_and_hashes_whole_file() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("a.txt"), "l1\nl2\nl3\n").unwrap();
        let all = read_text(temp.path(), "a.txt", 0, 100).unwrap();
        assert_eq!((all.total_lines, all.returned_lines, all.truncated), (3, 3, false));
        let page = read_text(temp.path(), "a.txt", 1, 1).unwrap();
        assert_eq!(page.content, "l2\n");
        assert!(page.truncated);
        assert_eq!(page.content_hash, all.content_hash);
        fs::write(temp.path().join("bin"), [0u8, 159, 146, 150]).unwrap();
        assert!(read_text(temp.path(), "bin", 0, 10).unwrap().binary);
        assert!(read_text(temp.path(), "../etc/passwd", 0, 10).is_err());
    }

    #[test]
    fn checked_write_detects_conflicts_and_preserves_crlf_and_mode() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("b.txt");
        fs::write(&path, "one\r\ntwo\r\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let read = read_text(temp.path(), "b.txt", 0, 10).unwrap();
        assert!(read.crlf);
        let written = write_checked(temp.path(), "b.txt", Some(&read.content_hash), "one\nthree\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"one\r\nthree\r\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o755);
        }
        let stale = write_checked(temp.path(), "b.txt", Some(&read.content_hash), "again\n").unwrap_err();
        assert_eq!(stale.code, crate::ErrorCode::Conflict);
        assert_eq!(fs::read(&path).unwrap(), b"one\r\nthree\r\n", "stale write changed nothing");
        let fresh = write_checked(temp.path(), "b.txt", Some(&written.content_hash), "again\n").unwrap();
        assert_ne!(fresh.content_hash, written.content_hash);
        assert!(write_checked(temp.path(), "b.txt", None, "x").is_err(), "exists but caller expected new");
        let created = write_checked(temp.path(), "new.txt", None, "hello\n").unwrap();
        assert_eq!(created.bytes, 6);
        assert!(!temp.path().join("new.txt.kw-tmp").exists());
    }
}
