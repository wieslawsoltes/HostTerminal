use std::collections::HashSet;
use std::path::{Path, PathBuf};
use terminal_protocol::ShellProfile;

pub fn home_directory() -> PathBuf {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" }))
}

pub fn executable_exists(path: &Path) -> bool {
    let Ok(meta) = path.metadata() else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn find_executable(name: &str) -> Option<PathBuf> {
    let path = Path::new(name);
    if path.is_absolute() || path.components().count() > 1 {
        return executable_exists(path).then(|| path.to_path_buf());
    }
    let search = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&search) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(name);
        if executable_exists(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        if path.extension().is_none() {
            let candidate = dir.join(format!("{name}.exe"));
            if executable_exists(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn default_arguments(path: &str) -> Vec<String> {
    let name = Path::new(path)
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match name.as_str() {
        "bash" | "zsh" | "fish" | "sh" | "dash" | "ksh" => vec!["-l".into()],
        "pwsh" | "powershell" => vec!["-NoLogo".into()],
        "cmd" => vec!["/Q".into()],
        _ => Vec::new(),
    }
}

pub fn discover_shells() -> Vec<ShellProfile> {
    let mut candidates = Vec::new();
    #[cfg(unix)]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            candidates.push(shell);
        }
        candidates.extend(
            [
                "/bin/zsh",
                "/bin/bash",
                "/usr/bin/fish",
                "/bin/sh",
                "pwsh",
                "nu",
            ]
            .into_iter()
            .map(str::to_owned),
        );
        if let Ok(shells) = std::fs::read_to_string("/etc/shells") {
            candidates.extend(
                shells
                    .lines()
                    .map(str::trim)
                    .filter(|line| line.starts_with('/'))
                    .take(32)
                    .map(str::to_owned),
            );
        }
    }
    #[cfg(windows)]
    {
        candidates.push("pwsh.exe".into());
        if let Some(windir) = std::env::var_os("WINDIR") {
            candidates.push(
                PathBuf::from(windir)
                    .join("System32/WindowsPowerShell/v1.0/powershell.exe")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        candidates.push("powershell.exe".into());
        if let Ok(shell) = std::env::var("COMSPEC") {
            candidates.push(shell);
        }
        candidates.extend(
            ["cmd.exe", "wsl.exe", "nu.exe"]
                .into_iter()
                .map(str::to_owned),
        );
    }
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter_map(|name| find_executable(&name))
        .filter_map(|path| {
            let path = path.to_string_lossy().into_owned();
            let key = if cfg!(windows) {
                path.to_ascii_lowercase()
            } else {
                path.clone()
            };
            if !seen.insert(key) {
                return None;
            }
            let name = Path::new(&path)
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("Shell")
                .to_string();
            Some(ShellProfile {
                name,
                args: default_arguments(&path),
                path,
            })
        })
        .collect()
}

pub fn default_shell() -> String {
    discover_shells()
        .first()
        .map(|profile| profile.path.clone())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "cmd.exe".into()
            } else {
                "/bin/sh".into()
            }
        })
}
