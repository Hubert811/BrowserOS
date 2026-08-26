//! P3-6 (T1 甲-1) — provision the hub CLI from the version dir into the
//! user's home directory.
//!
//! The fork ships a self-contained hub distribution inside the server's
//! version directory (`resources/hub/`: vendored bun-runtime + release
//! payload + preinstalled node_modules — layout verified by the 2026-08-26
//! bun-compile spike). Nothing is copied out of it: this module only writes
//! a thin `~/.hub/bin/hub` wrapper that points INTO the version dir, so the
//! browser and hub upgrade together and both revert together on an official
//! auto-update (the known T1 window).
//!
//! Idempotent: a fingerprint file (`~/.hub/installed-hub.json`) records the
//! source version dir; unchanged fingerprint ⇒ no-op. Any failure degrades
//! silently — provisioning must never block or break server startup.

use std::fs;
use std::path::{Path, PathBuf};

use tracing::{info, warn};

/// Fingerprint written next to the wrapper; records the provisioned source
/// so restarts with the same version dir are a no-op and version changes
/// rewrite the wrapper.
const FINGERPRINT_NAME: &str = "installed-hub.json";

/// Outcome of a provision pass, for logging and tests.
#[derive(Debug, PartialEq, Eq)]
pub enum ProvisionOutcome {
    /// The version dir carries no hub distribution — vanilla build or a
    /// hub-less fork; nothing to do.
    NotShipped,
    /// Wrapper + fingerprint already match this version dir.
    UpToDate,
    /// Wrapper (and fingerprint) were (re)written.
    Provisioned,
    /// Expected shape is missing inside resources/hub (incomplete ship).
    /// Degrades silently; server keeps running.
    Incomplete,
}

/// Provisions `~/.hub/bin/hub` for the hub distribution that ships next to
/// `server_exe`. `home_dir` is injected for tests.
pub fn provision(server_exe: &Path, home_dir: &Path) -> ProvisionOutcome {
    let Some(hub_dir) = hub_dir_for(server_exe) else {
        return ProvisionOutcome::NotShipped;
    };
    if !hub_entry(&hub_dir).is_file() || !bun_runtime(&hub_dir).is_file() {
        return ProvisionOutcome::Incomplete;
    }

    let hub_root = hub_root_for(home_dir);
    let wrapper = wrapper_path(&hub_root);
    let fingerprint = hub_root.join(FINGERPRINT_NAME);

    let desired_wrapper = wrapper_content(&hub_dir);
    let desired_fingerprint = fingerprint_content(&hub_dir);

    let up_to_date = read_if_file(&wrapper).as_deref() == Some(desired_wrapper.as_str())
        && read_if_file(&fingerprint).as_deref() == Some(desired_fingerprint.as_str());
    if up_to_date {
        return ProvisionOutcome::UpToDate;
    }

    if let Err(error) = write_provision(
        &hub_root,
        &wrapper,
        &desired_wrapper,
        &fingerprint,
        &desired_fingerprint,
    ) {
        warn!(%error, hub_root = %hub_root.display(), "hub provision failed; hub stays unavailable");
        return ProvisionOutcome::Incomplete;
    }
    info!(hub_dir = %hub_dir.display(), "hub provisioned to ~/.hub/bin/hub");
    ProvisionOutcome::Provisioned
}

/// Resolves `<version dir>/resources/hub` from the running server binary,
/// tolerating dev `target/` invocations (no version dir ⇒ None).
fn hub_dir_for(server_exe: &Path) -> Option<PathBuf> {
    // exe …/versions/<ver>/resources/bin/browseros-claw-server(-rs)
    let bin = server_exe.parent()?;
    let resources = bin.parent()?;
    if resources.file_name()?.to_str()? != "resources" {
        return None;
    }
    let hub = resources.join("hub");
    fs::metadata(&hub).ok().map(|_| hub)
}

fn hub_entry(hub_dir: &Path) -> PathBuf {
    hub_dir.join("bin").join("hub.mjs")
}

fn bun_runtime(hub_dir: &Path) -> PathBuf {
    hub_dir.join("bin").join("bun-runtime")
}

fn hub_root_for(home_dir: &Path) -> PathBuf {
    home_dir.join(".hub")
}

fn wrapper_path(hub_root: &Path) -> PathBuf {
    hub_root.join("bin").join(wrapper_name())
}

/// `hub` (sh) on unix, `hub.cmd` on windows — both exec the vendored
/// bun-runtime against the shipped entry, so the layout self-bootstraps
/// with zero assumptions about the installing machine.
fn wrapper_name() -> &'static str {
    if cfg!(windows) {
        "hub.cmd"
    } else {
        "hub"
    }
}

fn wrapper_content(hub_dir: &Path) -> String {
    let bun = bun_runtime(hub_dir);
    let entry = hub_entry(hub_dir);
    if cfg!(windows) {
        format!(
            "@echo off\r\n\"{}\" \"{}\" %*\r\n",
            bun.display(),
            entry.display()
        )
    } else {
        format!(
            "#!/bin/sh\nexec \"{}\" \"{}\" \"$@\"\n",
            bun.display(),
            entry.display()
        )
    }
}

fn fingerprint_content(hub_dir: &Path) -> String {
    let source = hub_dir.display().to_string();
    format!("{{\"sourceDir\":{}}}\n", serde_json::to_string(&source).expect("path is valid JSON"))
}

fn read_if_file(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

fn write_provision(
    hub_root: &Path,
    wrapper: &Path,
    wrapper_content: &str,
    fingerprint: &Path,
    fingerprint_content: &str,
) -> std::io::Result<()> {
    fs::create_dir_all(hub_root.join("bin"))?;
    fs::write(wrapper, wrapper_content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(wrapper)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(wrapper, perms)?;
    }
    fs::write(fingerprint, fingerprint_content)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        fs::write(path, b"stub").expect("write stub");
    }

    fn fake_version_dir(root: &Path, with_hub: bool) -> PathBuf {
        let bin = root.join("versions/0.0.44/resources/bin");
        if with_hub {
            touch(&bin.join("browseros-claw-server"));
            touch(&bin.parent().unwrap().join("hub/bin/hub.mjs"));
            touch(&bin.parent().unwrap().join("hub/bin/bun-runtime"));
        } else {
            touch(&bin.join("browseros-claw-server"));
        }
        bin.join("browseros-claw-server")
    }

    #[test]
    fn vanilla_build_without_hub_is_not_shipped() {
        let root = std::env::temp_dir().join(format!("hubprov-{:x}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let exe = fake_version_dir(&root, false);
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");

        assert_eq!(provision(&exe, &home), ProvisionOutcome::NotShipped);
        assert!(!home.join(".hub").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn provisions_wrapper_and_fingerprint_then_is_idempotent() {
        let root = std::env::temp_dir().join(format!("hubprov-idem-{:x}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let exe = fake_version_dir(&root, true);
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");

        assert_eq!(provision(&exe, &home), ProvisionOutcome::Provisioned);
        let hub_root = home.join(".hub");
        let wrapper = hub_root.join("bin").join(wrapper_name());
        let content = fs::read_to_string(&wrapper).expect("wrapper written");
        assert!(content.contains("bun-runtime"));
        assert!(content.contains("hub.mjs"));
        assert!(hub_root.join(FINGERPRINT_NAME).exists());

        // Second pass with the same version dir: no-op.
        assert_eq!(provision(&exe, &home), ProvisionOutcome::UpToDate);

        // A new version dir rewrites the wrapper (simulated upgrade).
        let upgraded_exe = {
            let bin = root.join("versions/0.0.45/resources/bin");
            touch(&bin.join("browseros-claw-server"));
            touch(&bin.parent().unwrap().join("hub/bin/hub.mjs"));
            touch(&bin.parent().unwrap().join("hub/bin/bun-runtime"));
            bin.join("browseros-claw-server")
        };
        assert_eq!(provision(&upgraded_exe, &home), ProvisionOutcome::Provisioned);
        let rewritten = fs::read_to_string(&wrapper).expect("wrapper rewritten");
        assert!(rewritten.contains("0.0.45"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn incomplete_distribution_degrades_silently() {
        let root = std::env::temp_dir().join(format!("hubprov-inc-{:x}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        // hub/ exists but lacks bun-runtime.
        let exe = {
            let bin = root.join("versions/0.0.44/resources/bin");
            touch(&bin.join("browseros-claw-server"));
            touch(&bin.parent().unwrap().join("hub/bin/hub.mjs"));
            bin.join("browseros-claw-server")
        };
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");

        assert_eq!(provision(&exe, &home), ProvisionOutcome::Incomplete);
        assert!(!home.join(".hub/bin").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dev_target_invocation_is_not_shipped() {
        let root = std::env::temp_dir().join(format!("hubprov-dev-{:x}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let exe = root.join("target/release/browseros-claw-server-rs");
        touch(&exe);
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");

        assert_eq!(provision(&exe, &home), ProvisionOutcome::NotShipped);
        let _ = fs::remove_dir_all(&root);
    }
}
