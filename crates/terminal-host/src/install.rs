//! User-scoped native-messaging registration. No privilege elevation or shell invocation.
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const HOST_NAME: &str = "com.host_terminal.host";
const CONFIG_NAME: &str = "host-config.json";
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Browser {
    Chrome,
    Chromium,
    Edge,
    Brave,
    ChromeForTesting,
}

impl Browser {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "chrome" => Ok(Self::Chrome), "chromium" => Ok(Self::Chromium),
            "edge" => Ok(Self::Edge), "brave" => Ok(Self::Brave),
            "chrome-for-testing" => Ok(Self::ChromeForTesting),
            _ => bail!("unknown browser {value:?}; use chrome, chromium, edge, brave, or chrome-for-testing"),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Chrome => "chrome",
            Self::Chromium => "chromium",
            Self::Edge => "edge",
            Self::Brave => "brave",
            Self::ChromeForTesting => "chrome-for-testing",
        }
    }
    #[cfg(target_os = "windows")]
    fn registration_family(self) -> &'static str {
        match self {
            Self::Chromium => "chromium",
            Self::Edge => "edge",
            _ => "chrome",
        }
    }
    #[cfg(target_os = "windows")]
    fn registry_key(self) -> String {
        let vendor = match self {
            Self::Chromium => "Chromium",
            Self::Edge => "Microsoft\\Edge",
            _ => "Google\\Chrome",
        };
        format!("Software\\{vendor}\\NativeMessagingHosts\\{HOST_NAME}")
    }
}

#[derive(Debug)]
struct Options {
    browser: Browser,
    extension_id: Option<String>,
    install_dir: Option<PathBuf>,
    manifest_dir: Option<PathBuf>,
}

impl Options {
    fn parse(arguments: &[String]) -> Result<Self> {
        let mut result = Self {
            browser: Browser::Chrome,
            extension_id: None,
            install_dir: None,
            manifest_dir: None,
        };
        let mut seen = BTreeSet::new();
        let mut arguments = arguments.iter();
        while let Some(flag) = arguments.next() {
            ensure!(seen.insert(flag), "duplicate option {flag}");
            let value = arguments
                .next()
                .with_context(|| format!("missing value for {flag}"))?;
            match flag.as_str() {
                "--browser" => result.browser = Browser::parse(value)?,
                "--extension-id" => {
                    validate_extension_id(value)?;
                    result.extension_id = Some(value.clone());
                }
                "--install-dir" => result.install_dir = Some(absolute(value)?),
                "--manifest-dir" => result.manifest_dir = Some(absolute(value)?),
                _ => bail!("unknown option {flag}; run host-terminal --help"),
            }
        }
        Ok(result)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostConfig {
    #[serde(default = "schema_version")]
    schema_version: u32,
    pub(crate) allowed_origins: Vec<String>,
    #[serde(default)]
    registrations: Vec<Registration>,
}

fn schema_version() -> u32 {
    1
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            allowed_origins: Vec::new(),
            registrations: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Registration {
    browser: String,
    manifest_path: PathBuf,
    allowed_origins: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct NativeManifest {
    name: String,
    description: String,
    path: PathBuf,
    #[serde(rename = "type")]
    transport: String,
    allowed_origins: Vec<String>,
}

pub(crate) fn read_host_config(path: &Path) -> Result<HostConfig> {
    let config: HostConfig = read_json(path).with_context(|| {
        format!(
            "read native host configuration at {}; run install first",
            path.display()
        )
    })?;
    ensure!(
        config.schema_version == 1,
        "unsupported host configuration schema {}",
        config.schema_version
    );
    ensure!(
        config.allowed_origins.len() <= 128 && config.registrations.len() <= 128,
        "host configuration has too many entries"
    );
    for origin in &config.allowed_origins {
        validate_origin(origin)?;
    }
    for registration in &config.registrations {
        Browser::parse(&registration.browser)?;
        ensure!(
            registration.manifest_path.is_absolute(),
            "registration path must be absolute"
        );
        for origin in &registration.allowed_origins {
            validate_origin(origin)?;
        }
    }
    Ok(config)
}

pub(crate) fn run_cli(arguments: &[String]) -> Result<()> {
    let Some(command) = arguments.first().map(String::as_str) else {
        print_help();
        return Ok(());
    };
    if matches!(command, "--help" | "-h" | "help") {
        print_help();
        return Ok(());
    }
    if matches!(command, "--version" | "-V" | "version") {
        println!("Host Terminal {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    ensure!(
        matches!(command, "install" | "uninstall" | "doctor"),
        "unknown command {command:?}; run host-terminal --help"
    );
    if arguments[1..]
        .iter()
        .any(|value| value == "--help" || value == "-h")
    {
        print_help();
        return Ok(());
    }
    let options = Options::parse(&arguments[1..])?;
    let install_dir = match &options.install_dir {
        Some(path) => path.clone(),
        None => default_install_dir()?,
    };
    let executable = install_dir.join(executable_name());
    let manifest = manifest_path(&options, &install_dir)?;
    match command {
        "install" => install(&options, &install_dir, &executable, &manifest),
        "uninstall" => uninstall(&options, &install_dir, &executable, &manifest),
        "doctor" => doctor(&options, &install_dir, &executable, &manifest),
        _ => unreachable!(),
    }
}

fn install(
    options: &Options,
    install_dir: &Path,
    executable: &Path,
    manifest_path: &Path,
) -> Result<()> {
    let extension_id = options.extension_id.as_deref().context(
        "install requires --extension-id; copy the 32-letter ID from chrome://extensions",
    )?;
    ensure_private_dir(install_dir)?;
    let _lock = InstallLock::acquire(install_dir)?;
    let config_path = install_dir.join(CONFIG_NAME);
    let has_config = config_path.exists();
    let mut config = if has_config {
        read_host_config(&config_path)?
    } else {
        HostConfig::default()
    };
    if executable.exists() && !has_config {
        ensure!(
            fs::canonicalize(executable)? == fs::canonicalize(std::env::current_exe()?)?,
            "refusing to replace an unregistered executable at {}; choose another --install-dir",
            executable.display()
        );
    }
    let origin = format!("chrome-extension://{extension_id}/");
    let mut origins = BTreeSet::new();
    if manifest_path.exists() {
        let existing = read_owned_manifest(manifest_path, executable)?;
        origins.extend(existing.allowed_origins);
    }
    origins.insert(origin.clone());
    let manifest = NativeManifest {
        name: HOST_NAME.into(),
        description: "Host Terminal native PTY companion".into(),
        path: executable.to_owned(),
        transport: "stdio".into(),
        allowed_origins: origins.into_iter().collect(),
    };
    if let Some(registration) = config
        .registrations
        .iter_mut()
        .find(|entry| entry.manifest_path == manifest_path)
    {
        registration.allowed_origins = manifest.allowed_origins.clone();
    } else {
        config.registrations.push(Registration {
            browser: options.browser.name().into(),
            manifest_path: manifest_path.to_owned(),
            allowed_origins: manifest.allowed_origins.clone(),
        });
    }
    config.allowed_origins.push(origin);
    config.allowed_origins.extend(
        config
            .registrations
            .iter()
            .flat_map(|entry| entry.allowed_origins.iter().cloned()),
    );
    config.allowed_origins.sort();
    config.allowed_origins.dedup();
    ensure!(
        config.allowed_origins.len() <= 128 && config.registrations.len() <= 128,
        "installation would exceed the 128-origin/registration limit"
    );
    let current_exe = std::env::current_exe().context("locate source executable")?;
    copy_executable(&current_exe, executable)?;
    atomic_json(&config_path, &config)?;
    atomic_json(manifest_path, &manifest)?;
    register_browser(options.browser, manifest_path)?;
    println!("Installed Host Terminal for {}.", options.browser.name());
    println!("Executable: {}", executable.display());
    println!("Manifest:   {}", manifest_path.display());
    println!("Authorized: {}", manifest.allowed_origins.join(", "));
    println!("Open the extension and choose Connect. No administrator permission is required.");
    Ok(())
}

fn uninstall(
    options: &Options,
    install_dir: &Path,
    executable: &Path,
    manifest_path: &Path,
) -> Result<()> {
    if !install_dir.exists() {
        println!(
            "Host Terminal is not installed at {}.",
            install_dir.display()
        );
        return Ok(());
    }
    let _lock = InstallLock::acquire(install_dir)?;
    let config_path = install_dir.join(CONFIG_NAME);
    let mut config = read_host_config(&config_path)?;
    let remove_origin = options
        .extension_id
        .as_ref()
        .map(|id| format!("chrome-extension://{id}/"));
    let mut manifest = if manifest_path.exists() {
        Some(read_owned_manifest(manifest_path, executable)?)
    } else {
        None
    };
    if let (Some(origin), Some(manifest)) = (&remove_origin, &mut manifest) {
        manifest.allowed_origins.retain(|entry| entry != origin);
    }
    let remove_registration = remove_origin.is_none()
        || manifest
            .as_ref()
            .is_none_or(|value| value.allowed_origins.is_empty());
    if remove_registration {
        unregister_browser(options.browser, manifest_path)?;
        if manifest_path.exists() {
            fs::remove_file(manifest_path).context("remove native host manifest")?;
        }
        config
            .registrations
            .retain(|entry| entry.manifest_path != manifest_path);
    } else if let Some(manifest) = manifest {
        atomic_json(manifest_path, &manifest)?;
        if let Some(registration) = config
            .registrations
            .iter_mut()
            .find(|entry| entry.manifest_path == manifest_path)
        {
            registration.allowed_origins = manifest.allowed_origins;
        }
    }
    // Recompute authority from remaining browser registrations. Removing the last
    // registration leaves an inert installed binary with no allowed origins.
    config.allowed_origins = config
        .registrations
        .iter()
        .flat_map(|entry| entry.allowed_origins.iter().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    atomic_json(&config_path, &config)?;
    println!(
        "Removed {} registration{}.",
        options.browser.name(),
        remove_origin
            .as_ref()
            .map(|origin| format!(" for {origin}"))
            .unwrap_or_default()
    );
    println!("Existing sessions end when their native connection closes. Use Disconnect all in the extension or quit Chrome to end them now.");
    if config.registrations.is_empty() {
        println!("No extensions remain authorized. The executable and configuration remain at {} so this running uninstaller can exit normally. You may remove that directory after closing browsers.", install_dir.display());
    }
    Ok(())
}

fn doctor(
    options: &Options,
    install_dir: &Path,
    executable: &Path,
    manifest_path: &Path,
) -> Result<()> {
    println!(
        "Host Terminal {} / {} / {}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    println!("Checking {} registration", options.browser.name());
    println!("Executable: {}", executable.display());
    ensure!(
        executable.is_file(),
        "native executable is missing; run install"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            fs::metadata(executable)?.permissions().mode() & 0o111 != 0,
            "native executable has no execute permission"
        );
    }
    let config = read_host_config(&install_dir.join(CONFIG_NAME))?;
    let manifest = read_owned_manifest(manifest_path, executable)?;
    ensure!(
        !manifest.allowed_origins.is_empty(),
        "native manifest authorizes no extensions"
    );
    for origin in &manifest.allowed_origins {
        ensure!(config.allowed_origins.contains(origin), "{origin} is present in the browser manifest but absent from host-config.json; rerun install");
    }
    if let Some(id) = &options.extension_id {
        let origin = format!("chrome-extension://{id}/");
        ensure!(
            manifest.allowed_origins.contains(&origin),
            "extension {id} is not authorized for this browser; rerun install --extension-id {id}"
        );
    }
    verify_registration(options.browser, manifest_path)?;
    println!("Manifest:   {}", manifest_path.display());
    println!("Authorized: {}", manifest.allowed_origins.join(", "));
    println!("Local configuration is consistent. Browser policy and a live PTY handshake are checked when you connect the extension.");
    Ok(())
}

fn validate_extension_id(id: &str) -> Result<()> {
    ensure!(
        id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)),
        "extension ID must contain exactly 32 lowercase letters a–p"
    );
    Ok(())
}

fn validate_origin(origin: &str) -> Result<()> {
    let id = origin
        .strip_prefix("chrome-extension://")
        .and_then(|value| value.strip_suffix('/'))
        .context("invalid native host allowed origin")?;
    validate_extension_id(id)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    ensure_regular_file(path)?;
    let file = File::open(path)?;
    ensure!(
        file.metadata()?.len() <= MAX_CONFIG_BYTES,
        "configuration exceeds 1 MiB"
    );
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_CONFIG_BYTES as usize,
        "configuration exceeds 1 MiB"
    );
    Ok(serde_json::from_slice(&bytes)?)
}

fn read_owned_manifest(path: &Path, executable: &Path) -> Result<NativeManifest> {
    let manifest: NativeManifest =
        read_json(path).with_context(|| format!("read manifest {}", path.display()))?;
    ensure!(
        manifest.name == HOST_NAME && manifest.transport == "stdio" && manifest.path == executable,
        "refusing to change {}; it does not belong to this Host Terminal installation",
        path.display()
    );
    for origin in &manifest.allowed_origins {
        validate_origin(origin)?;
    }
    Ok(manifest)
}

fn ensure_regular_file(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "expected a regular non-symlink file: {}",
        path.display()
    );
    Ok(())
}

fn ensure_private_dir(path: &Path) -> Result<()> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path)?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "expected a non-symlink installation directory: {}",
            path.display()
        );
    } else {
        fs::create_dir_all(path).with_context(|| format!("create directory {}", path.display()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn atomic_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    atomic_write(path, &bytes, false)
}

fn atomic_write(path: &Path, bytes: &[u8], executable: bool) -> Result<()> {
    let parent = path.parent().context("file has no parent directory")?;
    fs::create_dir_all(parent)?;
    if path.exists() {
        ensure_regular_file(path)?;
    }
    let temp = temp_path(path);
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(if executable { 0o700 } else { 0o600 });
        }
        #[cfg(not(unix))]
        let _ = executable;
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path).with_context(|| {
            format!(
                "replace {}; close Chrome/Host Terminal before updating a locked executable",
                path.display()
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn copy_executable(source: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        ensure_regular_file(destination)?;
        if fs::canonicalize(source)? == fs::canonicalize(destination)? {
            return Ok(());
        }
    }
    // The binary is bounded by its own build artifact, so buffering simplifies
    // a same-directory atomic replacement on every supported operating system.
    atomic_write(
        destination,
        &fs::read(source).context("read running executable")?,
        true,
    )
}

fn temp_path(path: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    path.with_file_name(format!(
        ".{}.{}.{stamp}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ))
}

struct InstallLock {
    path: PathBuf,
}
impl InstallLock {
    fn acquire(directory: &Path) -> Result<Self> {
        let path = directory.join(".install-lock");
        let mut file = OpenOptions::new().write(true).create_new(true).open(&path).with_context(|| format!("another installation is active, or a stale lock exists at {}; remove a stale lock only after confirming no installer is running", path.display()))?;
        writeln!(file, "{}", std::process::id())?;
        Ok(Self { path })
    }
}
impl Drop for InstallLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn absolute(value: impl AsRef<Path>) -> Result<PathBuf> {
    let value = value.as_ref();
    let path = if value.is_absolute() {
        value.to_owned()
    } else {
        std::env::current_dir()?.join(value)
    };
    ensure!(
        !path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir)),
        "paths containing '..' are not supported; provide an absolute normalized path"
    );
    Ok(path)
}

#[cfg(not(target_os = "windows"))]
fn home_dir() -> Result<PathBuf> {
    let variable = "HOME";
    let value = std::env::var_os(variable).with_context(|| format!("{variable} is not set"))?;
    let path = PathBuf::from(value);
    ensure!(path.is_absolute(), "{variable} must be absolute");
    Ok(path)
}

fn default_install_dir() -> Result<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let root = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .context("LOCALAPPDATA is not set")?;
        ensure!(root.is_absolute(), "LOCALAPPDATA must be absolute");
        Ok(root.join("HostTerminal"))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(home_dir()?.join("Library/Application Support/Host Terminal"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let root = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or(home_dir()?.join(".local/share"));
        Ok(root.join("host-terminal"))
    }
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "host-terminal.exe"
    } else {
        "host-terminal"
    }
}

fn manifest_path(options: &Options, install_dir: &Path) -> Result<PathBuf> {
    if let Some(directory) = &options.manifest_dir {
        return Ok(directory.join(format!("{HOST_NAME}.json")));
    }
    #[cfg(target_os = "windows")]
    {
        Ok(install_dir.join(format!(
            "native-host-{}.json",
            options.browser.registration_family()
        )))
    }
    #[cfg(target_os = "macos")]
    {
        let _ = install_dir;
        let browser = match options.browser {
            Browser::Chrome => "Google/Chrome",
            Browser::Chromium => "Chromium",
            Browser::Edge => "Microsoft Edge",
            Browser::Brave => "BraveSoftware/Brave-Browser",
            Browser::ChromeForTesting => "Google/ChromeForTesting",
        };
        Ok(home_dir()?
            .join("Library/Application Support")
            .join(browser)
            .join("NativeMessagingHosts")
            .join(format!("{HOST_NAME}.json")))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = install_dir;
        let root = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or(home_dir()?.join(".config"));
        let browser = match options.browser {
            Browser::Chrome => "google-chrome",
            Browser::Chromium => "chromium",
            Browser::Edge => "microsoft-edge",
            Browser::Brave => "BraveSoftware/Brave-Browser",
            Browser::ChromeForTesting => "google-chrome-for-testing",
        };
        Ok(root
            .join(browser)
            .join("NativeMessagingHosts")
            .join(format!("{HOST_NAME}.json")))
    }
}

#[cfg(target_os = "windows")]
fn registry_value(browser: Browser) -> Result<Option<PathBuf>> {
    use winreg::{
        enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WOW64_32KEY},
        RegKey,
    };
    let key = match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(browser.registry_key(), KEY_READ | KEY_WOW64_32KEY)
    {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("query per-user native host registry key"),
    };
    match key.get_value::<String, _>("") {
        Ok(value) => Ok(Some(PathBuf::from(value))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).context("read per-user native host registry value"),
    }
}

#[cfg(target_os = "windows")]
fn register_browser(browser: Browser, manifest_path: &Path) -> Result<()> {
    use winreg::{
        enums::{HKEY_CURRENT_USER, KEY_WOW64_32KEY, KEY_WRITE},
        RegKey,
    };
    if let Some(existing) = registry_value(browser)? {
        ensure!(
            existing == manifest_path,
            "refusing to replace an unrelated registration pointing to {}",
            existing.display()
        );
    }
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey_with_flags(browser.registry_key(), KEY_WRITE | KEY_WOW64_32KEY)
        .context("create per-user native host registry key")?;
    let value = manifest_path
        .to_str()
        .context("manifest path is not valid Unicode")?;
    key.set_value("", &value)
        .context("register per-user native host manifest")?;
    Ok(())
}
#[cfg(not(target_os = "windows"))]
fn register_browser(_browser: Browser, _manifest_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn unregister_browser(browser: Browser, manifest_path: &Path) -> Result<()> {
    use winreg::{
        enums::{HKEY_CURRENT_USER, KEY_WOW64_32KEY},
        RegKey,
    };
    if let Some(existing) = registry_value(browser)? {
        ensure!(
            existing == manifest_path,
            "refusing to remove an unrelated registry entry pointing to {}",
            existing.display()
        );
        RegKey::predef(HKEY_CURRENT_USER)
            .delete_subkey_with_flags(browser.registry_key(), KEY_WOW64_32KEY)
            .context("remove per-user native host registry key")?;
    }
    Ok(())
}
#[cfg(not(target_os = "windows"))]
fn unregister_browser(_browser: Browser, _manifest_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn verify_registration(browser: Browser, manifest_path: &Path) -> Result<()> {
    ensure!(
        registry_value(browser)?.as_deref() == Some(manifest_path),
        "per-user native messaging registry key is missing or points elsewhere; run install"
    );
    Ok(())
}
#[cfg(not(target_os = "windows"))]
fn verify_registration(_browser: Browser, _manifest_path: &Path) -> Result<()> {
    Ok(())
}

fn print_help() {
    println!("Host Terminal {}\n\nUsage:\n  host-terminal install --extension-id ID [OPTIONS]\n  host-terminal doctor [--extension-id ID] [OPTIONS]\n  host-terminal uninstall [--extension-id ID] [OPTIONS]\n  host-terminal --version\n\nOptions:\n  --browser NAME       chrome (default), chromium, edge, brave, chrome-for-testing\n  --install-dir PATH   Override the per-user native companion directory\n  --manifest-dir PATH  Override the browser's NativeMessagingHosts directory\n\nInstallation authorizes the exact extension ID for the current user. Repeating install\nadds another authorized ID. Uninstall with an ID revokes that ID for the selected\nbrowser; without one it removes that browser registration. No system-wide settings\nor administrator permissions are used. Close active sessions before updating.\n\nWindows: Chrome, Brave and Chrome for Testing use the common Chrome compatibility\nregistration; uninstalling this registration affects all three. A custom manifest\ndirectory on Windows still registers its path under the current user's registry.\n\nFor a custom Chrome --user-data-dir, pass its NativeMessagingHosts subdirectory\nas --manifest-dir on Linux/macOS. Run doctor with the same override options.", env!("CARGO_PKG_VERSION"));
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary(name: &str) -> PathBuf {
        let path = temp_path(&std::env::temp_dir().join(name));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn exact_extension_identity_only() {
        assert!(validate_extension_id("abcdefghijklmnopabcdefghijklmnop").is_ok());
        for id in [
            "",
            "*",
            "abcdefghijklmnopabcdefghijklmnop/",
            "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",
            "qrstuvwxyzabcdefabcdefghijklmnop",
        ] {
            assert!(validate_extension_id(id).is_err(), "{id}");
        }
        assert!(validate_origin("chrome-extension://abcdefghijklmnopabcdefghijklmnop/").is_ok());
        assert!(validate_origin("https://abcdefghijklmnopabcdefghijklmnop/").is_err());
    }

    #[test]
    fn options_reject_ambiguity_and_traversal() {
        assert!(Options::parse(&["--extension-id".into()]).is_err());
        assert!(Options::parse(&[
            "--browser".into(),
            "chrome".into(),
            "--browser".into(),
            "edge".into()
        ])
        .is_err());
        assert!(absolute("something/../elsewhere").is_err());
    }

    #[test]
    fn atomic_json_round_trip_preserves_unusual_paths_and_origins() {
        let dir = temporary("host-terminal-installer-json");
        let path = dir.join("host-config.json");
        let config = HostConfig {
            allowed_origins: vec!["chrome-extension://abcdefghijklmnopabcdefghijklmnop/".into()],
            ..Default::default()
        };
        atomic_json(&path, &config).unwrap();
        assert_eq!(
            read_host_config(&path).unwrap().allowed_origins,
            config.allowed_origins
        );
        let manifest = NativeManifest {
            name: HOST_NAME.into(),
            description: "Quoted \"name\"".into(),
            path: dir.join("space and Łódź").join(executable_name()),
            transport: "stdio".into(),
            allowed_origins: config.allowed_origins,
        };
        let manifest_path = dir.join("manifest.json");
        atomic_json(&manifest_path, &manifest).unwrap();
        assert_eq!(
            read_owned_manifest(&manifest_path, &manifest.path)
                .unwrap()
                .path,
            manifest.path
        );
        assert!(read_owned_manifest(&manifest_path, &dir.join("another-executable")).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn installer_lock_is_exclusive_and_released() {
        let dir = temporary("host-terminal-installer-lock");
        let lock = InstallLock::acquire(&dir).unwrap();
        assert!(InstallLock::acquire(&dir).is_err());
        drop(lock);
        drop(InstallLock::acquire(&dir).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn replacement_refuses_symlinks() {
        let dir = temporary("host-terminal-installer-symlink");
        let actual = dir.join("actual");
        fs::write(&actual, "preserved").unwrap();
        let link = dir.join("link");
        std::os::unix::fs::symlink(&actual, &link).unwrap();
        assert!(atomic_write(&link, b"replacement", false).is_err());
        assert_eq!(fs::read_to_string(actual).unwrap(), "preserved");
        fs::remove_dir_all(dir).unwrap();
    }
}
