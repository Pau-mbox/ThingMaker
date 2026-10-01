//! Artifact model (ART-01, ART-02, ART-04).
//!
//! An artifact is a versioned reference to produced content. Two sources feed
//! it: files the agent reports producing for a tool call (provenance
//! `runtime_reported`, attributed to that call — Codex's generated images, for
//! one) and workspace files that changed against the session baseline
//! (provenance `observed`: a watched file is not proven agent-produced). A
//! later change to the same logical path creates a new version; nothing is
//! silently replaced. Bytes are snapshotted content-addressed so a version can
//! be viewed or exported after the source moves on.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{DesktopError, review::diff::{ChangeKind, DiffReport}};

pub const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_INLINE_TEXT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_INLINE_IMAGE_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    /// Reported by the agent as the output of a specific tool call.
    RuntimeReported,
    /// Seen changing in the workspace during the session; attribution is a
    /// desktop observation, not a runtime statement.
    Observed,
}

impl Provenance {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RuntimeReported => "runtime_reported",
            Self::Observed => "observed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "runtime_reported" => Some(Self::RuntimeReported),
            "observed" => Some(Self::Observed),
            _ => None,
        }
    }
}

/// How the desktop may present the content (ART-02). Anything not listed
/// opens only through an explicit external action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Viewer {
    Text,
    Markdown,
    Json,
    Code,
    Image,
    /// Text that must never be rendered as markup inside the app origin
    /// (HTML, SVG): shown as source only.
    MarkupSource,
    External,
}

impl Viewer {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Markdown => "markdown",
            Self::Json => "json",
            Self::Code => "code",
            Self::Image => "image",
            Self::MarkupSource => "markup_source",
            Self::External => "external",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "text" => Self::Text,
            "markdown" => Self::Markdown,
            "json" => Self::Json,
            "code" => Self::Code,
            "image" => Self::Image,
            "markup_source" => Self::MarkupSource,
            _ => Self::External,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Classification {
    pub mime: String,
    pub viewer: Viewer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<&'static str>,
}

fn is_probably_text(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8192)];
    !sample.contains(&0) && std::str::from_utf8(sample).is_ok_and(|s| s.chars().filter(|c| c.is_control() && !c.is_whitespace()).count() * 50 < s.len().max(1))
}

/// Classifies by sniffed content first, then extension. SVG and HTML are
/// treated as source, never as renderable markup (ART-02).
pub fn classify(path: &Path, bytes: &[u8]) -> Classification {
    if let Some((crate::attachments::MediaKind::Image, mime)) = crate::attachments::sniff_media(bytes) {
        return Classification { mime: mime.into(), viewer: Viewer::Image, language: None };
    }
    let extension = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    let text = is_probably_text(bytes);
    let (mime, viewer, language): (&str, Viewer, Option<&'static str>) = match extension.as_str() {
        "md" | "markdown" if text => ("text/markdown", Viewer::Markdown, Some("markdown")),
        "json" if text => ("application/json", Viewer::Json, Some("json")),
        "html" | "htm" | "xhtml" if text => ("text/html", Viewer::MarkupSource, Some("html")),
        "svg" if text => ("image/svg+xml", Viewer::MarkupSource, Some("xml")),
        "rs" if text => ("text/x-rust", Viewer::Code, Some("rust")),
        "ts" | "tsx" if text => ("text/typescript", Viewer::Code, Some("typescript")),
        "js" | "jsx" | "mjs" | "cjs" if text => ("text/javascript", Viewer::Code, Some("javascript")),
        "py" if text => ("text/x-python", Viewer::Code, Some("python")),
        "toml" if text => ("application/toml", Viewer::Code, Some("ini")),
        "yaml" | "yml" if text => ("application/yaml", Viewer::Code, Some("yaml")),
        "css" if text => ("text/css", Viewer::Code, Some("css")),
        "sh" | "bash" | "zsh" if text => ("text/x-shellscript", Viewer::Code, Some("shell")),
        "cs" if text => ("text/x-csharp", Viewer::Code, Some("csharp")),
        "go" if text => ("text/x-go", Viewer::Code, Some("go")),
        "java" | "kt" | "swift" | "c" | "h" | "cpp" | "hpp" | "sql" | "xml" | "txt" | "log" | "csv" | "" if text => ("text/plain", Viewer::Text, None),
        "pdf" => ("application/pdf", Viewer::External, None),
        _ if text => ("text/plain", Viewer::Text, None),
        _ => ("application/octet-stream", Viewer::External, None),
    };
    Classification { mime: mime.into(), viewer, language }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCandidate {
    /// Path shown to the user: workspace-relative for observed files, the
    /// `<call>/<file>` tail for runtime artifacts.
    pub logical_path: String,
    pub source_path: PathBuf,
    pub provenance: Provenance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
}

/// A file the agent reported producing for one tool call.
pub fn reported_candidate(call_id: &str, path: &Path) -> Option<ArtifactCandidate> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_ARTIFACT_BYTES {
        return None;
    }
    let name = path.file_name()?.to_string_lossy();
    Some(ArtifactCandidate {
        logical_path: format!("{call_id}/{name}"),
        source_path: path.to_path_buf(),
        provenance: Provenance::RuntimeReported,
        call_id: Some(call_id.to_string()),
    })
}

/// Workspace files added or modified against the session baseline.
pub fn observed_candidates(root: &Path, report: &DiffReport) -> Vec<ArtifactCandidate> {
    report
        .files
        .iter()
        .filter(|f| !matches!(f.kind, ChangeKind::Deleted))
        .filter(|f| f.after_bytes <= MAX_ARTIFACT_BYTES)
        .map(|f| ArtifactCandidate {
            logical_path: f.path.clone(),
            source_path: root.join(&f.path),
            provenance: Provenance::Observed,
            call_id: None,
        })
        .collect()
}

/// Content-addressed snapshot store for artifact versions.
pub struct ArtifactBlobs {
    dir: PathBuf,
}

impl ArtifactBlobs {
    pub fn new(data_dir: &Path) -> Self {
        Self { dir: data_dir.join("artifacts") }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn put(&self, bytes: &[u8]) -> Result<String, DesktopError> {
        let hash = crate::storage::content_hash(bytes);
        std::fs::create_dir_all(&self.dir).map_err(|e| DesktopError::io(e.to_string()))?;
        let path = self.dir.join(&hash);
        if !path.exists() {
            let temp = self.dir.join(format!("{hash}.tmp-{}", std::process::id()));
            std::fs::write(&temp, bytes).map_err(|e| DesktopError::io(e.to_string()))?;
            std::fs::rename(&temp, &path).map_err(|e| DesktopError::io(e.to_string()))?;
        }
        Ok(hash)
    }

    pub fn get(&self, hash: &str) -> Result<Vec<u8>, DesktopError> {
        if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(DesktopError::io("invalid artifact hash"));
        }
        std::fs::read(self.dir.join(hash)).map_err(|e| DesktopError::io(format!("artifact content missing: {e}")))
    }
}

/// Best-effort sensitive-content scan for export warnings (ART-04). Counts,
/// never extracts, matches.
pub fn sensitive_hits(text: &str) -> usize {
    let needles = ["-----BEGIN ", "sk-", "AKIA", "ghp_", "xoxb-", "Bearer ", "PRIVATE KEY", "password=", "secret="];
    needles.iter().map(|n| text.matches(n).count()).sum()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifestEntry {
    pub id: String,
    pub logical_path: String,
    pub exported_as: String,
    pub content_hash: String,
    pub bytes: u64,
    pub mime: String,
    pub provenance: Provenance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    pub version: i64,
    pub created_at: i64,
}

/// A safe file name for export: path separators collapse into `__`.
pub fn export_file_name(logical_path: &str, version: i64) -> String {
    let flat: String = logical_path
        .chars()
        .map(|c| if c == '/' || c == '\\' || c.is_control() { '_' } else { c })
        .collect();
    let flat = flat.trim_start_matches('.').to_string();
    match flat.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem}.v{version}.{ext}"),
        _ => format!("{flat}.v{version}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_keeps_markup_as_source_and_sniffs_images() {
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 0, 1, 0, 0, 0, 1];
        assert_eq!(classify(Path::new("x.bin"), &png).viewer, Viewer::Image);
        assert_eq!(classify(Path::new("index.html"), b"<html><script>alert(1)</script>").viewer, Viewer::MarkupSource);
        assert_eq!(classify(Path::new("logo.svg"), b"<svg onload='x'/>").viewer, Viewer::MarkupSource);
        assert_eq!(classify(Path::new("README.md"), b"# hi").viewer, Viewer::Markdown);
        assert_eq!(classify(Path::new("out.json"), b"{}").viewer, Viewer::Json);
        assert_eq!(classify(Path::new("main.rs"), b"fn main() {}").language, Some("rust"));
        assert_eq!(classify(Path::new("blob.bin"), &[0, 1, 2, 3, 0, 0]).viewer, Viewer::External);
        assert_eq!(classify(Path::new("doc.pdf"), b"%PDF-1.7").viewer, Viewer::External);
    }

    #[test]
    fn reported_artifacts_are_attributed_to_their_call() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("ig_1.png");
        std::fs::write(&path, b"png").unwrap();
        let candidate = reported_candidate("call-1", &path).unwrap();
        assert_eq!(candidate.logical_path, "call-1/ig_1.png");
        assert_eq!(candidate.call_id.as_deref(), Some("call-1"));
        assert_eq!(candidate.provenance, Provenance::RuntimeReported);
        assert!(reported_candidate("call-1", &temp.path().join("missing.png")).is_none());
    }

    #[test]
    fn blobs_export_names_and_sensitive_scan() {
        let temp = tempfile::tempdir().unwrap();
        let blobs = ArtifactBlobs::new(temp.path());
        let hash = blobs.put(b"hello").unwrap();
        assert_eq!(blobs.get(&hash).unwrap(), b"hello");
        assert!(blobs.get("nope").is_err());
        assert_eq!(export_file_name("src/main.rs", 2), "src_main.v2.rs");
        assert_eq!(export_file_name("call/compose-output.json", 1), "call_compose-output.v1.json");
        assert_eq!(sensitive_hits("token sk-abc and -----BEGIN RSA PRIVATE KEY-----"), 3);
    }
}
