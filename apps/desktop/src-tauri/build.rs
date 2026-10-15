fn main() {
    // The phone's screens are bundled from here; a checkout that has not
    // built them yet still compiles, and serves the phone a notice instead.
    let _ = std::fs::create_dir_all("../dist-remote");
    tauri_build::build()
}
