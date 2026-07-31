use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_THEME_COUNT: usize = 100;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThemeManifest {
    schema_version: u32,
    id: String,
    display_name: Option<String>,
    description: Option<String>,
    mode: Option<String>,
    art: Option<String>,
    preview: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePackView {
    id: String,
    display_name: String,
    description: String,
    mode: String,
    has_art: bool,
    has_preview: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeLibraryView {
    root: String,
    themes: Vec<ThemePackView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeAssetView {
    mime_type: String,
    base64: String,
}

fn theme_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".codexthemes").join("themes"))
        .ok_or_else(|| "无法定位用户主目录".to_string())
}

fn safe_relative_path(raw: &str) -> Option<PathBuf> {
    let path = Path::new(raw);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return None;
    }
    let safe = path.components().all(|component| {
        matches!(component, Component::Normal(_) | Component::CurDir)
    });
    safe.then(|| path.to_path_buf())
}

fn read_manifest(theme_dir: &Path) -> Result<ThemeManifest, String> {
    let path = theme_dir.join("theme.json");
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err("主题清单超过 1 MB".to_string());
    }
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let manifest: ThemeManifest =
        serde_json::from_str(&content).map_err(|error| error.to_string())?;
    if manifest.schema_version != 1 || manifest.id.trim().is_empty() {
        return Err("不支持的主题清单".to_string());
    }
    Ok(manifest)
}

fn list_theme_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .map(|_| entry.path())
        })
        .take(MAX_THEME_COUNT)
        .collect()
}

fn asset_exists(theme_dir: &Path, relative: Option<&str>) -> bool {
    relative
        .and_then(safe_relative_path)
        .map(|path| theme_dir.join(path).is_file())
        .unwrap_or(false)
}

fn find_theme(root: &Path, theme_id: &str) -> Result<(PathBuf, ThemeManifest), String> {
    for theme_dir in list_theme_dirs(root) {
        if let Ok(manifest) = read_manifest(&theme_dir) {
            if manifest.id == theme_id {
                return Ok((theme_dir, manifest));
            }
        }
    }
    Err("主题不存在或清单无效".to_string())
}

fn resolve_asset(theme_dir: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative =
        safe_relative_path(relative).ok_or_else(|| "主题素材路径不安全".to_string())?;
    let root = theme_dir
        .canonicalize()
        .map_err(|error| format!("主题目录不可用: {error}"))?;
    let asset = theme_dir
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("主题素材不可用: {error}"))?;
    if !asset.starts_with(&root) || !asset.is_file() {
        return Err("主题素材路径越界".to_string());
    }
    let metadata = fs::metadata(&asset).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_ASSET_BYTES {
        return Err("主题素材超过 16 MB".to_string());
    }
    Ok(asset)
}

fn mime_type(path: &Path) -> Result<&'static str, String> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => Ok("image/png"),
        Some("jpg") | Some("jpeg") => Ok("image/jpeg"),
        Some("webp") => Ok("image/webp"),
        _ => Err("仅支持 PNG、JPEG 或 WebP 主题素材".to_string()),
    }
}

#[tauri::command]
pub fn theme_list() -> Result<ThemeLibraryView, String> {
    let root = theme_root()?;
    let mut themes = list_theme_dirs(&root)
        .into_iter()
        .filter_map(|theme_dir| {
            let manifest = read_manifest(&theme_dir).ok()?;
            let has_art = asset_exists(&theme_dir, manifest.art.as_deref());
            let has_preview = asset_exists(&theme_dir, manifest.preview.as_deref());
            Some(ThemePackView {
                display_name: manifest
                    .display_name
                    .clone()
                    .unwrap_or_else(|| manifest.id.clone()),
                id: manifest.id,
                description: manifest.description.unwrap_or_default(),
                mode: manifest.mode.unwrap_or_else(|| "dark".to_string()),
                has_art,
                has_preview,
            })
        })
        .collect::<Vec<_>>();
    themes.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    Ok(ThemeLibraryView {
        root: root.to_string_lossy().into_owned(),
        themes,
    })
}

#[tauri::command]
pub fn theme_load_asset(theme_id: String, kind: String) -> Result<ThemeAssetView, String> {
    let root = theme_root()?;
    let (theme_dir, manifest) = find_theme(&root, &theme_id)?;
    let relative = match kind.as_str() {
        "art" => manifest.art.as_deref(),
        "preview" => manifest
            .preview
            .as_deref()
            .filter(|path| asset_exists(&theme_dir, Some(path)))
            .or(manifest.art.as_deref()),
        _ => return Err("未知的主题素材类型".to_string()),
    }
    .ok_or_else(|| "主题未提供对应素材".to_string())?;
    let path = resolve_asset(&theme_dir, relative)?;
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    Ok(ThemeAssetView {
        mime_type: mime_type(&path)?.to_string(),
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

#[tauri::command]
pub fn theme_open_folder() -> Result<(), String> {
    let root = theme_root()?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&root)
        .spawn()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&root)
        .spawn()
        .map_err(|error| error.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&root)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_asset_paths_reject_absolute_and_parent_components() {
        assert!(safe_relative_path("assets/artwork.png").is_some());
        assert!(safe_relative_path("../outside.png").is_none());
        assert!(safe_relative_path("assets/../../outside.png").is_none());
        assert!(safe_relative_path("C:\\outside.png").is_none());
    }

    #[test]
    fn theme_assets_only_allow_raster_background_formats() {
        assert_eq!(mime_type(Path::new("art.PNG")).unwrap(), "image/png");
        assert_eq!(mime_type(Path::new("art.webp")).unwrap(), "image/webp");
        assert!(mime_type(Path::new("theme.svg")).is_err());
    }
}
