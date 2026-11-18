use super::cli_prompt;
use super::super::{sh, Adapter, Launch, Profile, Interrupt};

pub struct Antigravity;

impl Adapter for Antigravity {
    // shortcut: task tracking stays off until this adapter reports turn-end hooks.
    fn profile(&self) -> Profile {
        Profile { id: "antigravity", label: "Antigravity", command: "agy --mode accept-edits", optional: true, can_supervise: true, task_tracking: false }
    }
    fn command_line(&self, base: &str, l: &Launch) -> Result<String, String> {
        let mut cmd = format!("exec {base}");
        if let Some(id) = l.resume {
            cmd += &format!(" --conversation {id}");
        }
        if let Some(t) = cli_prompt(l) {
            cmd += &format!(" --prompt-interactive {}", sh(&t));
        }
        Ok(cmd)
    }
    /// Its status line says "? for shortcuts" only at the input box: a turn
    /// shows "esc to cancel", and menus (folder trust, permissions) "enter Confirm"
    fn at_prompt(&self, screen: &str) -> bool {
        screen.contains("? for shortcuts") && !screen.contains("esc to cancel") && !screen.contains("enter Confirm")
    }
    fn interrupt(&self) -> Interrupt {
        Interrupt::Key("\x1b")
    }
}

