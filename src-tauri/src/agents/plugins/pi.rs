#[cfg(any(unix, test))]
use super::cli_note;
#[cfg(any(unix, test))]
use super::super::sh;
use super::super::{Adapter, Launch, Profile, Interrupt};

pub struct Pi;

impl Adapter for Pi {
    // shortcut: task tracking stays off until this adapter reports turn-end hooks.
    // at_prompt keeps the default (false): its menus are not known yet, so no inbox notice is typed.
    fn profile(&self) -> Profile {
        Profile { id: "pi", label: "Pi", command: "pi", optional: true, can_supervise: true, task_tracking: false }
    }
    #[cfg(any(unix, test))]
    fn command_line(&self, base: &str, l: &Launch) -> Result<String, String> {
        let mut cmd = format!("exec {base}");
        if l.note { cmd += &format!(" --append-system-prompt {}", sh(&cli_note(l))); }
        if let Some(id) = l.resume { cmd += &format!(" --session {}", sh(id)); }
        if let Some(t) = l.task { cmd += &format!(" {}", sh(&format!("Task:\n{t}"))); }
        Ok(cmd)
    }
    fn interrupt(&self) -> Interrupt { Interrupt::Key("\x1b") }
}

