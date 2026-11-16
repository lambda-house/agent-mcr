// Agent MCR - Tauri backend (based on MDViewer)
// Handles file system operations, watching, and configuration

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::http::{Response as HttpResponse, StatusCode};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

mod agent;
#[cfg(unix)]
mod peer;
#[cfg(unix)]
mod runner;
#[cfg(unix)]
mod agents;
mod harness;
#[cfg(unix)]
mod harness_preferences;
#[cfg(unix)]
mod harness_commands;
mod session_analysis;
mod session_analysis_commands;
mod session_mcp;
mod session_commands;
mod session_db;
mod session_memory;
mod sessions;

// ============================================================
// Types
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(rename = "displayPath")]
    pub display_path: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
    #[serde(rename = "isExpanded", skip_serializing_if = "Option::is_none")]
    pub is_expanded: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileChangeEvent {
    pub event_type: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

impl AppError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            details: None,
        }
    }

    fn with_details(code: &str, message: &str, details: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            details: Some(details.to_string()),
        }
    }
}

// ============================================================
// App State
// ============================================================

#[derive(Default)]
pub struct AppState {
    /// Agent files watcher, while the agent workspace is on.
    pub agent_watch: Arc<Mutex<Option<agent::Watch>>>,
}

// ============================================================
// Security: Access List
// ============================================================

/// Folders and files the user opened: picked in the folder or file dialog,
/// dropped on the window, or passed on the command line ("Open with"). Every
/// file command checks its path against this list, and the list is persisted
/// so a restored session keeps working.
///
/// Paths are only ever added from Rust, as a result of a user action. The
/// webview can't add a path by naming it, so a script injected into a document
/// can't read anything the user didn't open.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Access {
    /// Opened folders: documents and images anywhere below them are readable.
    #[serde(default)]
    directories: Vec<PathBuf>,
    /// Opened single files: the file itself, plus images next to/below it.
    #[serde(default)]
    files: Vec<PathBuf>,
    /// Agent workspace turned on: markdown in the agents' own folders
    /// (`agent::is_agent_document`) counts as opened.
    #[serde(default)]
    agent_workspace: bool,
    #[serde(default)]
    session_workspace: bool,
    #[serde(default)]
    session_memories: bool,
    /// Folders agent sessions work in, as the harness and the session index
    /// report them (never the webview). Agent files inside them count as
    /// opened while the agent workspace is on. Not saved: found again at each scan.
    #[serde(skip)]
    session_folders: Vec<PathBuf>,
}

impl Access {
    /// An agent's own document, or an agent file in a folder a session works in.
    fn is_agent_file(&self, path: &Path) -> bool {
        self.agent_workspace
            && (agent::is_agent_document(path)
                || (is_markdown_file(path)
                    && self.session_folders.iter().any(|dir| path.strip_prefix(dir).is_ok_and(agent::is_project_agent_file))))
    }

    fn in_tree(&self, path: &Path) -> bool {
        self.directories.iter().any(|dir| path.starts_with(dir))
    }

    /// Add a canonical path. Returns whether the list changed.
    fn grant(&mut self, path: &Path) -> bool {
        if self.in_tree(path) {
            return false;
        }
        if path.is_dir() {
            // A parent folder replaces the folders and files inside it
            self.directories.retain(|dir| !dir.starts_with(path));
            self.files.retain(|file| !file.starts_with(path));
            self.directories.push(path.to_path_buf());
            true
        } else if path.is_file() && !self.files.iter().any(|file| file == path) {
            self.files.push(path.to_path_buf());
            true
        } else {
            false
        }
    }

    /// Folder listing and watching: only inside opened folders.
    fn can_list(&self, path: &Path) -> bool {
        self.in_tree(path)
    }

    /// Reading or saving a document: an opened file, or a markdown/text file
    /// inside an opened folder (never keys, binaries or dotfiles like .bashrc).
    fn can_open(&self, path: &Path) -> bool {
        self.files.iter().any(|file| file == path)
            || (self.in_tree(path) && is_viewable_file(path, true))
            || self.is_agent_file(path)
    }

    /// Metadata and "reveal in file manager".
    fn can_stat(&self, path: &Path) -> bool {
        self.in_tree(path)
            || self.files.iter().any(|file| file == path)
            || self.is_agent_file(path)
    }

    /// Images referenced by documents (the `localfile://` protocol).
    fn can_read_image(&self, path: &Path) -> bool {
        is_image_file(path)
            && (self.in_tree(path)
                || self.files.iter().any(|file| file.parent().is_some_and(|dir| path.starts_with(dir))))
    }

    fn allows(&self, path: &Path, use_: Use) -> bool {
        match use_ {
            Use::Open => self.can_open(path),
            Use::Stat => self.can_stat(path),
            Use::Image => self.can_read_image(path),
        }
    }
}

/// What a command does with a path, for the access check.
#[derive(Debug, Clone, Copy)]
enum Use {
    Open,
    Stat,
    Image,
}

impl Use {
    /// Whether a symlink's target is the kind of thing this use may reach.
    fn fits_target(self, real: &Path) -> bool {
        match self {
            // Markdown only: config files with tokens are text too (a cloned
            // repo's notes.md may point at ~/.config/gh/hosts.yml)
            Use::Open => real.is_file() && is_markdown_file(real),
            Use::Stat => true,
            Use::Image => real.is_file() && is_image_file(real),
        }
    }
}

/// A path from the frontend: as named (the way the file tree lists it, with
/// symlinks not followed) and where it really is.
#[derive(Debug)]
struct Target {
    named: PathBuf,
    real: PathBuf,
}

/// The access list plus where it is saved.
pub struct AccessState {
    access: Mutex<Access>,
    file: Option<PathBuf>,
}

impl AccessState {
    fn load() -> Self {
        let file = get_config_dir().ok().map(|dir| dir.join("access.json"));
        let saved = file.as_ref().and_then(|f| fs::read(f).ok());
        let access = saved
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            access: Mutex::new(access),
            file,
        }
    }

    /// Allowed when the real path is, or when the path as named is inside an
    /// opened folder and is a symlink there whose target fits the use: a link
    /// in an opened folder is followed like a text editor would, but only to
    /// documents (or images) and never through `..`.
    fn check(&self, target: &Target, use_: Use) -> Result<(), AppError> {
        let access = self.access.lock()
            .map_err(|_| AppError::new("STATE_ERROR", "Failed to access the access list"))?;
        let allowed = access.allows(&target.real, use_)
            || (target.named != target.real
                && access.allows(&target.named, use_)
                && use_.fits_target(&target.real));
        if allowed {
            Ok(())
        } else {
            Err(AppError::with_details(
                "ACCESS_DENIED",
                "Not inside a folder or file you opened",
                &target.named.to_string_lossy(),
            ))
        }
    }

    /// A canonical folder inside one the user opened (hosted terminals start there).
    pub(crate) fn may_list(&self, dir: &Path) -> bool {
        self.access.lock().map(|access| access.can_list(dir)).unwrap_or(false)
    }

    /// Grant user-chosen paths (dialog, drop, command line) and save the list.
    fn grant<P: AsRef<Path>>(&self, paths: impl IntoIterator<Item = P>) {
        let Ok(mut access) = self.access.lock() else { return };
        let mut changed = false;
        for path in paths {
            if let Ok(canonical) = canonicalize(path.as_ref()) {
                changed |= access.grant(&canonical);
            }
        }
        if changed {
            self.save(&access);
        }
    }

    /// Turn the agent workspace on or off and save the list.
    fn set_agent_workspace(&self, enabled: bool) {
        let Ok(mut access) = self.access.lock() else { return };
        if access.agent_workspace != enabled {
            access.agent_workspace = enabled;
            self.save(&access);
        }
    }

    fn agent_workspace_on(&self) -> bool {
        self.access.lock().map(|access| access.agent_workspace).unwrap_or(false)
    }

    /// Replace the session folders (found by `session_folders`, never given by the webview).
    fn set_session_folders(&self, folders: Vec<PathBuf>) {
        if let Ok(mut access) = self.access.lock() {
            access.session_folders = folders;
        }
    }

    fn save(&self, access: &Access) {
        let Some(file) = &self.file else { return };
        let saved = serde_json::to_vec_pretty(access)
            .map_err(std::io::Error::other)
            .and_then(|json| {
                if let Some(dir) = file.parent() {
                    fs::create_dir_all(dir)?;
                }
                atomic_write(file, &json)
            });
        if let Err(e) = saved {
            eprintln!("Failed to save {}: {}", file.display(), e);
        }
    }
}

/// `canonicalize` without Windows' `\\?\` prefix (when the path doesn't need it),
/// so paths compare and display the same as the ones the user picked.
fn canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// `~/` expanded, nothing resolved.
fn expand_home(path_str: &str) -> Result<PathBuf, AppError> {
    if let Some(rest) = path_str.strip_prefix("~/") {
        let home = dirs::home_dir()
            .ok_or_else(|| AppError::new("PATH_ERROR", "Cannot determine home directory"))?;
        Ok(home.join(rest))
    } else if path_str.starts_with('~') {
        Err(AppError::new("PATH_ERROR", "~user syntax not supported"))
    } else {
        Ok(PathBuf::from(path_str))
    }
}

/// An existing path both as named and resolved. A relative path or one with
/// `..` only counts as its real location.
fn resolve_target(path: &Path) -> Result<Target, AppError> {
    let real = canonicalize(path).map_err(|e| {
        AppError::with_details("PATH_ERROR", "Invalid path", &e.to_string())
    })?;
    let named = if path.is_absolute() && !path.components().any(|c| c == std::path::Component::ParentDir) {
        // Drops `.` components and doubled separators
        path.components().collect()
    } else {
        real.clone()
    };
    Ok(Target { named, real })
}

fn expand_target(path_str: &str) -> Result<Target, AppError> {
    resolve_target(&expand_home(path_str)?)
}

/// Write `bytes` to a temporary file next to `target`, then rename it over
/// `target`: a crash or power loss leaves either the old or the new file,
/// never a truncated one. An existing file keeps its permissions.
fn atomic_write(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = target.parent().ok_or_else(|| std::io::Error::other("path has no parent folder"))?;
    let name = target.file_name().ok_or_else(|| std::io::Error::other("path has no file name"))?;
    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(format!(".mdviewer-{}.tmp", std::process::id()));
    let tmp = dir.join(tmp_name);

    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        if let Ok(metadata) = fs::metadata(target) {
            file.set_permissions(metadata.permissions())?;
        }
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, target)?;
        // Persist the rename itself
        #[cfg(unix)]
        fs::File::open(dir)?.sync_all()?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

// ============================================================
// File System Functions
// ============================================================

fn generate_id(path: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdc"];

/// Markdown: `.md`, `.markdown`, Cursor's `.mdc` rules and the legacy
/// `.cursorrules`. Same as `isMarkdownFile` in src/utils/files.ts.
fn is_markdown_file(path: &Path) -> bool {
    if path.file_name().is_some_and(|n| n.eq_ignore_ascii_case(".cursorrules")) {
        return true;
    }
    path.extension()
        .map(|ext| MARKDOWN_EXTENSIONS.contains(&ext.to_string_lossy().to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Text formats shown in the file tree besides markdown.
/// Keep in sync with `TEXT_FILE_EXTENSIONS` in src/utils/files.ts.
const TEXT_FILE_EXTENSIONS: &[&str] = &[
    "txt", "text", "log", "fb2", "xml", "csv", "tsv", "rst", "adoc", "org", "tex",
    "scala", "sc", "sbt", "java", "kt", "kts", "groovy", "gradle",
    "py", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc",
    "rs", "go", "c", "h", "cpp", "hpp", "cc", "cs", "rb", "php", "lua", "sql",
    "sh", "bash", "zsh", "fish", "ps1", "bat",
    "html", "htm", "css", "scss", "less", "vue", "svelte",
    "yaml", "yml", "toml", "ini", "cfg", "conf", "config", "properties", "env",
    "diff", "patch",
];

/// Extension-less (or dot-) files that are text. Same list as the frontend.
const TEXT_FILE_NAMES: &[&str] = &[
    "readme", "license", "changelog", "makefile", "dockerfile", "jenkinsfile",
    ".gitignore", ".gitattributes", ".editorconfig", ".env", ".npmrc", ".scalafmt.conf",
];

/// Markdown, or (when `include_text` is set) any other known text file.
fn is_viewable_file(path: &Path, include_text: bool) -> bool {
    if is_markdown_file(path) {
        return true;
    }
    if !include_text {
        return false;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if TEXT_FILE_NAMES.contains(&name.as_str()) {
        return true;
    }
    path.extension()
        .map(|ext| TEXT_FILE_EXTENSIONS.contains(&ext.to_string_lossy().to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Encoding named in an XML declaration (`<?xml ... encoding="windows-1251"?>`).
fn xml_declared_encoding(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    let head = &bytes[..bytes.len().min(256)];
    let head = std::str::from_utf8(head)
        .ok()
        .or_else(|| head.iter().position(|&b| b >= 0x80).and_then(|i| std::str::from_utf8(&head[..i]).ok()))?;
    let decl_end = head.find("?>")?;
    let decl = &head[..decl_end];
    if !decl.trim_start().starts_with("<?xml") {
        return None;
    }
    let rest = &decl[decl.find("encoding")? + "encoding".len()..];
    let rest = rest.trim_start().strip_prefix('=')?.trim_start();
    let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let value = &rest[1..];
    let label = &value[..value.find(quote)?];
    encoding_rs::Encoding::for_label(label.as_bytes())
}

/// How a text file's bytes are encoded.
#[derive(Debug, PartialEq)]
enum TextEncoding {
    Utf8,
    /// Byte order mark (UTF-16 LE/BE, or UTF-8 with BOM) - `usize` is its length.
    Bom(&'static encoding_rs::Encoding, usize),
    /// Named by an XML declaration (fb2 books are often windows-1251).
    Declared(&'static encoding_rs::Encoding),
    /// Not UTF-8 and nothing says what it is.
    Unknown,
}

fn detect_encoding(bytes: &[u8]) -> TextEncoding {
    if let Some((encoding, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        return TextEncoding::Bom(encoding, bom_len);
    }
    if std::str::from_utf8(bytes).is_ok() {
        return TextEncoding::Utf8;
    }
    match xml_declared_encoding(bytes) {
        Some(encoding) => TextEncoding::Declared(encoding),
        None => TextEncoding::Unknown,
    }
}

/// Decode file bytes: UTF-8, else a BOM (UTF-16), else the encoding an XML
/// declaration names, else lossy UTF-8.
fn decode_text(bytes: Vec<u8>) -> String {
    match detect_encoding(&bytes) {
        TextEncoding::Bom(encoding, bom_len) => {
            encoding.decode_without_bom_handling(&bytes[bom_len..]).0.into_owned()
        }
        TextEncoding::Declared(encoding) => encoding.decode_without_bom_handling(&bytes).0.into_owned(),
        TextEncoding::Utf8 => String::from_utf8(bytes).unwrap_or_default(),
        TextEncoding::Unknown => String::from_utf8_lossy(&bytes).into_owned(),
    }
}

/// Encode `content` for saving so the file keeps its encoding:
/// - an XML declaration in the content naming a legacy encoding wins
///   (unmappable characters become `&#NNNN;` references, valid in XML)
/// - a file that had a BOM keeps it (and stays UTF-16 if it was)
/// - a file in an unknown non-UTF-8 encoding is refused: it was decoded lossily
/// - everything else is UTF-8
fn encode_text(content: &str, previous: Option<&[u8]>) -> Result<Vec<u8>, AppError> {
    if let Some(encoding) = xml_declared_encoding(content.as_bytes()) {
        if encoding != encoding_rs::UTF_8
            && encoding != encoding_rs::UTF_16LE
            && encoding != encoding_rs::UTF_16BE
        {
            return Ok(encoding.encode(content).0.into_owned());
        }
    }

    match previous.map(detect_encoding) {
        Some(TextEncoding::Bom(encoding, _)) if encoding == encoding_rs::UTF_16LE => {
            let mut out = vec![0xFF, 0xFE];
            content.encode_utf16().for_each(|unit| out.extend_from_slice(&unit.to_le_bytes()));
            Ok(out)
        }
        Some(TextEncoding::Bom(encoding, _)) if encoding == encoding_rs::UTF_16BE => {
            let mut out = vec![0xFE, 0xFF];
            content.encode_utf16().for_each(|unit| out.extend_from_slice(&unit.to_be_bytes()));
            Ok(out)
        }
        Some(TextEncoding::Bom(_, _)) => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(content.as_bytes());
            Ok(out)
        }
        Some(TextEncoding::Unknown) => Err(AppError::new(
            "UNKNOWN_ENCODING",
            "The file is not UTF-8 and its encoding is unknown - saving would corrupt it",
        )),
        _ => Ok(content.as_bytes().to_vec()),
    }
}

// ============================================================
// History Functions
// ============================================================

fn get_config_dir() -> Result<PathBuf, AppError> {
    dirs::config_dir()
        .map(|p| {
            p.join("agent-mcr")
        })
        .ok_or_else(|| AppError::new("CONFIG_ERROR", "Cannot determine config directory"))
}

// ============================================================
// Tauri Commands
// ============================================================

#[tauri::command]
async fn read_file(path: String, access: State<'_, AccessState>) -> Result<String, AppError> {
    let expanded = expand_target(&path)?;
    access.check(&expanded, Use::Open)?;
    let expanded = expanded.real;
    
    // Check file size (max 10MB)
    let metadata = fs::metadata(&expanded)
        .map_err(|e| AppError::with_details("FILE_ERROR", "Cannot read file metadata", &e.to_string()))?;
    
    if metadata.len() > 10 * 1024 * 1024 {
        return Err(AppError::new("FILE_TOO_LARGE", "File exceeds 10MB limit"));
    }
    
    fs::read(&expanded)
        .map(decode_text)
        .map_err(|e| AppError::with_details("FILE_ERROR", "Failed to read file", &e.to_string()))
}

/// Save an open document. The file must exist and be one the user opened; a
/// symlink is resolved and its target is replaced atomically.
#[tauri::command]
async fn write_file(path: String, content: String, access: State<'_, AccessState>) -> Result<(), AppError> {
    let expanded = expand_target(&path)?;
    access.check(&expanded, Use::Open)?;
    let expanded = expanded.real;

    let previous = fs::read(&expanded)
        .map_err(|e| AppError::with_details("FILE_ERROR", "Failed to read file", &e.to_string()))?;
    let bytes = encode_text(&content, Some(&previous))?;

    atomic_write(&expanded, &bytes)
        .map_err(|e| AppError::with_details("FILE_ERROR", "Failed to write file", &e.to_string()))
}

#[derive(Debug, Deserialize)]
pub struct FileFilter {
    name: String,
    extensions: Vec<String>,
}

/// Native folder picker. The chosen folder is added to the access list.
#[tauri::command]
async fn pick_directory(app: AppHandle, access: State<'_, AccessState>) -> Result<Option<String>, AppError> {
    let dialog = app.dialog().file().set_title("Select Directory");
    #[cfg(any(windows, target_os = "macos"))]
    let dialog = match app.get_webview_window("main") {
        Some(window) => dialog.set_parent(&window),
        None => dialog,
    };
    let Some(picked) = dialog.blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked.into_path()
        .map_err(|e| AppError::with_details("PATH_ERROR", "Invalid folder", &e.to_string()))?;
    let canonical = canonicalize(&path)
        .map_err(|e| AppError::with_details("PATH_ERROR", "Invalid folder", &e.to_string()))?;
    access.grant([&canonical]);
    Ok(Some(canonical.to_string_lossy().to_string()))
}

/// Native save dialog, then write `content` (UTF-8) where the user chose.
/// Returns the saved path, or `None` when cancelled.
#[tauri::command]
async fn export_file(
    app: AppHandle,
    default_name: String,
    content: String,
    filters: Option<Vec<FileFilter>>,
    title: Option<String>,
) -> Result<Option<String>, AppError> {
    let mut dialog = app.dialog().file()
        .set_file_name(&default_name)
        .set_title(title.as_deref().unwrap_or("Export"));
    for filter in filters.unwrap_or_default() {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }

    let Some(picked) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = picked.into_path()
        .map_err(|e| AppError::with_details("PATH_ERROR", "Invalid path", &e.to_string()))?;

    atomic_write(&path, content.as_bytes())
        .map_err(|e| AppError::with_details("FILE_ERROR", "Failed to write file", &e.to_string()))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
async fn get_file_info(path: String, access: State<'_, AccessState>) -> Result<serde_json::Value, AppError> {
    let expanded = expand_target(&path)?;
    access.check(&expanded, Use::Stat)?;
    
    let metadata = fs::metadata(&expanded.real)
        .map_err(|e| AppError::with_details("FILE_ERROR", "Failed to get metadata", &e.to_string()))?;
    
    Ok(serde_json::json!({
        "size": metadata.len(),
        "modified": metadata.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()),
        "isReadOnly": metadata.permissions().readonly(),
        "isDirectory": metadata.is_dir(),
    }))
}

#[tauri::command]
async fn open_in_explorer(path: String, access: State<'_, AccessState>) -> Result<(), AppError> {
    let target = expand_target(&path)?;
    access.check(&target, Use::Stat)?;
    reveal_in_file_manager(&target.real)
}

/// Select `path` in Finder / Explorer; on Linux, open its folder.
fn reveal_in_file_manager(expanded: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(expanded)
            .spawn()
            .map_err(|e| AppError::with_details("SHELL_ERROR", "Failed to open explorer", &e.to_string()))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(expanded)
            .spawn()
            .map_err(|e| AppError::with_details("SHELL_ERROR", "Failed to open Finder", &e.to_string()))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Open the parent directory (works on all Linux DEs)
        let target = if expanded.is_dir() {
            expanded
        } else {
            expanded.parent().unwrap_or(expanded)
        };
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| AppError::with_details("SHELL_ERROR", "Failed to open file manager", &e.to_string()))?;
    }

    Ok(())
}

/// What the frontend does after `follow_local_link`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum LinkOutcome {
    /// A document the app may now read: open it in a tab.
    Open,
    /// Shown in the file manager.
    Revealed,
    /// The user declined.
    Cancelled,
}

/// A click on a link to a local file. Documents open in the app, anything
/// else is shown in the file manager. A target outside what the user opened is
/// only followed after they confirm it in a native dialog, which a script in
/// the webview can't answer; a confirmed document is added to the access list.
#[tauri::command]
async fn follow_local_link(
    path: String,
    app: AppHandle,
    access: State<'_, AccessState>,
) -> Result<LinkOutcome, AppError> {
    let target = expand_target(&path)?;
    let document = target.real.is_file() && is_viewable_file(&target.real, true);
    let use_ = if document { Use::Open } else { Use::Stat };

    if access.check(&target, use_).is_err() {
        let reveal_label = if cfg!(target_os = "macos") {
            "Show in Finder"
        } else if cfg!(target_os = "windows") {
            "Show in Explorer"
        } else {
            "Show in Folder"
        };
        let (title, action) = if document {
            ("Open linked file?", "Open")
        } else {
            ("Show linked file?", reveal_label)
        };
        let mut dialog = app.dialog()
            .message(format!(
                "The document links to a file outside the folders and files you opened:\n\n{}",
                target.real.display()
            ))
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(action.to_string(), "Cancel".to_string()));
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.parent(&window);
        }
        if !dialog.blocking_show() {
            return Ok(LinkOutcome::Cancelled);
        }
        if document {
            access.grant([&target.real]);
        }
    }

    if document {
        Ok(LinkOutcome::Open)
    } else {
        reveal_in_file_manager(&target.real)?;
        Ok(LinkOutcome::Revealed)
    }
}

/// Open a web or mail link from a document in the default browser / mail app.
#[tauri::command]
async fn open_external(url: String, app: AppHandle) -> Result<(), AppError> {
    let parsed = tauri::Url::parse(&url)
        .map_err(|e| AppError::with_details("URL_ERROR", "Invalid link", &e.to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(AppError::with_details("URL_ERROR", "Only web and mail links can be opened", &url));
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| AppError::with_details("SHELL_ERROR", "Failed to open link", &e.to_string()))
}

// ============================================================
// Agent workspace
// ============================================================

/// How far back a past session makes its folder a session folder.
const SESSION_FOLDER_DAYS: u64 = 30;
const MAX_SESSION_FOLDERS: usize = 40;

/// The folders agent sessions work in, most recent first: those of the
/// sessions hosted now, the folders added in Live, and the folders of indexed
/// sessions of the last `SESSION_FOLDER_DAYS` (when the Sessions workspace is
/// on). The home folder and everything above it are left out: looking through
/// them would read far more than a project.
fn session_folders(access: &AccessState, sessions: &session_commands::SessionState) -> Vec<PathBuf> {
    let mut found: Vec<(u64, PathBuf)> = Vec::new();
    if let Ok(dir) = get_config_dir() {
        // Only a service that already runs: listing documents must not start one
        let hosted = std::os::unix::net::UnixStream::connect(harness::socket(&dir)).is_ok()
            .then(|| harness::call(&dir, serde_json::json!({"op": "sessions"})).ok())
            .flatten();
        for s in hosted.iter().flat_map(|h| h["sessions"].as_array().into_iter().flatten()) {
            if let Some(cwd) = s["cwd"].as_str() {
                found.push((u64::MAX, PathBuf::from(cwd)));
            }
        }
    }
    let (opened, indexed) = access.access.lock()
        .map(|a| (a.directories.clone(), a.session_workspace))
        .unwrap_or_default();
    found.extend(opened.into_iter().map(|dir| (u64::MAX - 1, dir)));
    if indexed {
        let since = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
            .saturating_sub(SESSION_FOLDER_DAYS * 86_400_000);
        if let Ok(index) = sessions.index.lock() {
            found.extend(index.summaries().into_iter().filter(|s| s.modified >= since && !s.cwd.is_empty()).map(|s| (s.modified, PathBuf::from(s.cwd))));
        }
    }
    found.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    let home = dirs::home_dir().and_then(|h| canonicalize(&h).ok());
    let mut folders: Vec<PathBuf> = Vec::new();
    for (_, dir) in found {
        let Ok(real) = canonicalize(&dir) else { continue };
        let too_wide = home.as_deref().is_some_and(|home| home.starts_with(&real));
        if real.is_dir() && !too_wide && !folders.contains(&real) {
            folders.push(real);
            if folders.len() >= MAX_SESSION_FOLDERS {
                break;
            }
        }
    }
    folders
}

/// The agent files (instructions, memory, plans, skills) with their read
/// state. Empty while the workspace is off.
#[tauri::command]
async fn agent_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    access: State<'_, AccessState>,
    sessions: State<'_, session_commands::SessionState>,
) -> Result<agent::AgentWorkspace, AppError> {
    let enabled = access.agent_workspace_on();
    if !enabled {
        return Ok(agent::AgentWorkspace { enabled, entries: Vec::new(), folders: Vec::new(), watching: false });
    }
    let directories = session_folders(&access, &sessions);
    access.set_session_folders(directories.clone());
    let folders = directories.iter().map(|d| d.to_string_lossy().into_owned()).collect();
    static PRUNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let prune = !PRUNED.swap(true, std::sync::atomic::Ordering::Relaxed);
    let agent_watch = Arc::clone(&state.agent_watch);
    let (entries, watching) = tauri::async_runtime::spawn_blocking(move || {
        // Every scan: watch folders opened or created since the last one
        let watching = agent_watch.lock().map(|mut slot| {
            if slot.is_none() {
                *slot = agent::Watch::new(move || {
                    let _ = app.emit("agent-files-changed", ());
                })
                .map_err(|e| eprintln!("Failed to watch agent files: {}", e))
                .ok();
            }
            slot.as_mut().map(|watch| watch.update(&directories)).is_some()
        }).unwrap_or(false);
        let entries = agent::scan(&directories);
        // Once per run: drop read state of files that are gone
        if prune {
            agent::prune_read_state(&entries);
        }
        (entries, watching)
    })
        .await
        .map_err(|e| AppError::with_details("SCAN_ERROR", "Failed to list agent files", &e.to_string()))?;
    Ok(agent::AgentWorkspace { enabled, entries, folders, watching })
}

/// Turn the agent workspace on after the user confirms it in a native dialog
/// (the webview can't answer it). Returns whether it is on.
#[tauri::command]
async fn enable_agent_workspace(
    app: AppHandle,
    access: State<'_, AccessState>,
    sessions: State<'_, session_commands::SessionState>,
) -> Result<bool, AppError> {
    let locations = agent::found_locations();
    let found = if locations.is_empty() {
        "No agent folders were found yet.".to_string()
    } else {
        format!("Agent MCR will read the markdown files coding agents keep in:\n\n{}", locations.join("\n"))
    };
    let mut dialog = app.dialog()
        .message(format!(
            "{}\n\nand the same kinds of file in the folders your agent sessions work in.\n\nThat is instructions (CLAUDE.md, AGENTS.md), rules, memory, plans, skills, agents and commands. Settings, keys and session transcripts are not read.",
            found
        ))
        .title("Show agent files?")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Show agent files".to_string(), "Cancel".to_string()));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    if !dialog.blocking_show() {
        return Ok(false);
    }
    access.set_agent_workspace(true);
    let directories = session_folders(&access, &sessions);
    access.set_session_folders(directories.clone());
    // Everything there now counts as read: only later changes are highlighted
    tauri::async_runtime::spawn_blocking(move || agent::mark_all_read(&agent::scan(&directories)));
    Ok(true)
}

#[tauri::command]
fn disable_agent_workspace(state: State<'_, AppState>, access: State<'_, AccessState>) {
    access.set_agent_workspace(false);
    if let Ok(mut watch) = state.agent_watch.lock() {
        *watch = None;
    }
}

/// The copy of a document kept when it was last read, for "what changed".
#[tauri::command]
fn read_snapshot(path: String, access: State<'_, AccessState>) -> Result<Option<agent::Snapshot>, AppError> {
    let target = expand_target(&path)?;
    access.check(&target, Use::Open)?;
    Ok(agent::load_snapshot(&path))
}

/// Remember documents as read, as they are now.
#[tauri::command]
async fn mark_read(paths: Vec<String>, access: State<'_, AccessState>) -> Result<(), AppError> {
    let mut allowed = Vec::new();
    for path in paths {
        let target = expand_target(&path)?;
        access.check(&target, Use::Open)?;
        allowed.push(path);
    }
    tauri::async_runtime::spawn_blocking(move || {
        allowed.iter().try_for_each(|path| agent::mark_read(path))
    })
    .await
    .map_err(|e| AppError::with_details("WRITE_ERROR", "Failed to save read state", &e.to_string()))?
}

// ============================================================
// Navigation Guard
// ============================================================

/// The app's own pages: `tauri://localhost` (macOS/Linux),
/// `http(s)://tauri.localhost` (Windows), the Vite dev server in debug builds.
fn is_app_url(url: &tauri::Url) -> bool {
    let (scheme, host) = (url.scheme(), url.host_str());
    matches!((scheme, host), ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")))
        || (cfg!(debug_assertions) && scheme == "http" && host == Some("localhost"))
}

/// Keeps the window on the app: a link or script can't navigate it to a
/// remote page or a local file. Links are opened by the frontend instead.
fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|_webview, url| {
            let allowed = is_app_url(url);
            if !allowed {
                eprintln!("Blocked navigation to {}", url);
            }
            allowed
        })
        .build()
}

// ============================================================
// Local File Protocol (for serving images in markdown)
// ============================================================

/// Largest image the `localfile://` protocol serves.
const MAX_IMAGE_SIZE: u64 = 50 * 1024 * 1024;

/// Decode `%XX` escapes (UTF-8). Invalid escapes are kept as they are.
fn percent_decode(input: &str) -> String {
    fn hex(b: u8) -> Option<u8> {
        (b as char).to_digit(16).map(|d| d as u8)
    }

    let bytes = input.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                result.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| input.to_string())
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return None,
    })
}

fn is_image_file(path: &Path) -> bool {
    image_mime(path).is_some()
}

/// Serve an image referenced by a document. The URL path is the
/// percent-encoded absolute file path (see `convertFileSrc` in the frontend):
/// `localfile://localhost/<path>` on macOS/Linux,
/// `http://localfile.localhost/<path>` on Windows.
fn serve_local_image(access: &AccessState, url_path: &str) -> HttpResponse<Vec<u8>> {
    let respond = |status: StatusCode, mime: &str, body: Vec<u8>| {
        HttpResponse::builder()
            .status(status)
            .header("Content-Type", mime)
            .header("X-Content-Type-Options", "nosniff")
            .body(body)
            .unwrap()
    };

    let decoded = percent_decode(url_path.trim_start_matches('/'));
    let Ok(target) = resolve_target(Path::new(&decoded)) else {
        return respond(StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    if access.check(&target, Use::Image).is_err() {
        return respond(StatusCode::FORBIDDEN, "text/plain", Vec::new());
    }
    let path = target.real;
    let Some(mime) = image_mime(&path) else {
        return respond(StatusCode::FORBIDDEN, "text/plain", Vec::new());
    };
    match fs::metadata(&path) {
        Ok(metadata) if metadata.len() > MAX_IMAGE_SIZE => {
            return respond(StatusCode::PAYLOAD_TOO_LARGE, "text/plain", Vec::new());
        }
        Err(_) => return respond(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
        _ => {}
    }
    match fs::read(&path) {
        Ok(data) => respond(StatusCode::OK, mime, data),
        Err(_) => respond(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
    }
}

// ============================================================
// Main Entry Point
// ============================================================

/// Replace the placeholder system File/Help menus with actions backed by the
/// same commands as the toolbar. Standard Edit and window actions stay native.
fn install_app_menu(app: &mut tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    #[cfg(target_os = "macos")]
    let app_menu = SubmenuBuilder::new(handle, "Agent MCR")
        .about(None).separator().services().separator()
        .hide().hide_others().separator().quit().build()?;

    let file = SubmenuBuilder::new(handle, "File")
        .text("file.save", "Save File")
        .text("file.saveAll", "Save All…")
        .text("file.exportMarkdown", "Export as Markdown…")
        .text("file.exportHtml", "Export as HTML…")
        .separator().close_window().build()?;
    let edit = SubmenuBuilder::new(handle, "Edit")
        .undo().redo().separator().cut().copy().paste().select_all().build()?;
    let window = SubmenuBuilder::new(handle, "Window")
        .minimize().maximize().build()?;
    let help = SubmenuBuilder::new(handle, "Help")
        .text("help.docs", "Documentation")
        .text("help.issues", "Report an Issue")
        .build()?;

    let menu = MenuBuilder::new(handle);
    #[cfg(target_os = "macos")]
    let menu = menu.item(&app_menu);
    app.set_menu(menu.items(&[&file, &edit, &window, &help]).build()?)?;
    app.on_menu_event(|app, event| match event.id().0.as_str() {
        "help.docs" => {
            let _ = app.opener().open_url("https://github.com/lambda-house/agent-mcr#readme", None::<&str>);
        }
        "help.issues" => {
            let _ = app.opener().open_url("https://github.com/lambda-house/agent-mcr/issues", None::<&str>);
        }
        id => {
            if let Some(window) = app.webview_windows().values().find(|window| window.is_focused().unwrap_or(false)) {
                let _ = app.emit_to(window.label(), "menu-command", id);
            }
        }
    });
    Ok(())
}

/// Workaround for the torn / corrupted rendering seen on Raspberry Pi and other
/// ARM GL drivers: https://github.com/tauri-apps/tauri/issues/9289
///
/// WebKitGTK reads these on startup, so they have to be set before the webview
/// is created. Anything the user already exported wins, and setting
/// `MDVIEWER_ENABLE_DMABUF=1` opts back into the default WebKit renderer.
#[cfg(target_os = "linux")]
fn apply_linux_rendering_workarounds() {
    let dmabuf_forced_on = std::env::var_os("MDVIEWER_ENABLE_DMABUF").is_some();

    if !dmabuf_forced_on && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // Heavier fallback for GPUs where disabling DMA-BUF is not enough. Opt-in,
    // because turning off accelerated compositing also slows scrolling down.
    if std::env::var_os("MDVIEWER_DISABLE_COMPOSITING").is_some()
        && std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none()
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
}

fn main() {
    // The runner owns agent terminals and outlives the app (started by launchd).
    // Like the MCP bridge, it must branch before any AppKit/Tauri initialization.
    #[cfg(unix)]
    if std::env::args().nth(1).as_deref() == Some("--runner") {
        let result = get_config_dir()
            .map_err(|e| e.message)
            .and_then(|dir| runner::serve(&dir.join("runner.sock")));
        if let Err(e) = result {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }
    // The harness service, the supervisor's MCP bridge and the agents' hook reporter
    #[cfg(unix)]
    match std::env::args().nth(1).as_deref() {
        Some(flag @ ("--harness" | "--supervise" | "--harness-mcp")) => {
            let result = get_config_dir().map_err(|e| e.message).and_then(|dir| match flag {
                "--harness" => harness::serve(&dir),
                "--supervise" => harness::supervise_bridge(&dir),
                _ => harness::agent_bridge(&dir),
            });
            if let Err(e) = result {
                eprintln!("{e}");
                std::process::exit(1);
            }
            return;
        }
        Some(flag @ ("--harness-tool" | "--supervisor-tool")) => {
            let result = get_config_dir()
                .map_err(|e| e.message)
                .and_then(|dir| harness::tool_cli(&dir, &std::env::args().nth(2).unwrap_or_default(), std::env::args().nth(3), flag == "--supervisor-tool"));
            match result {
                Ok(out) => println!("{out}"),
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
            return;
        }
        Some("--harness-hook") => {
            harness::hook_bridge(&std::env::args().nth(2).unwrap_or_default(), std::env::args().nth(3));
            return;
        }
        _ => {}
    }
    if std::env::args().nth(1).as_deref() == Some("--mcp") {
        let path = std::env::args().nth(2).map(PathBuf::from).or_else(||get_config_dir().ok().map(|p|p.join("analysis/mcp.sock")));
        let result = path.ok_or_else(||"Configuration directory unavailable".to_string()).and_then(|p|session_mcp::bridge(&p));
        if let Err(e) = result {eprintln!("{e}");std::process::exit(1);}
        return;
    }
    #[cfg(target_os = "linux")]
    apply_linux_rendering_workarounds();

    let access = AccessState::load();

    tauri::Builder::default()
        // Must be the first plugin: a second launch brings this instance forward and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(AppState::default())
        .manage(session_commands::SessionState::default())
        .manage(session_analysis_commands::AnalysisState::default())
        .manage(access)
        .manage(harness_commands::HarnessState::default())
        .plugin(tauri_plugin_dialog::init())
        // Used from Rust only (`open_external`); no JS permissions are granted
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation_guard())
        .setup(|app| {
            install_app_menu(app)?;
            session_analysis_commands::start_scanner(app.handle().clone());
            Ok(())
        })
        .register_uri_scheme_protocol("localfile", |ctx, request| {
            serve_local_image(&ctx.app_handle().state::<AccessState>(), request.uri().path())
        })
        .invoke_handler(tauri::generate_handler![
            harness_commands::harness_status,
            harness_commands::harness_preferences,
            harness_commands::harness_list,
            harness_commands::harness_spawn,
            harness_commands::harness_supervisor,
            harness_commands::harness_resumable,
            harness_commands::harness_ack,
            harness_commands::harness_board,
            harness_commands::harness_note_remove,
            harness_commands::harness_signal,
            harness_commands::harness_forget,
            harness_commands::harness_restart,
            harness_commands::harness_outside_supervisors,
            harness_commands::terminal_attach,
            harness_commands::terminal_input,
            harness_commands::terminal_resize,
            harness_commands::terminal_detach,
            harness_commands::terminal_save_image,
            session_analysis_commands::analysis_access,
            session_analysis_commands::enable_analysis,
            session_analysis_commands::revoke_analysis,
            session_analysis_commands::run_session_analysis,
            session_commands::session_access,
            session_commands::enable_sessions,
            session_commands::disable_sessions,
            session_commands::sessions_snapshot,
            session_commands::session_details,
            session_commands::session_stats,
            session_commands::session_events,
            session_commands::session_memory_access,
            session_commands::enable_session_memories,
            session_commands::session_memories,
            session_commands::read_session_memory,
            session_commands::open_session_memory_window,
            read_file,
            write_file,
            pick_directory,
            export_file,
            get_file_info,
            open_in_explorer,
            follow_local_link,
            open_external,
            agent_workspace,
            enable_agent_workspace,
            disable_agent_workspace,
            read_snapshot,
            mark_read,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Files handed over by the system ("Open with") are not opened: the app shows agent documents only
        .run(|_app, _event| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh empty folder under the system temp dir.
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mdviewer-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        canonicalize(&dir).unwrap()
    }

    #[test]
    fn percent_decode_handles_trailing_escape_and_non_ascii() {
        assert_eq!(percent_decode("a%41"), "aA");
        assert_eq!(percent_decode("%2Ftmp%2Fx%20y.md"), "/tmp/x y.md");
        assert_eq!(percent_decode("%D0%BF%D1%80%D0%B8"), "при");
        // Used to panic: slicing into the middle of a multi-byte character
        assert_eq!(percent_decode("%Ж1"), "%Ж1");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%4"), "%4");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn access_list_limits_reads_to_opened_folders_and_files() {
        let root = temp_dir("access");
        let docs = root.join("docs");
        let other = root.join("other");
        fs::create_dir_all(docs.join("img")).unwrap();
        fs::create_dir_all(&other).unwrap();
        for file in ["docs/a.md", "docs/.bashrc", "docs/id_rsa", "docs/img/p.png", "other/b.md", "other/c.md", "other/pic.png", "other/sub.png"] {
            fs::write(root.join(file), "x").unwrap();
        }

        let mut access = Access::default();
        assert!(access.grant(&docs));
        assert!(access.grant(&other.join("b.md")));

        assert!(access.can_open(&docs.join("a.md")));
        assert!(!access.can_open(&docs.join(".bashrc")), "dotfiles aren't documents");
        assert!(!access.can_open(&docs.join("id_rsa")), "keys aren't documents");
        assert!(access.can_open(&other.join("b.md")));
        assert!(!access.can_open(&other.join("c.md")), "only the opened file, not its siblings");
        assert!(!access.can_open(&root.join("docs-evil/a.md")), "prefix match is per component");

        assert!(access.can_list(&docs));
        assert!(!access.can_list(&other));

        assert!(access.can_read_image(&docs.join("img/p.png")));
        assert!(access.can_read_image(&other.join("pic.png")), "images next to an opened file");
        assert!(!access.can_read_image(&docs.join("a.md")), "not an image");

        // Opening the parent folder replaces what's inside it
        assert!(access.grant(&root));
        assert_eq!(access.directories, vec![root.clone()]);
        assert!(access.files.is_empty());
        assert!(!access.grant(&docs), "already covered");

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_in_opened_folders_are_followed_to_documents_only() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("symlinks");
        let docs = root.join("docs");
        let outside = root.join("outside");
        fs::create_dir_all(&docs).unwrap();
        fs::create_dir_all(outside.join("guide")).unwrap();
        for file in ["outside/notes.md", "outside/id_rsa", "outside/pic.png", "outside/guide/a.md", "outside/hosts.yml"] {
            fs::write(root.join(file), "x").unwrap();
        }
        symlink(outside.join("notes.md"), docs.join("notes.md")).unwrap();
        symlink(outside.join("id_rsa"), docs.join("key.md")).unwrap();
        symlink(outside.join("pic.png"), docs.join("pic.png")).unwrap();
        symlink(outside.join("hosts.yml"), docs.join("hosts.yml")).unwrap();
        symlink(outside.join("hosts.yml"), docs.join("hosts.md")).unwrap();
        symlink(outside.join("guide"), docs.join("guide")).unwrap();
        symlink(&docs, docs.join("loop")).unwrap();

        let state = AccessState {
            access: Mutex::new(Access::default()),
            file: None,
        };
        state.grant([&docs]);
        let check = |path: PathBuf, use_| state.check(&resolve_target(&path).unwrap(), use_).is_ok();

        assert!(check(docs.join("notes.md"), Use::Open), "link to a document");
        assert!(check(docs.join("guide/a.md"), Use::Open), "document in a linked folder");
        assert!(check(docs.join("pic.png"), Use::Image));
        assert!(!check(docs.join("key.md"), Use::Open), "a .md name doesn't make a key a document");
        assert!(!check(docs.join("hosts.yml"), Use::Open), "a link out of the folder reaches Markdown only");
        assert!(!check(docs.join("hosts.md"), Use::Open));
        assert!(!check(outside.join("notes.md"), Use::Open), "the target itself isn't opened");
        assert!(!check(docs.join("guide/../notes.md"), Use::Open), "no `..` through a link");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn agent_files_of_session_folders_open_only_while_the_workspace_is_on() {
        let mut access = Access { agent_workspace: true, session_folders: vec![PathBuf::from("/work/app")], ..Access::default() };
        for path in ["/work/app/CLAUDE.md", "/work/app/AGENTS.md", "/work/app/.claude/plans/next.md", "/work/app/crates/core/CLAUDE.md", "/work/app/.cursor/rules/api.mdc"] {
            assert!(access.can_open(Path::new(path)) && access.can_stat(Path::new(path)), "{path}");
        }
        // Nothing else in the folder, and nothing in a folder no session works in
        for path in ["/work/app/README.md", "/work/app/src/main.rs", "/work/app/.claude/settings.json", "/work/app/.env", "/work/app/node_modules/x/CLAUDE.md", "/work/other/CLAUDE.md", "/work/application/CLAUDE.md"] {
            assert!(!access.can_open(Path::new(path)), "{path}");
        }
        assert!(!access.can_list(Path::new("/work/app")) && !access.can_read_image(Path::new("/work/app/logo.png")));
        access.agent_workspace = false;
        assert!(!access.can_open(Path::new("/work/app/CLAUDE.md")));
    }

    #[test]
    fn atomic_write_replaces_content_and_keeps_permissions() {
        let dir = temp_dir("atomic");
        let file = dir.join("note.md");
        fs::write(&file, "old").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
        }

        atomic_write(&file, b"new").unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o640);
        }
        let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from("note.md")], "no temp file left behind");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_app_pages_are_navigable() {
        let url = |s: &str| tauri::Url::parse(s).unwrap();
        assert!(is_app_url(&url("tauri://localhost/index.html")));
        assert!(is_app_url(&url("http://tauri.localhost/")));
        assert!(is_app_url(&url("https://tauri.localhost/")));
        assert!(!is_app_url(&url("https://example.com/")));
        assert!(!is_app_url(&url("http://tauri.localhost.evil.com/")));
        assert!(!is_app_url(&url("file:///etc/passwd")));
        assert!(!is_app_url(&url("localfile://localhost/x.png")));
    }

}
