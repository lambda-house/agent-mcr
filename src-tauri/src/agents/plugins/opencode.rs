#[cfg(any(unix, test))]
use super::cli_prompt;
#[cfg(any(unix, test))]
use super::super::sh;
use super::super::{Adapter, Launch, Profile};

pub struct OpenCode;

impl Adapter for OpenCode {
    // shortcut: task tracking stays off until this adapter reports turn-end hooks.
    // at_prompt keeps the default (false): its menus are not known yet, so no inbox notice is typed.
    fn profile(&self) -> Profile {
        Profile { id: "opencode", label: "OpenCode", command: "opencode", optional: true, can_supervise: true, task_tracking: false }
    }
    #[cfg(any(unix, test))]
    fn command_line(&self, base: &str, l: &Launch) -> Result<String, String> {
        // A private server keeps CLI-tool process ancestry inside this hosted session.
        let mut cmd = format!("exec {base} --standalone");
        if let Some(id) = l.resume { cmd += &format!(" --session {}", sh(id)); }
        if let Some(t) = cli_prompt(l) { cmd += &format!(" --prompt {}", sh(&t)); }
        Ok(cmd)
    }
}

