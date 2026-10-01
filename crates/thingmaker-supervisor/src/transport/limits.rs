//! Client-side resource protections (spec section 8.3 and 8.6).
//!
//! These bound the desktop's own memory and latency. They are not changes to
//! The agents' computational limits: oversized valid output must be spooled, not
//! silently truncated on the wire.

use std::time::Duration;

/// Maximum bytes of one stdout JSON-RPC frame. Baseline media of 20 MiB
/// expands to roughly 27 MiB in base64, so a small cap would break existing
/// media support.
pub const MAX_STDOUT_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// Maximum bytes of one stderr line (runtime event or diagnostic).
pub const MAX_STDERR_LINE_BYTES: usize = 1024 * 1024;

/// Maximum simultaneously pending control requests per actor.
pub const MAX_PENDING_REQUESTS: usize = 64;

/// Maximum bytes of frontend deltas queued before a snapshot is required.
pub const MAX_QUEUED_DELTA_BYTES: usize = 8 * 1024 * 1024;

/// Text presentation coalescing target (about 30 Hz).
pub const TEXT_COALESCE_INTERVAL: Duration = Duration::from_millis(33);

/// Ordinary control request and initialization timeout.
pub const CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Resume replay inactivity timeout; progress resets it.
pub const RESUME_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(120);

/// Outer ceiling on one turn. `session/prompt` answers when the turn is over,
/// and an orchestrator waiting on its workers stays in one turn for hours, so
/// this is a backstop only: a turn is ended by `TURN_INACTIVITY_TIMEOUT`.
pub const TURN_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);

/// A turn with no update, no stderr and no tool call in flight for this long
/// has stopped; it is cancelled. A tool call in flight (a build, a test run,
/// `await_jobs` on the team's workers) is the agent waiting, not stopping.
pub const TURN_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(45 * 60);

/// Total desktop budget for cancel, close, drain and terminate.
pub const SHUTDOWN_BUDGET: Duration = Duration::from_secs(10);

/// Grace given to an active turn after `session/cancel` before closing.
pub const ACTIVE_TURN_CANCEL_GRACE: Duration = Duration::from_secs(1);

/// Timeout for the `session/close` request during shutdown.
pub const CLOSE_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

/// How long to wait for inherited pipes to drain after the child exited.
/// Grandchildren may keep stdout open; the exit must still be reported.
pub const INHERITED_PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// Cap for ordinary stderr diagnostic text forwarded to the UI.
pub const DIAGNOSTIC_LINE_CAP_BYTES: usize = 4096;

/// Payload string cap before large fields are replaced by a preview.
pub const PAYLOAD_LIMIT_BYTES: usize = 256 * 1024;

/// Preview retained when a payload string exceeds [`PAYLOAD_LIMIT_BYTES`].
pub const PAYLOAD_PREVIEW_BYTES: usize = 16 * 1024;

/// Bound for raw payload references kept for unknown updates and events.
pub const UNKNOWN_PAYLOAD_LIMIT_BYTES: usize = 64 * 1024;
