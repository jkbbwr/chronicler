//! Outside programs Chronicler runs: jj (history) and typst (compiling).
//! Found on PATH unless the writer points at them in Settings; the paths
//! are app-wide, in `tools.json` beside the other app settings.

use anyhow::{Context, Result};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::LazyLock;
use ts_rs::TS;

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    Jj,
    Typst,
}

impl Tool {
    pub fn name(self) -> &'static str {
        match self {
            Tool::Jj => "jj",
            Tool::Typst => "typst",
        }
    }
}

/// Where to find each program ("" = on PATH).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct ToolPaths {
    pub jj: String,
    pub typst: String,
}

impl ToolPaths {
    fn get(&self, tool: Tool) -> &str {
        match tool {
            Tool::Jj => &self.jj,
            Tool::Typst => &self.typst,
        }
    }
}

fn config_file() -> PathBuf {
    crate::ai::config_dir().join("tools.json")
}

static PATHS: LazyLock<RwLock<ToolPaths>> = LazyLock::new(|| {
    let paths = std::fs::read_to_string(config_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    RwLock::new(paths)
});

pub fn paths() -> ToolPaths {
    PATHS.read().clone()
}

pub fn set_paths(paths: ToolPaths) -> Result<()> {
    let dir = crate::ai::config_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let tmp = dir.join(".tools.json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&paths)?)?;
    std::fs::rename(&tmp, config_file())?;
    *PATHS.write() = paths;
    Ok(())
}

/// The program to run: the writer's path, else the bare name (PATH).
pub fn program(tool: Tool) -> PathBuf {
    match PATHS.read().get(tool).trim() {
        "" => tool.name().into(),
        p => expand_home(p),
    }
}

fn expand_home(p: &str) -> PathBuf {
    match (p.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(p),
    }
}

/// `jj 0.41.0-413f…` / `typst 0.14.0 (b33de9de)` → "0.41.0" / "0.14.0";
/// `None` when it can't be run.
pub fn version(tool: Tool) -> Option<String> {
    let out = std::process::Command::new(program(tool)).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let v = text.split_whitespace().nth(1)?;
    Some(v.split('-').next().unwrap_or(v).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_is_expanded() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand_home("~/bin/jj"), PathBuf::from(home).join("bin/jj"));
        assert_eq!(expand_home("/opt/jj"), PathBuf::from("/opt/jj"));
    }
}
