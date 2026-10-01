//! Agent Skills discovery (CFG-10, CTX-01).
//!
//! Agents list valid skills under `<root>/.agents/skills` and `~/.agents/skills`
//! through its hidden `skill` tool; plugins contribute further skills that only
//! an agent can resolve. The desktop shows what is configured on disk, with origin
//! and collision precedence (project, then user, then plugins), and never
//! claims a skill is loaded into model context: loading happens on demand
//! inside a compose call.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    Project,
    User,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub directory_name: String,
    pub scope: SkillScope,
    pub path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub bytes: u64,
    pub content_hash: String,
    #[serde(default)]
    pub resources: Vec<String>,
    #[serde(default)]
    pub problems: Vec<String>,
    /// Same-named lower-precedence skill this one shadows (project over user).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadows: Option<SkillScope>,
    /// True when a higher-precedence skill of the same name exists.
    pub shadowed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFrontmatter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub other: BTreeMap<String, String>,
    #[serde(default)]
    pub problems: Vec<String>,
}

/// Parses the leading `---` YAML-style block: `key: value` lines plus one
/// level of nesting (`metadata:` followed by indented `sub: value` lines, as
/// the skill metadata map allows). Deeper structures are reported rather
/// than guessed at.
pub fn parse_frontmatter(text: &str) -> SkillFrontmatter {
    let mut out = SkillFrontmatter::default();
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        out.problems.push("SKILL.md must start with a `---` frontmatter block".into());
        return out;
    }
    let mut closed = false;
    let mut parent: Option<String> = None;
    let unquote = |value: &str| value.trim().trim_matches('"').trim_matches('\'').to_string();
    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if indented {
            let Some(parent_key) = &parent else {
                out.problems.push(format!("unexpected indentation: {}", line.trim()));
                continue;
            };
            let indent = line.len() - line.trim_start().len();
            match line.trim().split_once(':') {
                Some((key, value)) if indent <= 4 && !key.trim().is_empty() => {
                    out.other.insert(format!("{parent_key}.{}", key.trim()), unquote(value));
                }
                _ => out.problems.push(format!("nested frontmatter deeper than one level is not interpreted: {}", line.trim())),
            }
            continue;
        }
        match line.split_once(':') {
            Some((key, value)) => {
                let key = key.trim();
                let value = unquote(value);
                if value.is_empty() {
                    parent = Some(key.to_string());
                    continue;
                }
                parent = None;
                match key {
                    "name" => out.name = Some(value),
                    "description" => out.description = Some(value),
                    other => {
                        out.other.insert(other.to_string(), value);
                    }
                }
            }
            None => out.problems.push(format!("frontmatter line without `key: value`: {}", line.trim())),
        }
    }
    if !closed {
        out.problems.push("frontmatter block is not closed with `---`".into());
    }
    match &out.name {
        None => out.problems.push("missing `name`".into()),
        Some(name) if name.is_empty() => out.problems.push("`name` is empty".into()),
        Some(name) if !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') => {
            out.problems.push("`name` should use lowercase letters, digits and hyphens".into());
        }
        _ => {}
    }
    if out.description.as_deref().unwrap_or("").is_empty() {
        out.problems.push("missing `description`".into());
    }
    out
}

fn scan_root(root: &Path, scope: SkillScope) -> Vec<SkillEntry> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut skills = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_file = path.join("SKILL.md");
        let Ok(bytes) = std::fs::read(&skill_file) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        let frontmatter = parse_frontmatter(&text);
        let mut resources = Vec::new();
        if let Ok(children) = std::fs::read_dir(&path) {
            for child in children.flatten() {
                let name = child.file_name().to_string_lossy().into_owned();
                if name != "SKILL.md" {
                    resources.push(name);
                }
            }
        }
        resources.sort();
        skills.push(SkillEntry {
            directory_name: entry.file_name().to_string_lossy().into_owned(),
            scope,
            path: skill_file,
            name: frontmatter.name,
            description: frontmatter.description,
            bytes: bytes.len() as u64,
            content_hash: crate::storage::content_hash(&bytes),
            resources,
            problems: frontmatter.problems,
            shadows: None,
            shadowed: false,
        });
    }
    skills.sort_by(|a, b| a.directory_name.cmp(&b.directory_name));
    skills
}

pub fn project_skills_root(root: &Path) -> PathBuf {
    root.join(".agents").join("skills")
}

pub fn user_skills_root(home: &Path) -> PathBuf {
    home.join(".agents").join("skills")
}

/// Discovers project and user skills and marks same-name collisions.
pub fn discover_skills(root: &Path, home: Option<&Path>) -> Vec<SkillEntry> {
    let mut skills = scan_root(&project_skills_root(root), SkillScope::Project);
    if let Some(home) = home {
        skills.extend(scan_root(&user_skills_root(home), SkillScope::User));
    }
    let names: Vec<(String, SkillScope)> = skills
        .iter()
        .map(|s| (s.name.clone().unwrap_or_else(|| s.directory_name.clone()), s.scope))
        .collect();
    for skill in &mut skills {
        let name = skill.name.clone().unwrap_or_else(|| skill.directory_name.clone());
        let others: Vec<SkillScope> = names.iter().filter(|(n, scope)| *n == name && *scope != skill.scope).map(|(_, s)| *s).collect();
        if others.is_empty() {
            continue;
        }
        match skill.scope {
            SkillScope::Project => skill.shadows = Some(SkillScope::User),
            SkillScope::User => skill.shadowed = others.contains(&SkillScope::Project),
        }
    }
    skills
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_and_reports_problems() {
        let good = parse_frontmatter("---\nname: review\ndescription: Review code\nlicense: MIT\nmetadata:\n  short-description: \"Short\"\n  version: 2\n---\n# Body\n");
        assert_eq!(good.name.as_deref(), Some("review"));
        assert_eq!(good.other.get("license").map(String::as_str), Some("MIT"));
        assert_eq!(good.other.get("metadata.short-description").map(String::as_str), Some("Short"));
        assert_eq!(good.other.get("metadata.version").map(String::as_str), Some("2"));
        assert!(good.problems.is_empty(), "{:?}", good.problems);
        let bad = parse_frontmatter("# no frontmatter\n");
        assert!(!bad.problems.is_empty());
        let unclosed = parse_frontmatter("---\nname: Bad Name\n");
        assert!(unclosed.problems.iter().any(|p| p.contains("not closed")));
        assert!(unclosed.problems.iter().any(|p| p.contains("lowercase")));
    }

    #[test]
    fn project_skills_shadow_user_skills_with_the_same_name() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let home = temp.path().join("home");
        for (base, name, dir) in [(&root, "review", "review"), (&home, "review", "review"), (&home, "docs", "docs")] {
            let skill_dir = base.join(".agents/skills").join(dir);
            std::fs::create_dir_all(&skill_dir).unwrap();
            std::fs::write(skill_dir.join("SKILL.md"), format!("---\nname: {name}\ndescription: d\n---\n")).unwrap();
        }
        std::fs::write(home.join(".agents/skills/docs/reference.md"), "x").unwrap();
        let skills = discover_skills(&root, Some(&home));
        assert_eq!(skills.len(), 3);
        let project = skills.iter().find(|s| s.scope == SkillScope::Project).unwrap();
        assert_eq!(project.shadows, Some(SkillScope::User));
        let user_review = skills.iter().find(|s| s.scope == SkillScope::User && s.directory_name == "review").unwrap();
        assert!(user_review.shadowed);
        let docs = skills.iter().find(|s| s.directory_name == "docs").unwrap();
        assert!(!docs.shadowed);
        assert_eq!(docs.resources, vec!["reference.md"]);
    }
}
