//! Bounded file-name search for mention autocomplete (UX-05).

use std::path::Path;

use ignore::WalkBuilder;

/// Maximum entries visited before giving up, so a huge tree stays responsive.
pub const SEARCH_WALK_LIMIT: usize = 50_000;

/// Returns relative paths whose text contains `query` (case-insensitive),
/// shortest first, plus whether the walk or result list was truncated.
pub fn search_files(root: &Path, query: &str, limit: usize) -> (Vec<String>, bool) {
    let needle = query.trim().to_lowercase();
    let mut matches: Vec<String> = Vec::new();
    let mut visited = 0;
    let mut truncated = false;
    let walker = WalkBuilder::new(root).hidden(true).require_git(false).follow_links(false).build();
    for entry in walker.flatten() {
        visited += 1;
        if visited > SEARCH_WALK_LIMIT {
            truncated = true;
            break;
        }
        if entry.depth() == 0 || !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else { continue };
        let text = relative.to_string_lossy().replace('\\', "/");
        if needle.is_empty() || text.to_lowercase().contains(&needle) {
            matches.push(text);
            if matches.len() >= limit * 4 {
                truncated = true;
                break;
            }
        }
    }
    matches.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
    if matches.len() > limit {
        matches.truncate(limit);
        truncated = true;
    }
    (matches, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_by_substring_and_respects_limit() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("src/deep")).unwrap();
        std::fs::write(temp.path().join("src/main.rs"), "").unwrap();
        std::fs::write(temp.path().join("src/deep/main_test.rs"), "").unwrap();
        std::fs::write(temp.path().join("README.md"), "").unwrap();
        std::fs::write(temp.path().join(".gitignore"), "ignored/\n").unwrap();
        std::fs::create_dir_all(temp.path().join("ignored")).unwrap();
        std::fs::write(temp.path().join("ignored/main.rs"), "").unwrap();
        let (all, _) = search_files(temp.path(), "main", 10);
        assert_eq!(all, vec!["src/main.rs", "src/deep/main_test.rs"]);
        let (one, truncated) = search_files(temp.path(), "main", 1);
        assert_eq!(one, vec!["src/main.rs"]);
        assert!(truncated);
    }
}
