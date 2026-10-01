//! Per-turn checkpoints for Odyssey (docs/research/odyssey-review.md §1.4, §3.5).
//!
//! A checkpoint used to be the review diff against a baseline captured when
//! the session opened. On the first real run that baseline pre-dated the
//! `.gitignore` the agent wrote in its first milestone, so 29,655 files of
//! Unity's `Library/` read as deleted, the diff saturated at the review cap,
//! and every checkpoint from the third onward said "2000 files". The
//! no-progress guard kept working only because `Assets/` sorts before
//! `Library/`.
//!
//! A checkpoint is now a fresh capture of the tree compared with the *previous
//! checkpoint's* capture, so it answers the question the runner, the monitor
//! and an acceptance review all ask: what did this turn change? The capture
//! honours `.gitignore` whether or not the project is a Git repository, and
//! the tree hash — every path with its content hash — is what "nothing
//! changed" is decided from, not a count that can hit a ceiling.

use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

use crate::{
    error::DesktopError,
    review::{BaselineManifest, BlobStore, ChangeKind, capture_baseline, diff_against_baseline},
};

/// Changed paths listed on a checkpoint. The counts are always exact; the
/// list is what a reader skims, and forty is already more than one reads.
pub const MAX_LISTED_FILES: usize = 40;

const MANIFEST_FILE: &str = "checkpoint.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFile {
    pub path: String,
    pub kind: ChangeKind,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// Every path in the tree with its content hash, hashed. Two checkpoints
    /// with the same tree hash saw an identical tree.
    pub tree_hash: String,
    /// Files in the tree at this checkpoint (ignore rules applied).
    pub file_count: usize,
    /// True when there was no earlier checkpoint for this goal to compare
    /// with, so the change counts below are zero by construction.
    pub first: bool,
    /// Files changed since the previous checkpoint — exact, not capped.
    pub changed: usize,
    pub additions: usize,
    pub deletions: usize,
    /// True when the change *list* was cut at [`MAX_LISTED_FILES`].
    pub truncated: bool,
    pub files: Vec<CheckpointFile>,
}

fn read_previous(store_dir: &Path) -> Option<BaselineManifest> {
    let bytes = fs::read(store_dir.join(MANIFEST_FILE)).ok()?;
    // A manifest this build cannot read is treated as no manifest: the next
    // checkpoint is a first one, and the guard starts counting again.
    serde_json::from_slice(&bytes).ok()
}

fn write_manifest(store_dir: &Path, manifest: &BaselineManifest) -> Result<(), DesktopError> {
    fs::create_dir_all(store_dir).map_err(|error| DesktopError::io(format!("could not create the checkpoint store: {error}")))?;
    let bytes = serde_json::to_vec(manifest).map_err(|error| DesktopError::io(error.to_string()))?;
    // Written beside and renamed over, so a crash mid-write leaves the
    // previous manifest intact rather than a truncated one.
    let temp = store_dir.join(format!("{MANIFEST_FILE}.tmp"));
    fs::write(&temp, bytes).map_err(|error| DesktopError::io(format!("could not write the checkpoint: {error}")))?;
    fs::rename(&temp, store_dir.join(MANIFEST_FILE)).map_err(|error| DesktopError::io(format!("could not replace the checkpoint: {error}")))?;
    Ok(())
}

/// Captures the tree under `root`, compares it with the previous checkpoint
/// kept in `store_dir`, and makes this capture the new previous one.
pub fn take_checkpoint(root: &Path, store_dir: &Path, blobs: &BlobStore) -> Result<Checkpoint, DesktopError> {
    let current = capture_baseline(root, blobs)?;
    let previous = read_previous(store_dir);
    let tree_hash = current.manifest_hash();
    let file_count = current.files.len();

    let checkpoint = match &previous {
        None => Checkpoint { tree_hash, file_count, first: true, changed: 0, additions: 0, deletions: 0, truncated: false, files: Vec::new() },
        Some(previous) => {
            let report = diff_against_baseline(previous, &current, blobs, "odyssey_checkpoint", "This turn versus the previous checkpoint", "previous checkpoint")?;
            let additions = report.files.iter().map(|file| file.additions).sum();
            let deletions = report.files.iter().map(|file| file.deletions).sum();
            let changed = report.files.len();
            let files = report
                .files
                .iter()
                .take(MAX_LISTED_FILES)
                .map(|file| CheckpointFile { path: file.path.clone(), kind: file.kind.clone(), additions: file.additions, deletions: file.deletions })
                .collect::<Vec<_>>();
            Checkpoint { tree_hash, file_count, first: false, changed, additions, deletions, truncated: changed > files.len() || report.truncated, files }
        }
    };

    write_manifest(store_dir, &current)?;
    Ok(checkpoint)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, BlobStore) {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("project/src")).unwrap();
        fs::write(temp.path().join("project/src/a.rs"), "fn a() {}\n").unwrap();
        fs::write(temp.path().join("project/src/b.rs"), "fn b() {}\n").unwrap();
        let blobs = BlobStore::new(temp.path().join("blobs"));
        (temp, blobs)
    }

    #[test]
    fn the_first_checkpoint_counts_the_tree_and_changes_nothing() {
        let (temp, blobs) = setup();
        let first = take_checkpoint(&temp.path().join("project"), &temp.path().join("store"), &blobs).unwrap();
        assert!(first.first);
        assert_eq!((first.file_count, first.changed, first.additions), (2, 0, 0));
        assert!(temp.path().join("store/checkpoint.json").exists(), "the capture is kept for the next turn");
    }

    #[test]
    fn a_turn_that_edits_one_file_shows_that_file_and_only_that_file() {
        let (temp, blobs) = setup();
        let root = temp.path().join("project");
        let store = temp.path().join("store");
        let first = take_checkpoint(&root, &store, &blobs).unwrap();
        fs::write(root.join("src/a.rs"), "fn a() {}\nfn a2() {}\n").unwrap();
        let second = take_checkpoint(&root, &store, &blobs).unwrap();
        assert!(!second.first);
        assert_eq!(second.changed, 1);
        assert_eq!(second.files[0].path, "src/a.rs");
        assert_eq!((second.additions, second.deletions), (1, 0));
        assert_ne!(first.tree_hash, second.tree_hash);
    }

    #[test]
    fn a_turn_that_changes_nothing_repeats_the_tree_hash() {
        let (temp, blobs) = setup();
        let root = temp.path().join("project");
        let store = temp.path().join("store");
        let first = take_checkpoint(&root, &store, &blobs).unwrap();
        let second = take_checkpoint(&root, &store, &blobs).unwrap();
        assert_eq!(first.tree_hash, second.tree_hash);
        assert_eq!(second.changed, 0);
        assert!(!second.first);
    }

    #[test]
    fn ignored_files_are_not_the_agents_work_even_without_a_git_repository() {
        // The Unity case: `Library/` is thousands of generated files behind
        // a `.gitignore` in a project that is not a Git repository.
        let (temp, blobs) = setup();
        let root = temp.path().join("project");
        let store = temp.path().join("store");
        fs::write(root.join(".gitignore"), "Library/\n").unwrap();
        take_checkpoint(&root, &store, &blobs).unwrap();
        fs::create_dir_all(root.join("Library")).unwrap();
        fs::write(root.join("Library/cache.bin"), "generated").unwrap();
        fs::write(root.join("src/c.rs"), "fn c() {}\n").unwrap();
        let after = take_checkpoint(&root, &store, &blobs).unwrap();
        assert_eq!(after.changed, 1);
        assert_eq!(after.files[0].path, "src/c.rs");
        assert_eq!(after.file_count, 4, ".gitignore, a, b, c — nothing from Library");
    }

    #[test]
    fn the_change_list_is_bounded_but_the_counts_are_not() {
        let (temp, blobs) = setup();
        let root = temp.path().join("project");
        let store = temp.path().join("store");
        take_checkpoint(&root, &store, &blobs).unwrap();
        for index in 0..(MAX_LISTED_FILES + 5) {
            fs::write(root.join(format!("src/gen{index}.rs")), "x\n").unwrap();
        }
        let after = take_checkpoint(&root, &store, &blobs).unwrap();
        assert_eq!(after.changed, MAX_LISTED_FILES + 5);
        assert_eq!(after.files.len(), MAX_LISTED_FILES);
        assert!(after.truncated);
    }
}
