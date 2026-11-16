//! Trusted, bundled harness plugins. Register optional adapters here; never load code from project UI plugins.

mod antigravity;
mod pi;
mod opencode;

use super::{Adapter, Launch};
#[cfg(any(unix, test))]
use super::{sh, PEER_NOTE};

pub const PLUGINS: &[&dyn Adapter] = &[&antigravity::Antigravity, &pi::Pi, &opencode::OpenCode];

/// CLI access preserves the service's process-ancestry authorization, without changing user MCP config.
#[cfg(any(unix, test))]
fn cli_note(l: &Launch) -> String {
    let exe = sh(l.exe);
    let mut note = format!("{PEER_NOTE}\nUse the shell to call Agent MCR tools: {exe} --harness-tool <name> '<JSON object>'. Read {exe} --harness-tool guide and {exe} --harness-tool tools_list for instructions and schemas.");
    if l.supervisor {
        note += &format!("\nYou are the Supervisor. Read {exe} --supervisor-tool tools_list for your management tools. Call them with {exe} --supervisor-tool <name> '<JSON object>'. Raw terminal_write is unavailable through this CLI: ask the operator to use the terminal. Never answer another session's permission prompts; only the operator may do that.");
    }
    note
}

#[cfg(any(unix, test))]
fn cli_prompt(l: &Launch) -> Option<String> {
    match (l.note, l.task) {
        (true, task) => Some(format!("{}\n{}", cli_note(l), task.unwrap_or("Read the harness guide, then wait for the operator's task."))),
        (false, task) => task.map(str::to_string),
    }
}

