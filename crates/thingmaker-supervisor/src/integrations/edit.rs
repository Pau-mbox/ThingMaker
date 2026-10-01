//! Checked, backed-up writes for the configuration files the desktop edits
//! (skills, instruction files).

use std::path::Path;

use crate::error::DesktopError;

/// Writes `content` to `path` only if the file is still what was read.
///
/// `expected_hash` is the content hash the editor was opened on (`None` for a
/// file that did not exist). A mismatch is a conflict, not an overwrite. The
/// previous bytes are kept next to the file as `<name>.bak-<ms>`, and the new
/// ones land by rename so a crash never leaves half a file.
pub fn write_config_checked(path: &Path, expected_hash: Option<&str>, content: &str) -> Result<String, DesktopError> {
    let existing = match std::fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(DesktopError::io(error.to_string())),
    };
    let current_hash = existing.as_deref().map(crate::storage::content_hash);
    if current_hash.as_deref() != expected_hash {
        return Err(DesktopError::conflict("the file changed since it was read; reload and review again"));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| DesktopError::io(e.to_string()))?;
    }
    if let Some(bytes) = &existing {
        let stamp = crate::storage::now_unix_ms();
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "config".into());
        let backup = path.with_file_name(format!("{name}.bak-{stamp}"));
        std::fs::write(&backup, bytes).map_err(|e| DesktopError::io(format!("backup failed: {e}")))?;
    }
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temp, content.as_bytes()).map_err(|e| DesktopError::io(e.to_string()))?;
    std::fs::rename(&temp, path).map_err(|e| DesktopError::io(e.to_string()))?;
    Ok(crate::storage::content_hash(content.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stale_read_is_a_conflict_and_a_save_keeps_a_backup() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("AGENTS.md");
        let first = write_config_checked(&path, None, "one").unwrap();
        assert!(write_config_checked(&path, None, "two").is_err(), "the file exists now");
        write_config_checked(&path, Some(&first), "two").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        let backups = std::fs::read_dir(temp.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".bak-")).count();
        assert_eq!(backups, 1);
    }
}
