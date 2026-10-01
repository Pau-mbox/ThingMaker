//! A sanity check of the Claude transcript reader against a real file.
//!
//! Ignored by default: it reads whatever Claude Code has written for this
//! machine's own projects, so it is a check a developer runs, not a gate.
//! `cargo test -p thingmaker-supervisor --test claude_transcript_smoke -- --ignored --nocapture`
use std::path::PathBuf;

#[test]
#[ignore = "reads this machine's ~/.claude transcripts"]
fn totals_from_a_real_transcript_are_plausible() {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return };
    let dir = home.join(".claude/projects");
    let Ok(projects) = std::fs::read_dir(&dir) else {
        eprintln!("no {} on this machine", dir.display());
        return;
    };
    let mut checked = 0;
    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else { continue };
        for file in files.flatten() {
            if file.path().extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let usage = match thingmaker_supervisor::agents::claude::transcript_usage::read_transcript_usage(&file.path()) {
                Ok(usage) => usage,
                Err(error) => panic!("{}: {error:?}", file.path().display()),
            };
            if usage.totals.calls == 0 {
                continue;
            }
            checked += 1;
            println!(
                "{}: {} responses ({} folded), input {} (cached {}, written {}), output {}, paid input {}",
                file.file_name().to_string_lossy(),
                usage.totals.calls,
                usage.totals.folded_items,
                usage.totals.input_tokens,
                usage.totals.cached_input_tokens,
                usage.totals.cache_write_input_tokens,
                usage.totals.output_tokens,
                usage.totals.paid_input_tokens,
            );
            assert!(usage.totals.paid_input_tokens <= usage.totals.input_tokens, "paid input is a part of input");
            assert!(usage.totals.cached_input_tokens <= usage.totals.input_tokens, "cached input is a part of input");
            assert_eq!(usage.calls.len() as u64, usage.totals.calls);
        }
    }
    println!("checked {checked} transcripts");
    assert!(checked > 0, "no transcript with usage was found to check");
}
