//! A real MCP server from the catalog, started the way the Integrations panel
//! tests one: with a session's environment, on the tool folders' PATH. It
//! downloads the package once and spends no tokens, but needs the network:
//!
//! ```text
//! THINGMAKER_REAL_MCP=1 cargo test -p thingmaker-supervisor --test real_mcp -- --nocapture
//! ```

use std::{collections::HashMap, path::PathBuf, time::Duration};

use thingmaker_supervisor::{integrations::mcp, security::EnvironmentProfile};

#[test]
fn a_catalog_server_starts_and_lists_its_tools() {
    if std::env::var("THINGMAKER_REAL_MCP").as_deref() != Ok("1") {
        eprintln!("set THINGMAKER_REAL_MCP=1 to start a real server; skipping");
        return;
    }
    let home = PathBuf::from(std::env::var("HOME").unwrap());
    // The PATH an app opened from the Dock has, plus the tool folders.
    let parent = std::env::vars().map(|(key, value)| if key == "PATH" { (key, "/usr/bin:/bin:/usr/sbin:/sbin".to_string()) } else { (key, value) });
    let env: HashMap<String, String> = EnvironmentProfile::trusted_local().with_tool_paths(&home).resolve(parent).into_iter().collect();
    let spec = mcp::catalog_spec("sequential-thinking", &std::env::temp_dir()).unwrap();
    let result = mcp::probe(&spec, &env, &std::env::temp_dir(), Duration::from_secs(120)).expect("the server starts");
    eprintln!("{result:?}");
    assert!(!result.tools.is_empty());
}
