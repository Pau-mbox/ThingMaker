//! Review workspace core (spec section 11.3).
//!
//! Baselines are content-addressed snapshots of the files in review scope,
//! captured before agent work. Diffs compare the working tree against a
//! baseline (no Git required) or, for Git projects, against the index and HEAD
//! through the git CLI. Nothing here mutates the working tree; apply, stage
//! and revert operations come with their own hash checks in a later step.

pub mod baseline;
pub mod blobs;
pub mod diff;
pub mod git;

pub use baseline::{BaselineFile, BaselineManifest, capture_baseline};
pub use blobs::BlobStore;
pub use diff::{ChangeKind, DiffReport, FileChange, diff_against_baseline};
pub use git::{
    CommitOutcome, GitStatusEntry, RepositoryInfo, WorktreeEntry, apply_patch, commit, git_diff, git_head, git_status,
    is_git_repository, push, repository_info, revert_file, show_file, stage, transfer_uncommitted, uncommitted_snapshot,
    unstage, worktree_add, worktree_list, worktree_remove,
};
