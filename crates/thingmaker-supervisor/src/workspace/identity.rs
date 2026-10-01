//! Canonical workspace identity.
//!
//! A workspace is its canonical root. `workspace_hash` is the BLAKE3 digest of
//! that path's bytes, a stable name for directories the desktop keeps per
//! workspace (its worktrees) that does not leak the path into a file name.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::error::DesktopError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIdentity {
    pub canonical_root: PathBuf,
    /// Human-readable path as the user provided it.
    pub display_path: String,
    /// `w-<hash>` of the canonical root.
    pub workspace_hash: String,
}

impl WorkspaceIdentity {
    pub fn resolve(path: &Path) -> Result<Self, DesktopError> {
        let canonical = canonical_root(path)
            .map_err(|error| DesktopError::io(format!("could not resolve {}: {error}", path.display())))?;
        Ok(Self {
            display_path: path.to_string_lossy().into_owned(),
            workspace_hash: workspace_hash(&canonical),
            canonical_root: canonical,
        })
    }
}

/// Canonicalizes a directory, leniently: when the leaf
/// does not exist yet, canonicalize the nearest existing ancestor and append
/// the remaining components.
pub fn canonical_root(path: &Path) -> io::Result<PathBuf> {
    match fs::canonicalize(path) {
        Ok(canonical) => {
            if !canonical.is_dir() {
                return Err(io::Error::new(io::ErrorKind::NotADirectory, "workspace root is not a directory"));
            }
            Ok(canonical)
        }
        Err(error) => {
            let mut ancestor = path.to_path_buf();
            let mut suffix = Vec::new();
            while let Some(name) = ancestor.file_name().map(ToOwned::to_owned) {
                suffix.push(name);
                if !ancestor.pop() {
                    return Err(error);
                }
                if let Ok(mut canonical) = fs::canonicalize(&ancestor) {
                    for component in suffix.iter().rev() {
                        canonical.push(component);
                    }
                    return Ok(canonical);
                }
            }
            Err(error)
        }
    }
}

/// `w-<blake3 hex of the canonical root's OS bytes>`.
pub fn workspace_hash(canonical_root: &Path) -> String {
    let digest = blake3::hash(canonical_root.as_os_str().as_encoded_bytes());
    format!("w-{}", digest.to_hex())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_and_distinguishes_roots() {
        let root = Path::new("/Users/example/project");
        let hash = workspace_hash(root);
        assert!(hash.starts_with("w-"));
        assert_eq!(hash.len(), 2 + 64);
        assert_eq!(hash, workspace_hash(root));
        assert_ne!(hash, workspace_hash(Path::new("/Users/example/project2")));
    }

    #[test]
    fn canonical_root_resolves_missing_leaf_via_existing_ancestor() {
        let temp = tempfile::tempdir().unwrap();
        let existing = canonical_root(temp.path()).unwrap();
        let missing = canonical_root(&temp.path().join("not-yet").join("deeper")).unwrap();
        assert!(missing.starts_with(&existing));
        assert!(missing.ends_with(Path::new("not-yet").join("deeper")));
        let file = temp.path().join("file.txt");
        fs::write(&file, b"x").unwrap();
        assert!(canonical_root(&file).is_err());
    }
}
