//! Stdio transport: framing, JSON-RPC envelopes and process lifecycle.
//!
//! ACP over stdio is a UTF-8 newline-delimited JSON-RPC stream, never a PTY
//! (spec section 8.3). The transport owns one ordered writer and two
//! continuously draining readers. Responses are correlated by request id and
//! resolved exactly once; server-initiated requests, notifications, stderr
//! lines and process exit are delivered in order over a bounded channel.

pub mod framing;
pub mod jsonrpc;
pub mod limits;
pub mod stdio;

pub use framing::{Frame, LineFramer};
pub use jsonrpc::{Message, ProtocolError, RequestId, RpcError};
pub use stdio::{ExitInfo, Incoming, LaunchSpec, ProcessPhase, Transport, TransportError};
