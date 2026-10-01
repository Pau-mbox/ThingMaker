//! Workspace identity, explorer, files and search (FS-01, UX-03).

pub mod explorer;
pub mod files;
pub mod identity;
pub mod search;

pub use explorer::{DirEntry, EntryKind, list_dir};
pub use files::{FileRead, WriteOutcome, read_text, write_checked};
pub use search::search_files;
pub use identity::{WorkspaceIdentity, canonical_root, workspace_hash};
