//! Titles read from the real providers' own records.
//!
//! Opt-in (`THINGMAKER_REAL_TITLES="<provider>:<root>:<session id>,…"`): reads
//! each named session's transcript or index and prints the title it finds.
//! A session whose transcript the provider no longer has has none. Read-only;
//! nothing is sent anywhere.

use std::path::PathBuf;

use thingmaker_supervisor::agents::{Provider, titles};

#[test]
fn real_sessions_have_the_titles_their_providers_gave_them() {
    let Ok(list) = std::env::var("THINGMAKER_REAL_TITLES") else {
        eprintln!("set THINGMAKER_REAL_TITLES to read real transcripts");
        return;
    };
    let home = PathBuf::from(std::env::var("HOME").expect("HOME"));
    let mut found = 0;
    for entry in list.split(',').filter(|entry| !entry.is_empty()) {
        let mut parts = entry.splitn(3, ':');
        let (Some(provider), Some(root), Some(id)) = (parts.next(), parts.next(), parts.next()) else { panic!("bad entry {entry}") };
        let provider = Provider::parse(provider).expect("a provider");
        let title = titles::provider_title(provider, &home, &PathBuf::from(root), id);
        eprintln!("{id}: {title:?}");
        found += usize::from(title.is_some());
    }
    assert!(found > 0, "no title found for any of them");
}
