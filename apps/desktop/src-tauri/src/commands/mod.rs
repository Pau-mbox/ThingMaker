//! Narrow renderer-facing API (spec section 20.1).
//!
//! Every command returns a result or a `DesktopError` exactly once. Inputs are
//! validated in Rust even though the TypeScript client is typed.

pub mod app;
pub mod artifacts;
pub mod attachments;
pub mod delegation;
pub mod git;
pub mod odyssey;
pub mod providers;
pub mod review;
pub mod runtime_env;
pub mod session;
pub mod skills;
pub mod superthing;
pub mod support;
pub mod terminal;
pub mod workspace;

use thingmaker_supervisor::DesktopError;

pub type CommandResult<T> = Result<T, DesktopError>;

pub(crate) fn storage_error(error: thingmaker_supervisor::storage::StorageError) -> DesktopError {
    use thingmaker_supervisor::storage::StorageError;
    match error {
        StorageError::Conflict(message) => DesktopError::conflict(message),
        StorageError::NotFound(message) => DesktopError::not_ready(message),
        StorageError::NewerSchema { .. } => DesktopError::unsupported(error.to_string()),
        other => DesktopError::io(other.to_string()),
    }
}
