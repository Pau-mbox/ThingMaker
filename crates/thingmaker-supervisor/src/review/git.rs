//! Read-only Git scopes through the git CLI (REV-01, REV-05).
//!
//! Git is optional: non-Git folders use baselines only. Every invocation
//! disables pagers, hooks and external diff drivers because configured
//! helpers and hooks are executable code (REV-05). Outputs are bounded.

use std::{path::Path, process::Command, time::Duration};

use serde::{Deserialize, Serialize};

use crate::error::DesktopError;

const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

fn git(root: &Path, args: &[&str]) -> Result<std::process::Output, DesktopError> {
    let mut command = Command::new("git");
    command
        .arg("--no-pager")
        .args(["-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "core.pager=cat", "-c", "color.ui=never"])
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::null());
    let output = command.output().map_err(|e| DesktopError::io(format!("git unavailable: {e}")))?;
    if output.stdout.len() > MAX_OUTPUT_BYTES {
        return Err(DesktopError::limit_exceeded("git output exceeded the size limit"));
    }
    Ok(output)
}

pub fn is_git_repository(root: &Path) -> bool {
    git(root, &["rev-parse", "--is-inside-work-tree"])
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// Current branch (or short HEAD when detached).
pub fn git_head(root: &Path) -> Result<String, DesktopError> {
    let output = git(root, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let output = git(root, &["rev-parse", "--short", "HEAD"])?;
    if output.status.success() {
        return Ok(format!("detached {}", String::from_utf8_lossy(&output.stdout).trim()));
    }
    Ok("no commits".into())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    /// Porcelain index column (`M`, `A`, `D`, `R`, `?`, ` `...).
    pub index: String,
    /// Porcelain worktree column.
    pub worktree: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renamed_from: Option<String>,
    pub untracked: bool,
}

/// `git status --porcelain=v1 -z`, untracked files listed individually.
pub fn git_status(root: &Path) -> Result<Vec<GitStatusEntry>, DesktopError> {
    let output = git(root, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])?;
    if !output.status.success() {
        return Err(DesktopError::io(format!("git status failed: {}", String::from_utf8_lossy(&output.stderr).trim())));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    for record in text.split('\0').filter(|r| r.len() >= 4) {
        let (code, path) = record.split_at(3);
        let index = code[0..1].to_string();
        let worktree = code[1..2].to_string();
        entries.push(GitStatusEntry {
            path: path.to_string(),
            untracked: index == "?",
            index,
            worktree,
            renamed_from: None,
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

/// Unified diff of the working tree (or the index with `staged`) for the whole
/// tree or one path. Untracked files are not included by git; callers pair
/// this with `git_status`.
pub fn git_diff(root: &Path, staged: bool, path: Option<&str>) -> Result<String, DesktopError> {
    let mut args = vec!["diff", "--no-ext-diff", "--no-color", "--unified=3"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    if let Some(path) = path {
        args.push(path);
    }
    let output = git(root, &args)?;
    if !output.status.success() {
        return Err(DesktopError::io(format!("git diff failed: {}", String::from_utf8_lossy(&output.stderr).trim())));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[allow(dead_code)]
const _TIMEOUT_NOTE: Duration = Duration::from_secs(30);

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git_ok(root: &Path, args: &[&str]) -> bool {
        Command::new("git").arg("-C").arg(root).args(args).output().map(|o| o.status.success()).unwrap_or(false)
    }

    #[test]
    fn status_and_diff_on_a_temporary_repository() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        if !git_ok(root, &["init", "-q", "-b", "main"]) {
            eprintln!("skipping: git unavailable");
            return;
        }
        assert!(git_ok(root, &["config", "user.email", "t@example.com"]));
        assert!(git_ok(root, &["config", "user.name", "t"]));
        fs::write(root.join("a.txt"), "one\n").unwrap();
        assert!(git_ok(root, &["add", "a.txt"]));
        assert!(git_ok(root, &["commit", "-q", "-m", "init"]));
        assert!(is_git_repository(root));
        assert_eq!(git_head(root).unwrap(), "main");
        fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        fs::write(root.join("new.txt"), "n\n").unwrap();
        let status = git_status(root).unwrap();
        let a = status.iter().find(|e| e.path == "a.txt").unwrap();
        assert_eq!(a.worktree, "M");
        let n = status.iter().find(|e| e.path == "new.txt").unwrap();
        assert!(n.untracked);
        let diff = git_diff(root, false, Some("a.txt")).unwrap();
        assert!(diff.contains("+two"));
        assert!(git_diff(root, true, None).unwrap().is_empty());
        assert!(!is_git_repository(&temp.path().join("nope")));
    }
}

// ---------------------------------------------------------------------------
// Mutating operations (REV-04, REV-05, GIT-01..04). Every mutation is explicit,
// scoped to named paths, and never uses `reset --hard`, `stash` or `clean`.
// ---------------------------------------------------------------------------

use std::io::Write as _;

fn git_ok(root: &Path, args: &[&str]) -> Result<String, DesktopError> {
    let output = git(root, args)?;
    if !output.status.success() {
        return Err(DesktopError::io(format!(
            "git {} failed: {}",
            args.first().copied().unwrap_or(""),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn git_stdin(root: &Path, args: &[&str], input: &[u8]) -> Result<String, DesktopError> {
    let mut command = Command::new("git");
    command
        .arg("--no-pager")
        .args(["-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "core.pager=cat", "-c", "color.ui=never"])
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|e| DesktopError::io(format!("git unavailable: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input).map_err(|e| DesktopError::io(e.to_string()))?;
    }
    let output = child.wait_with_output().map_err(|e| DesktopError::io(e.to_string()))?;
    if !output.status.success() {
        return Err(DesktopError::conflict(format!(
            "git {} failed: {}",
            args.first().copied().unwrap_or(""),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn validate_paths(paths: &[String]) -> Result<(), DesktopError> {
    if paths.is_empty() {
        return Err(DesktopError::io("no paths given"));
    }
    for path in paths {
        if path.is_empty() || path.starts_with('/') || path.split('/').any(|part| part == "..") || path.contains('\0') {
            return Err(DesktopError::io(format!("invalid repository path {path:?}")));
        }
    }
    Ok(())
}

/// Content of `path` at `rev` (`HEAD`, or `:0`/`:` for the index). `None` when
/// the path does not exist there.
pub fn show_file(root: &Path, rev: &str, path: &str) -> Result<Option<String>, DesktopError> {
    validate_paths(std::slice::from_ref(&path.to_string()))?;
    let spec = format!("{rev}:{path}");
    let output = git(root, &["show", &spec])?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
}

pub fn stage(root: &Path, paths: &[String]) -> Result<(), DesktopError> {
    validate_paths(paths)?;
    let mut args = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_ok(root, &args).map(|_| ())
}

pub fn unstage(root: &Path, paths: &[String]) -> Result<(), DesktopError> {
    validate_paths(paths)?;
    // `restore --staged` never touches the working tree.
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_ok(root, &args).map(|_| ())
}

/// Reverts one tracked file's working-tree changes to the index (or deletes an
/// untracked file) only when its current content hash matches `expected_hash`.
/// This is a file action, not an undo of shell side effects (REV-04).
pub fn revert_file(root: &Path, path: &str, expected_hash: &str, untracked: bool) -> Result<(), DesktopError> {
    validate_paths(std::slice::from_ref(&path.to_string()))?;
    let full = root.join(path);
    let current = std::fs::read(&full).map_err(|e| DesktopError::io(format!("{path}: {e}")))?;
    if blake3::hash(&current).to_hex().to_string() != expected_hash {
        return Err(DesktopError::conflict(format!("{path} changed since the diff was computed; refresh before reverting")));
    }
    if untracked {
        std::fs::remove_file(&full).map_err(|e| DesktopError::io(e.to_string()))?;
        return Ok(());
    }
    git_ok(root, &["restore", "--worktree", "--", path]).map(|_| ())
}

/// Applies one hunk (a full unified patch for a single file) to the index
/// (`staged`) or, with `reverse`, backs it out of the working tree.
pub fn apply_patch(root: &Path, patch: &str, staged: bool, reverse: bool) -> Result<(), DesktopError> {
    if patch.len() > 4 * 1024 * 1024 {
        return Err(DesktopError::limit_exceeded("patch too large"));
    }
    let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
    if staged {
        args.push("--cached");
    }
    if reverse {
        args.push("-R");
    }
    args.push("-");
    git_stdin(root, &args, patch.as_bytes()).map(|_| ())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
    pub head: String,
    pub detached: bool,
    pub remotes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub branches: Vec<String>,
    pub root: String,
}

pub fn repository_info(root: &Path) -> Result<RepositoryInfo, DesktopError> {
    let head = git_head(root)?;
    let detached = head.starts_with("detached");
    let remotes = git_ok(root, &["remote"])?.lines().map(str::to_string).filter(|s| !s.is_empty()).collect();
    let upstream = git(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let (ahead, behind) = match &upstream {
        Some(up) => {
            let counts = git_ok(root, &["rev-list", "--left-right", "--count", &format!("HEAD...{up}")]).unwrap_or_default();
            let mut parts = counts.split_whitespace().map(|n| n.parse::<usize>().unwrap_or(0));
            (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
        }
        None => (0, 0),
    };
    let branches = git_ok(root, &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])?
        .lines()
        .map(str::to_string)
        .filter(|s| !s.is_empty() && !s.ends_with("/HEAD"))
        .collect();
    let top = git_ok(root, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    Ok(RepositoryInfo { head, detached, remotes, upstream, ahead, behind, branches, root: top })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub commit: String,
    pub summary: String,
}

/// Commits the index with `message`. Nothing is added implicitly.
pub fn commit(root: &Path, message: &str) -> Result<CommitOutcome, DesktopError> {
    let trimmed = message.trim();
    if trimmed.is_empty() || trimmed.len() > 10_000 {
        return Err(DesktopError::io("commit message must be 1-10000 characters"));
    }
    let staged = git_ok(root, &["diff", "--cached", "--name-only"])?;
    if staged.trim().is_empty() {
        return Err(DesktopError::conflict("nothing is staged; stage the changes to include first"));
    }
    git_stdin(root, &["commit", "--quiet", "--no-verify", "-F", "-"], trimmed.as_bytes())?;
    let commit = git_ok(root, &["rev-parse", "--short", "HEAD"])?.trim().to_string();
    let summary = git_ok(root, &["log", "-1", "--format=%s"])?.trim().to_string();
    Ok(CommitOutcome { commit, summary })
}

/// Pushes the current branch to `remote`, setting upstream when none exists.
/// Credentials stay with git's own helpers (REV-05). Never forces.
pub fn push(root: &Path, remote: &str) -> Result<String, DesktopError> {
    if remote.is_empty() || remote.starts_with('-') {
        return Err(DesktopError::io("invalid remote name"));
    }
    let head = git_head(root)?;
    if head.starts_with("detached") {
        return Err(DesktopError::conflict("cannot push a detached HEAD; check out a branch first"));
    }
    let output = git(root, &["push", "--porcelain", "--set-upstream", remote, &head])?;
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    if !output.status.success() {
        return Err(DesktopError::io(format!("push failed: {}", text.trim())));
    }
    Ok(text.trim().to_string())
}

// --- Worktrees ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
    pub is_main: bool,
}

pub fn worktree_list(root: &Path) -> Result<Vec<WorktreeEntry>, DesktopError> {
    let text = git_ok(root, &["worktree", "list", "--porcelain"])?;
    let mut entries = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for line in text.lines() {
        if line.is_empty() {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            current = Some(WorktreeEntry {
                path: path.to_string(),
                head: None,
                branch: None,
                bare: false,
                detached: false,
                locked: false,
                prunable: false,
                is_main: entries.is_empty(),
            });
        } else if let Some(entry) = current.as_mut() {
            if let Some(head) = line.strip_prefix("HEAD ") {
                entry.head = Some(head.to_string());
            } else if let Some(branch) = line.strip_prefix("branch ") {
                entry.branch = Some(branch.trim_start_matches("refs/heads/").to_string());
            } else if line == "bare" {
                entry.bare = true;
            } else if line == "detached" {
                entry.detached = true;
            } else if line.starts_with("locked") {
                entry.locked = true;
            } else if line.starts_with("prunable") {
                entry.prunable = true;
            }
        }
    }
    if let Some(entry) = current {
        entries.push(entry);
    }
    Ok(entries)
}

pub fn valid_branch_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains('@' )
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
}

/// Creates a worktree at `path` on a new branch `branch` starting from `base`.
pub fn worktree_add(root: &Path, path: &Path, branch: &str, base: &str) -> Result<(), DesktopError> {
    if !valid_branch_name(branch) {
        return Err(DesktopError::io("invalid branch name"));
    }
    if base.is_empty() || base.starts_with('-') {
        return Err(DesktopError::io("invalid base ref"));
    }
    if path.exists() {
        return Err(DesktopError::conflict(format!("{} already exists", path.display())));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| DesktopError::io(e.to_string()))?;
    }
    let path_text = path.to_string_lossy().into_owned();
    git_ok(root, &["worktree", "add", "-b", branch, &path_text, base]).map(|_| ())
}

/// The commit `HEAD` points at.
pub fn head_commit(root: &Path) -> Result<String, DesktopError> {
    Ok(git_ok(root, &["rev-parse", "HEAD"])?.trim().to_string())
}

/// Whether the working tree has no changes, tracked or untracked.
pub fn is_clean(root: &Path) -> Result<bool, DesktopError> {
    Ok(git_ok(root, &["status", "--porcelain", "--untracked-files=normal"])?.trim().is_empty())
}

/// The identity a commit is made under when the repository has none set.
fn identity_args(root: &Path) -> Vec<&'static str> {
    let has = git(root, &["config", "--get", "user.email"]).map(|output| output.status.success() && !output.stdout.is_empty()).unwrap_or(false);
    if has { Vec::new() } else { vec!["-c", "user.name=Super Thing", "-c", "user.email=superthing@localhost"] }
}

/// Commits everything in the tree. `None` when there was nothing to commit.
pub fn commit_all(root: &Path, message: &str) -> Result<Option<String>, DesktopError> {
    git_ok(root, &["add", "-A"])?;
    if git_ok(root, &["diff", "--cached", "--quiet"]).is_ok() {
        return Ok(None);
    }
    let mut args = identity_args(root);
    args.extend(["commit", "-q", "--no-verify", "-m", message]);
    git_ok(root, &args)?;
    head_commit(root).map(Some)
}

/// Puts the tree back to `commit`, dropping everything after it, tracked and
/// untracked. Only ever used inside a run's own worktree.
pub fn reset_hard(root: &Path, commit: &str) -> Result<(), DesktopError> {
    if commit.is_empty() || commit.starts_with('-') || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(DesktopError::io("invalid commit"));
    }
    git_ok(root, &["reset", "-q", "--hard", commit])?;
    git_ok(root, &["clean", "-q", "-fd"])?;
    Ok(())
}

/// Commits on `branch` that the checkout at `root` does not have, newest first.
pub fn commits_ahead(root: &Path, branch: &str) -> Result<Vec<(String, String)>, DesktopError> {
    if !valid_branch_name(branch) {
        return Err(DesktopError::io("invalid branch name"));
    }
    let range = format!("HEAD..{branch}");
    let text = git_ok(root, &["log", "--format=%H%x09%s", "-n", "200", &range])?;
    Ok(text.lines().filter_map(|line| line.split_once('\t')).map(|(sha, subject)| (sha.to_string(), subject.to_string())).collect())
}

/// What merging a run's branch did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum MergeOutcome {
    Merged { commit: String },
    /// Nothing to merge: the checkout already has every commit.
    UpToDate,
    /// The merge would conflict; it was aborted and nothing changed.
    Conflicts { files: Vec<String> },
}

/// Merges `branch` into the checkout at `root` with a merge commit. A merge
/// that conflicts is aborted, so the checkout is left as it was.
pub fn merge_branch(root: &Path, branch: &str, message: &str) -> Result<MergeOutcome, DesktopError> {
    if !valid_branch_name(branch) {
        return Err(DesktopError::io("invalid branch name"));
    }
    if !is_clean(root)? {
        return Err(DesktopError::conflict("the checkout has uncommitted changes; commit or stash them before merging the run"));
    }
    if commits_ahead(root, branch)?.is_empty() {
        return Ok(MergeOutcome::UpToDate);
    }
    let mut args = identity_args(root);
    args.extend(["merge", "--no-ff", "--no-edit", "-m", message, branch]);
    let output = git(root, &args)?;
    if output.status.success() {
        return Ok(MergeOutcome::Merged { commit: head_commit(root)? });
    }
    let files: Vec<String> = git_ok(root, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default().lines().map(str::to_string).collect();
    let _ = git(root, &["merge", "--abort"]);
    if files.is_empty() {
        return Err(DesktopError::io(format!("git merge failed: {}", String::from_utf8_lossy(&output.stderr).trim())));
    }
    Ok(MergeOutcome::Conflicts { files })
}

/// Removes a worktree. `force` is required when it has modifications; callers
/// snapshot dirty files first and confirm with the user (GIT-04).
pub fn worktree_remove(root: &Path, path: &Path, force: bool) -> Result<(), DesktopError> {
    let path_text = path.to_string_lossy().into_owned();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path_text);
    git_ok(root, &args).map(|_| ())
}

/// Patch of tracked uncommitted changes (working tree versus HEAD) and the list
/// of untracked files, for explicit transfer into a new worktree (GIT-01).
pub fn uncommitted_snapshot(root: &Path) -> Result<(String, Vec<String>), DesktopError> {
    let patch = git_ok(root, &["diff", "--no-ext-diff", "--no-color", "--binary", "HEAD"])?;
    let untracked = git_ok(root, &["ls-files", "--others", "--exclude-standard", "-z"])?
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    Ok((patch, untracked))
}

/// Applies a patch to a worktree's working tree and copies untracked files.
pub fn transfer_uncommitted(source_root: &Path, target_root: &Path, patch: &str, untracked: &[String]) -> Result<(), DesktopError> {
    if !patch.trim().is_empty() {
        git_stdin(target_root, &["apply", "--whitespace=nowarn", "-"], patch.as_bytes())?;
    }
    validate_paths_allow_empty(untracked)?;
    for rel in untracked {
        let from = source_root.join(rel);
        let to = target_root.join(rel);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| DesktopError::io(e.to_string()))?;
        }
        std::fs::copy(&from, &to).map_err(|e| DesktopError::io(format!("{rel}: {e}")))?;
    }
    Ok(())
}

fn validate_paths_allow_empty(paths: &[String]) -> Result<(), DesktopError> {
    if paths.is_empty() {
        return Ok(());
    }
    validate_paths(paths)
}

#[cfg(test)]
mod mutation_tests {
    use super::*;
    use std::fs;

    fn run(root: &Path, args: &[&str]) -> bool {
        Command::new("git").arg("-C").arg(root).args(args).output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn repo() -> Option<tempfile::TempDir> {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        if !run(root, &["init", "-q", "-b", "main"]) {
            return None;
        }
        assert!(run(root, &["config", "user.email", "t@example.com"]) && run(root, &["config", "user.name", "t"]));
        fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        assert!(run(root, &["add", "a.txt"]) && run(root, &["commit", "-q", "-m", "init"]));
        Some(temp)
    }

    #[test]
    fn stage_unstage_revert_and_commit_are_explicit_and_checked() {
        let Some(temp) = repo() else { return };
        let root = temp.path();
        fs::write(root.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        fs::write(root.join("u.txt"), "untracked\n").unwrap();
        stage(root, &["a.txt".into()]).unwrap();
        assert!(git_status(root).unwrap().iter().any(|e| e.path == "a.txt" && e.index == "M"));
        unstage(root, &["a.txt".into()]).unwrap();
        assert!(git_status(root).unwrap().iter().any(|e| e.path == "a.txt" && e.worktree == "M" && e.index == " "));
        // Stale hash: nothing happens.
        let stale = revert_file(root, "a.txt", "0".repeat(64).as_str(), false).unwrap_err();
        assert_eq!(stale.code, crate::ErrorCode::Conflict);
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "one\ntwo\nthree\nfour\n");
        let hash = blake3::hash(b"one\ntwo\nthree\nfour\n").to_hex().to_string();
        revert_file(root, "a.txt", &hash, false).unwrap();
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "one\ntwo\nthree\n");
        let uhash = blake3::hash(b"untracked\n").to_hex().to_string();
        revert_file(root, "u.txt", &uhash, true).unwrap();
        assert!(!root.join("u.txt").exists());
        assert!(commit(root, "empty").is_err(), "nothing staged");
        fs::write(root.join("b.txt"), "b\n").unwrap();
        stage(root, &["b.txt".into()]).unwrap();
        let outcome = commit(root, "add b\n\nbody").unwrap();
        assert_eq!(outcome.summary, "add b");
        assert!(stage(root, &["../x".into()]).is_err());
        let info = repository_info(root).unwrap();
        assert_eq!(info.head, "main");
        assert!(info.branches.contains(&"main".to_string()));
        assert_eq!(show_file(root, "HEAD", "b.txt").unwrap().as_deref(), Some("b\n"));
        assert!(show_file(root, "HEAD", "nope.txt").unwrap().is_none());
    }

    #[test]
    fn hunk_patches_apply_to_index_and_reverse_from_worktree() {
        let Some(temp) = repo() else { return };
        let root = temp.path();
        fs::write(root.join("a.txt"), "zero\none\ntwo\nthree\nfour\n").unwrap();
        let full = git_diff(root, false, Some("a.txt")).unwrap();
        // Build a patch with only the first hunk region (whole diff is one hunk here).
        apply_patch(root, &full, true, false).unwrap();
        assert!(!git_diff(root, true, Some("a.txt")).unwrap().is_empty(), "staged");
        assert!(git_diff(root, false, Some("a.txt")).unwrap().is_empty(), "worktree now matches index");
        unstage(root, &["a.txt".into()]).unwrap();
        apply_patch(root, &full, false, true).unwrap();
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "one\ntwo\nthree\n");
        assert!(apply_patch(root, "garbage", false, false).is_err());
    }

    #[test]
    fn worktrees_are_created_listed_transferred_and_removed() {
        let Some(temp) = repo() else { return };
        let root = temp.path();
        fs::write(root.join("a.txt"), "one\ntwo\nthree\ndirty\n").unwrap();
        fs::write(root.join("new.txt"), "n\n").unwrap();
        let (patch, untracked) = uncommitted_snapshot(root).unwrap();
        assert!(patch.contains("+dirty"));
        assert_eq!(untracked, vec!["new.txt"]);
        let wt_dir = tempfile::tempdir().unwrap();
        let wt = wt_dir.path().join("feature-x");
        worktree_add(root, &wt, "feature/x", "main").unwrap();
        let list = worktree_list(root).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list[0].is_main);
        assert_eq!(list[1].branch.as_deref(), Some("feature/x"));
        assert_eq!(fs::read_to_string(wt.join("a.txt")).unwrap(), "one\ntwo\nthree\n", "starts clean from base");
        transfer_uncommitted(root, &wt, &patch, &untracked).unwrap();
        assert_eq!(fs::read_to_string(wt.join("a.txt")).unwrap(), "one\ntwo\nthree\ndirty\n");
        assert!(wt.join("new.txt").exists());
        assert!(worktree_add(root, &wt, "feature/x", "main").is_err(), "exists");
        assert!(worktree_add(root, &wt_dir.path().join("bad"), "-evil", "main").is_err());
        assert!(worktree_remove(root, &wt, false).is_err(), "dirty worktree needs force");
        worktree_remove(root, &wt, true).unwrap();
        assert!(!wt.exists());
        assert_eq!(worktree_list(root).unwrap().len(), 1);
        assert!(valid_branch_name("feature/kit-1") && !valid_branch_name("a..b") && !valid_branch_name("x.lock"));
    }
}
