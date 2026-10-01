//! Skill import from folders and zip archives (CFG-10).
//!
//! Sources are staged into a private directory first, validated there, and
//! only then copied into `<root>/.agents/skills` or `~/.agents/skills` with an
//! atomic rename per skill. A source may contain one skill (SKILL.md at its
//! root) or several (directories with SKILL.md, up to two levels deep, as
//! forge archives and bundles are laid out). Entries that escape the archive,
//! are symlinks, or exceed the limits are rejected and reported, never
//! silently skipped.

use std::{
    collections::BTreeSet,
    io::Read,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::skills::{SkillFrontmatter, SkillScope, discover_skills, parse_frontmatter};
use crate::DesktopError;

pub const MAX_ENTRIES: usize = 2_000;
pub const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_DEPTH_FOR_SKILL_DIRS: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSkill {
    /// Directory name the skill would get under the skills root.
    pub directory_name: String,
    /// Path inside the staging area (relative).
    pub staged_subpath: String,
    pub frontmatter: SkillFrontmatter,
    pub files: Vec<String>,
    pub bytes: u64,
    pub problems: Vec<String>,
    /// An existing skill with the same directory name in the chosen scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collides_with: Option<SkillScope>,
    /// A same-named skill in the other scope that precedence would interact
    /// with (project shadows user).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadows_or_shadowed_by: Option<SkillScope>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub staging_id: String,
    pub source: PathBuf,
    pub source_kind: String,
    pub skills: Vec<ImportedSkill>,
    /// Entries refused during staging (path escape, symlink, too large...).
    pub rejected: Vec<String>,
    pub total_bytes: u64,
    pub entries: usize,
}

fn junk(name: &str) -> bool {
    name == ".DS_Store" || name == "__MACOSX" || name == "Thumbs.db" || name.starts_with("._")
}

fn safe_relative(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let text = part.to_str()?;
                if text.is_empty() || text.contains('\0') {
                    return None;
                }
                out.push(text);
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() { None } else { Some(out) }
}

fn sanitize_dir_name(raw: &str) -> String {
    let lowered: String = raw.trim().chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let collapsed = lowered.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    let trimmed = collapsed.trim_start_matches('.').to_string();
    if trimmed.is_empty() { "skill".into() } else { trimmed.chars().take(64).collect() }
}

struct Budget {
    entries: usize,
    bytes: u64,
}

impl Budget {
    fn take(&mut self, bytes: u64) -> Result<(), String> {
        self.entries += 1;
        if self.entries > MAX_ENTRIES {
            return Err(format!("more than {MAX_ENTRIES} entries"));
        }
        if bytes > MAX_FILE_BYTES {
            return Err(format!("file exceeds {} MiB", MAX_FILE_BYTES / 1024 / 1024));
        }
        self.bytes += bytes;
        if self.bytes > MAX_TOTAL_BYTES {
            return Err(format!("total exceeds {} MiB", MAX_TOTAL_BYTES / 1024 / 1024));
        }
        Ok(())
    }
}

fn stage_folder(source: &Path, staging: &Path, rejected: &mut Vec<String>, budget: &mut Budget) -> Result<(), DesktopError> {
    let mut stack = vec![PathBuf::new()];
    while let Some(relative) = stack.pop() {
        let dir = source.join(&relative);
        let entries = std::fs::read_dir(&dir).map_err(|e| DesktopError::io(format!("{}: {e}", dir.display())))?;
        for entry in entries {
            let entry = entry.map_err(|e| DesktopError::io(e.to_string()))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = relative.join(&name);
            if junk(&name) {
                continue;
            }
            let metadata = std::fs::symlink_metadata(entry.path()).map_err(|e| DesktopError::io(e.to_string()))?;
            if metadata.file_type().is_symlink() {
                rejected.push(format!("{}: symlink", rel.display()));
                continue;
            }
            if metadata.is_dir() {
                if name == ".git" {
                    rejected.push(format!("{}: git metadata is not part of a skill", rel.display()));
                    continue;
                }
                std::fs::create_dir_all(staging.join(&rel)).map_err(|e| DesktopError::io(e.to_string()))?;
                stack.push(rel);
                continue;
            }
            if !metadata.is_file() {
                rejected.push(format!("{}: not a regular file", rel.display()));
                continue;
            }
            if let Err(reason) = budget.take(metadata.len()) {
                return Err(DesktopError::limit_exceeded(format!("{}: {reason}", rel.display())));
            }
            if let Some(parent) = staging.join(&rel).parent() {
                std::fs::create_dir_all(parent).map_err(|e| DesktopError::io(e.to_string()))?;
            }
            std::fs::copy(entry.path(), staging.join(&rel)).map_err(|e| DesktopError::io(e.to_string()))?;
        }
    }
    Ok(())
}

fn stage_zip(source: &Path, staging: &Path, rejected: &mut Vec<String>, budget: &mut Budget) -> Result<(), DesktopError> {
    let file = std::fs::File::open(source).map_err(|e| DesktopError::io(e.to_string()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| DesktopError::io(format!("not a readable zip archive: {e}")))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| DesktopError::io(e.to_string()))?;
        let raw_name = entry.name().to_string();
        let Some(relative) = safe_relative(Path::new(&raw_name)) else {
            rejected.push(format!("{raw_name}: unsafe path"));
            continue;
        };
        if relative.components().any(|c| c.as_os_str().to_str().is_some_and(junk)) {
            continue;
        }
        if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            rejected.push(format!("{raw_name}: symlink"));
            continue;
        }
        if entry.is_dir() {
            std::fs::create_dir_all(staging.join(&relative)).map_err(|e| DesktopError::io(e.to_string()))?;
            continue;
        }
        if let Err(reason) = budget.take(entry.size()) {
            return Err(DesktopError::limit_exceeded(format!("{raw_name}: {reason}")));
        }
        let target = staging.join(&relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| DesktopError::io(e.to_string()))?;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        let mut limited = (&mut entry).take(MAX_FILE_BYTES + 1);
        limited.read_to_end(&mut bytes).map_err(|e| DesktopError::io(e.to_string()))?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(DesktopError::limit_exceeded(format!("{raw_name}: decompressed size exceeds the per-file limit")));
        }
        std::fs::write(&target, &bytes).map_err(|e| DesktopError::io(e.to_string()))?;
    }
    Ok(())
}

fn list_files(dir: &Path) -> (Vec<String>, u64) {
    let mut files = Vec::new();
    let mut bytes = 0;
    let mut stack = vec![PathBuf::new()];
    while let Some(relative) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(dir.join(&relative)) else { continue };
        for entry in entries.flatten() {
            let rel = relative.join(entry.file_name());
            if entry.path().is_dir() {
                stack.push(rel);
            } else if let Ok(metadata) = entry.metadata() {
                bytes += metadata.len();
                files.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    files.sort();
    (files, bytes)
}

/// Finds skill directories in the staging area: the root itself, or
/// directories up to two levels deep that contain SKILL.md.
fn find_skill_dirs(staging: &Path) -> Vec<PathBuf> {
    if staging.join("SKILL.md").is_file() {
        return vec![PathBuf::new()];
    }
    let mut found = Vec::new();
    let mut frontier = vec![(PathBuf::new(), 0usize)];
    while let Some((relative, depth)) = frontier.pop() {
        let Ok(entries) = std::fs::read_dir(staging.join(&relative)) else { continue };
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let rel = relative.join(entry.file_name());
            if staging.join(&rel).join("SKILL.md").is_file() {
                found.push(rel);
            } else if depth + 1 < MAX_DEPTH_FOR_SKILL_DIRS {
                frontier.push((rel, depth + 1));
            }
        }
    }
    found.sort();
    found
}

/// Stages a folder or zip into `staging` and describes what it contains.
pub fn stage_import(source: &Path, staging: &Path, staging_id: &str) -> Result<ImportPlan, DesktopError> {
    std::fs::create_dir_all(staging).map_err(|e| DesktopError::io(e.to_string()))?;
    let mut rejected = Vec::new();
    let mut budget = Budget { entries: 0, bytes: 0 };
    let metadata = std::fs::metadata(source).map_err(|e| DesktopError::io(format!("{}: {e}", source.display())))?;
    let source_kind = if metadata.is_dir() {
        stage_folder(source, staging, &mut rejected, &mut budget)?;
        "folder"
    } else if source.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("zip")) {
        stage_zip(source, staging, &mut rejected, &mut budget)?;
        "zip"
    } else {
        return Err(DesktopError::unsupported("import a skill folder or a .zip archive"));
    };
    let dirs = find_skill_dirs(staging);
    let source_stem = source.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "skill".into());
    let mut skills = Vec::new();
    let mut seen = BTreeSet::new();
    for rel in dirs {
        let dir = staging.join(&rel);
        let text = std::fs::read_to_string(dir.join("SKILL.md")).unwrap_or_default();
        let frontmatter = parse_frontmatter(&text);
        let base_name = if rel.as_os_str().is_empty() {
            frontmatter.name.clone().unwrap_or_else(|| source_stem.clone())
        } else {
            rel.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| source_stem.clone())
        };
        let mut directory_name = sanitize_dir_name(&base_name);
        let mut problems = frontmatter.problems.clone();
        if !seen.insert(directory_name.clone()) {
            directory_name = format!("{directory_name}-{}", seen.len());
            problems.push("duplicate directory name inside the import; renamed".into());
        }
        if frontmatter.name.as_deref().is_some_and(|n| n != directory_name) {
            problems.push(format!("frontmatter name {:?} differs from the directory name; agents list skills by frontmatter name", frontmatter.name.clone().unwrap_or_default()));
        }
        let codex_only: Vec<&str> = ["image_gen", "view_image", "CODEX_HOME", "apply_patch"]
            .into_iter()
            .filter(|needle| text.contains(needle))
            .collect();
        if !codex_only.is_empty() {
            problems.push(format!(
                "references Codex built-ins or paths ({}) that only Codex provides; under Claude Code only the skill's own scripts and instructions will work",
                codex_only.join(", ")
            ));
        }
        let (files, bytes) = list_files(&dir);
        skills.push(ImportedSkill {
            directory_name,
            staged_subpath: rel.to_string_lossy().replace('\\', "/"),
            frontmatter,
            files,
            bytes,
            problems,
            collides_with: None,
            shadows_or_shadowed_by: None,
        });
    }
    if skills.is_empty() {
        return Err(DesktopError::io("no SKILL.md found at the source root or up to two directory levels deep"));
    }
    Ok(ImportPlan {
        staging_id: staging_id.to_string(),
        source: source.to_path_buf(),
        source_kind: source_kind.into(),
        skills,
        rejected,
        total_bytes: budget.bytes,
        entries: budget.entries,
    })
}

/// Marks collisions against the skills already installed for a scope.
pub fn annotate_collisions(plan: &mut ImportPlan, scope: SkillScope, root: &Path, home: Option<&Path>) {
    let existing = discover_skills(root, home);
    for skill in &mut plan.skills {
        skill.collides_with = existing.iter().find(|e| e.scope == scope && e.directory_name == skill.directory_name).map(|e| e.scope);
        let name = skill.frontmatter.name.clone().unwrap_or_else(|| skill.directory_name.clone());
        skill.shadows_or_shadowed_by = existing
            .iter()
            .find(|e| e.scope != scope && e.name.clone().unwrap_or_else(|| e.directory_name.clone()) == name)
            .map(|e| e.scope);
    }
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), DesktopError> {
    std::fs::create_dir_all(to).map_err(|e| DesktopError::io(e.to_string()))?;
    for entry in std::fs::read_dir(from).map_err(|e| DesktopError::io(e.to_string()))? {
        let entry = entry.map_err(|e| DesktopError::io(e.to_string()))?;
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| DesktopError::io(e.to_string()))?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedSkill {
    pub directory_name: String,
    pub path: PathBuf,
    pub replaced: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup: Option<PathBuf>,
}

/// Moves an existing skill directory into `backup_root` (outside the skills
/// root, so agents stop listing it) and returns the backup path.
fn set_aside(target: &Path, directory_name: &str, backup_root: &Path) -> Result<PathBuf, DesktopError> {
    std::fs::create_dir_all(backup_root).map_err(|e| DesktopError::io(e.to_string()))?;
    let stamp = crate::storage::now_unix_ms();
    let moved = backup_root.join(format!("{directory_name}-{stamp}"));
    match std::fs::rename(target, &moved) {
        Ok(()) => Ok(moved),
        // Different volumes: copy then remove.
        Err(_) => {
            copy_tree(target, &moved)?;
            std::fs::remove_dir_all(target).map_err(|e| DesktopError::io(format!("could not remove the original skill after backing it up: {e}")))?;
            Ok(moved)
        }
    }
}

/// Copies selected staged skills into `skills_root`. An existing skill is
/// only replaced when `replace` is set; its previous content is moved into
/// `backup_root` first.
pub fn apply_import(
    staging: &Path,
    plan: &ImportPlan,
    selected: &[String],
    skills_root: &Path,
    replace: bool,
    backup_root: &Path,
) -> Result<Vec<AppliedSkill>, DesktopError> {
    std::fs::create_dir_all(skills_root).map_err(|e| DesktopError::io(e.to_string()))?;
    let mut applied = Vec::new();
    for skill in plan.skills.iter().filter(|s| selected.contains(&s.directory_name)) {
        let target = skills_root.join(&skill.directory_name);
        let exists = target.exists();
        if exists && !replace {
            return Err(DesktopError::conflict(format!("skill {} already exists; choose replace to overwrite it", skill.directory_name)));
        }
        let temp = skills_root.join(format!(".{}.import-{}", skill.directory_name, std::process::id()));
        if temp.exists() {
            let _ = std::fs::remove_dir_all(&temp);
        }
        copy_tree(&staging.join(&skill.staged_subpath), &temp)?;
        let mut backup = None;
        if exists {
            backup = Some(set_aside(&target, &skill.directory_name, backup_root)?);
        }
        std::fs::rename(&temp, &target).map_err(|e| DesktopError::io(e.to_string()))?;
        applied.push(AppliedSkill {
            directory_name: skill.directory_name.clone(),
            path: target,
            replaced: exists,
            backup,
        });
    }
    Ok(applied)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedSkill {
    pub directory_name: String,
    pub path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup: Option<PathBuf>,
}

/// Removes a skill directory from a skills root. With `backup_root` the
/// directory is moved there (reversible by copying it back); without it the
/// directory is deleted permanently. Only immediate skill directories that
/// contain SKILL.md are accepted.
pub fn remove_skill(skills_root: &Path, directory_name: &str, backup_root: Option<&Path>) -> Result<RemovedSkill, DesktopError> {
    if directory_name.is_empty() || directory_name.starts_with('.') || directory_name.contains('/') || directory_name.contains('\\') || directory_name == ".." {
        return Err(DesktopError::io("invalid skill directory name"));
    }
    let target = skills_root.join(directory_name);
    let metadata = std::fs::symlink_metadata(&target).map_err(|_| DesktopError::not_ready(format!("skill {directory_name} is not installed in this root")))?;
    if metadata.file_type().is_symlink() {
        return Err(DesktopError::io("refusing to remove a symlinked skill directory; remove the link manually"));
    }
    if !metadata.is_dir() || !target.join("SKILL.md").is_file() {
        return Err(DesktopError::io("not a skill directory (no SKILL.md)"));
    }
    let canonical_root = std::fs::canonicalize(skills_root).map_err(|e| DesktopError::io(e.to_string()))?;
    let canonical_target = std::fs::canonicalize(&target).map_err(|e| DesktopError::io(e.to_string()))?;
    if canonical_target.parent() != Some(canonical_root.as_path()) {
        return Err(DesktopError::io("skill path escapes the skills root"));
    }
    let backup = match backup_root {
        Some(root) => Some(set_aside(&target, directory_name, root)?),
        None => {
            std::fs::remove_dir_all(&target).map_err(|e| DesktopError::io(e.to_string()))?;
            None
        }
    };
    Ok(RemovedSkill {
        directory_name: directory_name.to_string(),
        path: target,
        backup,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_zip(path: &Path, entries: &[(&str, &str)]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn stages_a_folder_with_one_skill_and_applies_it() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("review-skill");
        std::fs::create_dir_all(source.join("resources")).unwrap();
        std::fs::write(source.join("SKILL.md"), "---\nname: review\ndescription: Review code\n---\nbody\n").unwrap();
        std::fs::write(source.join("resources/checklist.md"), "- item").unwrap();
        std::fs::write(source.join(".DS_Store"), "junk").unwrap();
        let staging = temp.path().join("staging");
        let mut plan = stage_import(&source, &staging, "st1").unwrap();
        assert_eq!(plan.source_kind, "folder");
        assert_eq!(plan.skills.len(), 1);
        assert_eq!(plan.skills[0].directory_name, "review");
        assert_eq!(plan.skills[0].files, vec!["SKILL.md", "resources/checklist.md"]);
        let root = temp.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        annotate_collisions(&mut plan, SkillScope::Project, &root, None);
        assert!(plan.skills[0].collides_with.is_none());
        let skills_root = root.join(".agents/skills");
        let backups = temp.path().join("backups");
        let applied = apply_import(&staging, &plan, &["review".into()], &skills_root, false, &backups).unwrap();
        assert_eq!(applied.len(), 1);
        assert!(skills_root.join("review/resources/checklist.md").exists());
        // Second import without replace is refused; with replace the old copy
        // moves out of the skills root so agents no longer see it.
        assert!(apply_import(&staging, &plan, &["review".into()], &skills_root, false, &backups).is_err());
        let replaced = apply_import(&staging, &plan, &["review".into()], &skills_root, true, &backups).unwrap();
        assert!(replaced[0].replaced);
        let backup = replaced[0].backup.clone().unwrap();
        assert!(backup.starts_with(&backups) && backup.join("SKILL.md").exists());
        assert_eq!(std::fs::read_dir(&skills_root).unwrap().count(), 1);
        // Removal with backup, then permanent removal.
        let removed = remove_skill(&skills_root, "review", Some(&backups)).unwrap();
        assert!(!skills_root.join("review").exists());
        assert!(removed.backup.unwrap().join("resources/checklist.md").exists());
        assert!(remove_skill(&skills_root, "review", Some(&backups)).is_err());
        apply_import(&staging, &plan, &["review".into()], &skills_root, false, &backups).unwrap();
        let gone = remove_skill(&skills_root, "review", None).unwrap();
        assert!(gone.backup.is_none() && !skills_root.join("review").exists());
        assert!(remove_skill(&skills_root, "../etc", None).is_err());
        apply_import(&staging, &plan, &["review".into()], &skills_root, false, &backups).unwrap();
        let mut plan2 = stage_import(&source, &temp.path().join("staging2"), "st2").unwrap();
        annotate_collisions(&mut plan2, SkillScope::Project, &root, None);
        assert_eq!(plan2.skills[0].collides_with, Some(SkillScope::Project));
    }

    #[test]
    fn stages_a_zip_bundle_and_rejects_unsafe_entries() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("skills.zip");
        write_zip(
            &archive,
            &[
                ("bundle-main/alpha/SKILL.md", "---\nname: alpha\ndescription: A\n---\n"),
                ("bundle-main/alpha/notes.txt", "n"),
                ("bundle-main/beta/SKILL.md", "---\nname: beta\ndescription: B\n---\n"),
                ("bundle-main/README.md", "not a skill"),
                ("../escape.txt", "x"),
                ("__MACOSX/bundle-main/._alpha", "junk"),
            ],
        );
        let plan = stage_import(&archive, &temp.path().join("staging"), "st").unwrap();
        assert_eq!(plan.source_kind, "zip");
        let names: Vec<_> = plan.skills.iter().map(|s| s.directory_name.clone()).collect();
        assert_eq!(names, vec!["alpha", "beta"]);
        assert!(plan.rejected.iter().any(|r| r.contains("escape.txt")));
        assert!(!temp.path().join("escape.txt").exists());
        let empty = temp.path().join("empty.zip");
        write_zip(&empty, &[("readme.txt", "no skill here")]);
        assert!(stage_import(&empty, &temp.path().join("staging-empty"), "e").is_err());
    }

    /// Opt-in check against a real skill folder or bundle on this machine:
    /// `THINGMAKER_SKILL_IMPORT_SAMPLE=/path cargo test -p thingmaker-supervisor stage_real_sample -- --nocapture`.
    #[test]
    fn stage_real_sample_when_requested() {
        let Ok(path) = std::env::var("THINGMAKER_SKILL_IMPORT_SAMPLE") else { return };
        let temp = tempfile::tempdir().unwrap();
        let plan = stage_import(Path::new(&path), &temp.path().join("staging"), "sample").unwrap();
        for skill in &plan.skills {
            println!(
                "{} <- {} ({} files, {} bytes) name={:?} problems={:?}",
                skill.directory_name,
                skill.staged_subpath,
                skill.files.len(),
                skill.bytes,
                skill.frontmatter.name,
                skill.problems
            );
        }
        println!("rejected: {:?}", plan.rejected);
        assert!(!plan.skills.is_empty());
    }

    #[test]
    fn directory_names_are_sanitized() {
        assert_eq!(sanitize_dir_name("My Cool Skill!!"), "my-cool-skill");
        assert_eq!(sanitize_dir_name("..hidden"), "hidden");
        assert_eq!(sanitize_dir_name(""), "skill");
    }
}
