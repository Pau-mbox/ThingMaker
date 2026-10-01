//! The ThingMaker MCP server as an agent starts it: a stdio relay to the
//! supervisor's socket (`thingmaker_supervisor::delegation::socket`).

fn main() {
    if let Err(error) = thingmaker_supervisor::delegation::socket::relay() {
        eprintln!("thingmaker-mcp: {error}");
        std::process::exit(1);
    }
}
