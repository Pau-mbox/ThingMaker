//! Native subprocess construction shared by desktop helpers.
use std::{ffi::OsStr, process::Command};

pub fn command(program: impl AsRef<OsStr>) -> Command {
    let program = program.as_ref();
    #[cfg(windows)]
    let resolved = {
        let path = std::path::Path::new(program);
        if path.components().count() == 1 && path.extension().is_none() {
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .flat_map(|dir| ["exe", "cmd", "bat"].map(|extension| dir.join(path).with_extension(extension)))
                .find(|path| path.is_file())
        } else { None }
    };
    #[cfg(windows)]
    let mut command = Command::new(resolved.as_ref().map(|path| path.as_os_str()).unwrap_or(program));
    #[cfg(not(windows))]
    let command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn batch_wrapper_preserves_a_quoted_argument_in_a_path_with_spaces() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("mock npm wrapper.cmd");
        std::fs::write(&script, "@echo off\r\necho %~1\r\n").unwrap();
        let output = command(&script).arg("a value with spaces").output().unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "a value with spaces");
    }
}
