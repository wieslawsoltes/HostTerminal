mod install;

use anyhow::{bail, Context, Result};

fn main() {
    if let Err(error) = execute() {
        // stdout belongs exclusively to the framed protocol in native mode.
        eprintln!("Host Terminal: {error:#}");
        std::process::exit(1);
    }
}

fn execute() -> Result<()> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if let Some(origin) = arguments
        .first()
        .filter(|arg| arg.starts_with("chrome-extension://"))
    {
        for argument in &arguments[1..] {
            let valid_parent = argument
                .strip_prefix("--parent-window=")
                .is_some_and(|value| {
                    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
                });
            if !valid_parent {
                bail!("unexpected native-host argument");
            }
        }
        let executable = std::env::current_exe().context("locate installed executable")?;
        let config = install::read_host_config(
            &executable
                .parent()
                .context("executable has no parent directory")?
                .join("host-config.json"),
        )?;
        return terminal_host::run(origin, &config.allowed_origins);
    }
    install::run_cli(&arguments)
}
