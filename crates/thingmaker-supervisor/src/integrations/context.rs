//! Configured context sources (CTX-01).
//!
//! Everything here is what is *configured on disk* for a workspace: the
//! instruction files each provider reads at session start and the skills it
//! can list. Whether any of it is currently in model context is only known
//! from what the agent reports, which the renderer shows separately.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::skills::{SkillEntry, discover_skills};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionFile {
    pub path: PathBuf,
    pub bytes: u64,
    pub content_hash: String,
    /// Distance from the root: 0 is the root's own file, 1 its parent's, ...
    pub depth: usize,
    /// Which providers read it: `AGENTS.md` is Codex's, `CLAUDE.md` Claude
    /// Code's.
    pub read_by: Vec<crate::agents::Provider>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSources {
    pub root: PathBuf,
    pub instruction_files: Vec<InstructionFile>,
    pub skills: Vec<SkillEntry>,
    pub notes: Vec<String>,
}

/// The instruction file names and who reads each.
const INSTRUCTION_FILES: &[(&str, &[crate::agents::Provider])] = &[
    ("AGENTS.md", &[]),
    ("CLAUDE.md", &[crate::agents::Provider::Claude]),
];

/// Instruction files at the root and every ancestor directory, nearest first.
pub fn instruction_chain(root: &Path) -> Vec<InstructionFile> {
    let mut out = Vec::new();
    let mut cursor = Some(root);
    let mut depth = 0;
    while let Some(dir) = cursor {
        for (name, read_by) in INSTRUCTION_FILES {
            let candidate = dir.join(name);
            if let Ok(bytes) = std::fs::read(&candidate) {
                out.push(InstructionFile {
                    path: candidate,
                    bytes: bytes.len() as u64,
                    content_hash: crate::storage::content_hash(&bytes),
                    depth,
                    read_by: read_by.to_vec(),
                });
            }
        }
        cursor = dir.parent();
        depth += 1;
    }
    out
}

pub fn context_sources(root: &Path, home: Option<&Path>) -> ContextSources {
    ContextSources {
        root: root.to_path_buf(),
        instruction_files: instruction_chain(root),
        skills: discover_skills(root, home),
        notes: vec![
            "Configured is not loaded: each agent reads its instruction files at session start and lists skills as it needs them; only what the agent reports says what reached the model.".into(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instruction_chain_walks_ancestors_nearest_first() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("a/b/c");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(temp.path().join("a/AGENTS.md"), "top").unwrap();
        std::fs::write(root.join("AGENTS.md"), "leaf").unwrap();
        std::fs::write(root.join("CLAUDE.md"), "claude").unwrap();
        let chain = instruction_chain(&root);
        assert!(chain.len() >= 3);
        assert_eq!(chain[0].depth, 0);
        assert!(chain[0].path.ends_with("c/AGENTS.md"));
        assert!(chain[1].path.ends_with("c/CLAUDE.md"));
        assert_eq!(chain[1].read_by, [crate::agents::Provider::Claude]);
        assert_eq!(chain[2].depth, 2);
        assert!(chain[2].path.ends_with("a/AGENTS.md"));
    }
}
