// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // An agent starting its ThingMaker MCP server runs this executable as a
    // stdio relay; no window, no app state.
    if std::env::args().nth(1).as_deref() == Some(thingmaker_supervisor::delegation::socket::RELAY_ARG) {
        if let Err(error) = thingmaker_supervisor::delegation::socket::relay() {
            eprintln!("thingmaker-mcp: {error}");
            std::process::exit(1);
        }
        return;
    }
    thingmaker_desktop_lib::run()
}
