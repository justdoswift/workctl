use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::util::normalize_base_url;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedProfile {
    pub name: String,
    pub url: String,
    pub username: String,
    pub password: String,
    pub insecure: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesFile {
    pub default_profile: Option<String>,
    pub profiles: Vec<SavedProfile>,
}

pub fn default_profiles_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".workctl")
        .join("profiles.json")
}

pub fn legacy_profiles_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".kslog")
        .join("profiles.json")
}

pub fn migrate_legacy_profiles_if_needed(
    file_path: &Path,
    legacy_file_path: &Path,
) -> Result<bool> {
    if file_path.exists() {
        return Ok(false);
    }
    if !legacy_file_path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(legacy_file_path).context("读取旧 profile 失败")?;
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).context("创建 profile 目录失败")?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).ok();
    }
    fs::write(file_path, content).context("迁移 profile 失败")?;
    fs::set_permissions(file_path, fs::Permissions::from_mode(0o600))
        .context("设置 profile 权限失败")?;
    Ok(true)
}

pub fn read_profiles_from(path: &Path) -> Result<ProfilesFile> {
    if !path.exists() {
        return Ok(ProfilesFile::default());
    }
    let raw = fs::read_to_string(path).context("读取 profile 配置失败")?;
    let parsed: ProfilesFile = serde_json::from_str(&raw).context("解析 profile 配置失败")?;
    Ok(parsed)
}

pub fn read_profiles() -> Result<ProfilesFile> {
    let path = default_profiles_path();
    migrate_legacy_profiles_if_needed(&path, &legacy_profiles_path())?;
    read_profiles_from(&path)
}

pub fn write_profiles_to(path: &Path, profiles_file: &ProfilesFile) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("创建 profile 目录失败")?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).ok();
    }
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(profiles_file)?),
    )
    .context("写入 profile 配置失败")?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .context("设置 profile 权限失败")?;
    Ok(())
}

pub fn write_profiles(profiles_file: &ProfilesFile) -> Result<()> {
    write_profiles_to(&default_profiles_path(), profiles_file)
}

pub fn upsert_profile(input: UpsertProfile) -> Result<SavedProfile> {
    let mut config = read_profiles()?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err(anyhow!("profile name 不能为空"));
    }
    if input.username.trim().is_empty() {
        return Err(anyhow!("username 不能为空"));
    }
    if input.password.is_empty() {
        return Err(anyhow!("password 不能为空"));
    }

    let now = chrono::Utc::now().to_rfc3339();
    let normalized_url = normalize_base_url(&input.url)?;
    let existing_index = config
        .profiles
        .iter()
        .position(|profile| profile.name == name);
    let created_at = existing_index
        .and_then(|index| {
            config
                .profiles
                .get(index)
                .map(|profile| profile.created_at.clone())
        })
        .unwrap_or_else(|| now.clone());
    let profile = SavedProfile {
        name: name.to_string(),
        url: normalized_url,
        username: input.username.trim().to_string(),
        password: input.password,
        insecure: input.insecure,
        created_at,
        updated_at: now,
    };

    if let Some(index) = existing_index {
        config.profiles[index] = profile.clone();
    } else {
        config.profiles.push(profile.clone());
    }

    if input.set_default || config.profiles.len() == 1 {
        config.default_profile = Some(profile.name.clone());
    }

    write_profiles(&config)?;
    Ok(profile)
}

#[derive(Debug, Clone)]
pub struct UpsertProfile {
    pub name: String,
    pub url: String,
    pub username: String,
    pub password: String,
    pub insecure: bool,
    pub set_default: bool,
}

pub fn remove_profile(name: &str) -> Result<bool> {
    let mut config = read_profiles()?;
    let before = config.profiles.len();
    config.profiles.retain(|profile| profile.name != name);
    if config.default_profile.as_deref() == Some(name) {
        config.default_profile = config.profiles.first().map(|profile| profile.name.clone());
    }
    write_profiles(&config)?;
    Ok(config.profiles.len() != before)
}

pub fn set_default_profile(name: &str) -> Result<()> {
    let mut config = read_profiles()?;
    if !config.profiles.iter().any(|profile| profile.name == name) {
        return Err(anyhow!("profile 不存在：{name}"));
    }
    config.default_profile = Some(name.to_string());
    write_profiles(&config)
}

pub fn choose_default_profile(config: &ProfilesFile) -> Option<SavedProfile> {
    if let Some(default_profile) = &config.default_profile {
        if let Some(profile) = config
            .profiles
            .iter()
            .find(|profile| &profile.name == default_profile)
        {
            return Some(profile.clone());
        }
    }
    config.profiles.first().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn creates_profiles_with_permissions() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("profiles.json");
        let config = ProfilesFile {
            default_profile: Some("测试环境".to_string()),
            profiles: vec![SavedProfile {
                name: "测试环境".to_string(),
                url: "http://192.168.7.191:30880".to_string(),
                username: "admin".to_string(),
                password: "secret".to_string(),
                insecure: false,
                created_at: "2026-06-24T00:00:00Z".to_string(),
                updated_at: "2026-06-24T00:00:00Z".to_string(),
            }],
        };
        write_profiles_to(&file, &config).unwrap();
        let stat = fs::metadata(&file).unwrap();
        assert_eq!(stat.permissions().mode() & 0o777, 0o600);
        assert_eq!(
            read_profiles_from(&file)
                .unwrap()
                .default_profile
                .as_deref(),
            Some("测试环境")
        );
    }

    #[test]
    fn migrates_legacy_profiles_without_deleting_source() {
        let dir = tempdir().unwrap();
        let new_file = dir.path().join(".workctl/profiles.json");
        let old_file = dir.path().join(".kslog/profiles.json");
        fs::create_dir_all(old_file.parent().unwrap()).unwrap();
        fs::write(&old_file, r#"{"defaultProfile":"测试","profiles":[]}"#).unwrap();
        assert!(migrate_legacy_profiles_if_needed(&new_file, &old_file).unwrap());
        assert!(old_file.exists());
        assert!(new_file.exists());
        assert!(!migrate_legacy_profiles_if_needed(&new_file, &old_file).unwrap());
    }
}
