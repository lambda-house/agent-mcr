use crate::agents::{profiles, Profile};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessPreferences {
    pub enabled_profiles: Vec<String>,
    pub supervisor_profile: Option<String>,
}

impl Default for HarnessPreferences {
    fn default() -> Self {
        Self { enabled_profiles: profiles().iter().filter(|p| !p.optional).map(|p| p.id.to_string()).collect(), supervisor_profile: Some("claude".into()) }
    }
}

impl HarnessPreferences {
    pub fn load(dir: &Path) -> Result<Self, String> {
        match std::fs::read(dir.join("harness-preferences.json")) {
            Ok(bytes) => {
                let prefs: Self = serde_json::from_slice(&bytes).map_err(|e| format!("Invalid harness preferences: {e}"))?;
                prefs.validate()?;
                Ok(prefs)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(format!("Cannot read harness preferences: {e}")),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        for (i, id) in self.enabled_profiles.iter().enumerate() {
            if !profiles().iter().any(|p| p.id == id) || self.enabled_profiles[..i].contains(id) {
                return Err(format!("Unknown or duplicate harness: {id}"));
            }
        }
        if let Some(id) = &self.supervisor_profile {
            self.require_enabled(id)?;
            if !profiles().iter().any(|p| p.id == id && p.can_supervise) {
                return Err("A terminal cannot supervise agents".into());
            }
        }
        Ok(())
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        use std::io::Write;
        self.validate()?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        let tmp = dir.join("harness-preferences.json.tmp");
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
        std::fs::rename(tmp, dir.join("harness-preferences.json")).map_err(|e| e.to_string())
    }

    pub fn require_enabled(&self, id: &str) -> Result<(), String> {
        if self.enabled_profiles.iter().any(|p| p == id) { Ok(()) } else { Err(format!("Harness {id:?} is disabled. Enable it in Settings → Harnesses.")) }
    }

    pub fn profiles(&self) -> Vec<Profile> {
        profiles().into_iter().filter(|p| self.enabled_profiles.iter().any(|id| id == p.id)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_enabled_harnesses_and_supervisor() {
        let defaults = HarnessPreferences::default();
        assert_eq!(defaults.enabled_profiles, ["claude", "codex", "shell"]);
        assert!(profiles().iter().filter(|p| p.optional).all(|p| defaults.require_enabled(p.id).is_err()));
        for p in profiles().iter().filter(|p| p.can_supervise) {
            let prefs = HarnessPreferences { enabled_profiles: vec![p.id.into()], supervisor_profile: Some(p.id.into()) };
            assert!(prefs.validate().is_ok());
            assert_eq!(prefs.profiles()[0].id, p.id);
            assert!(prefs.require_enabled("shell").is_err());
        }
        for ids in [vec!["unknown"], vec!["claude", "claude"], vec!["shell"], vec![]] {
            assert!(HarnessPreferences { enabled_profiles: ids.into_iter().map(String::from).collect(), supervisor_profile: Some("claude".into()) }.validate().is_err());
        }
        assert!(HarnessPreferences { enabled_profiles: vec!["shell".into()], supervisor_profile: Some("shell".into()) }.validate().is_err());
        assert!(HarnessPreferences { enabled_profiles: vec![], supervisor_profile: None }.validate().is_ok());
    }

    #[test]
    fn persists_preferences_and_refuses_corrupt_files() {
        let dir = std::env::temp_dir().join(format!("mcr-prefs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(HarnessPreferences::load(&dir).unwrap(), HarnessPreferences::default());
        let prefs = HarnessPreferences { enabled_profiles: vec!["pi".into(), "antigravity".into()], supervisor_profile: Some("pi".into()) };
        prefs.save(&dir).unwrap();
        assert_eq!(HarnessPreferences::load(&dir).unwrap(), prefs);
        std::fs::write(dir.join("harness-preferences.json"), b"broken").unwrap();
        assert!(HarnessPreferences::load(&dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
