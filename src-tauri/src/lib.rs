use std::fs;
use std::path::PathBuf;

mod raw;

fn err(e: std::io::Error) -> String {
    format!("{e}")
}

/// Read a whole file as raw bytes (images, manifests).
#[tauri::command]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(err)
}

/// Read a UTF-8 text file.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(err)
}

/// Write bytes to a file, replacing it.
#[tauri::command]
fn write_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::write(&path, bytes).map_err(err)
}

/// Atomically replace a file: write to a temp sibling, then rename over the target.
/// A reader sees either the old or the new file, never a partial one.
#[tauri::command]
fn write_file_atomic(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let tmp = target.with_extension("json.tmp");
    fs::write(&tmp, &bytes).map_err(err)?;
    fs::rename(&tmp, &target).map_err(err)
}

/// List the direct children of a directory (file and folder names).
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(&path).map_err(err)?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(err)?;
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    Ok(names)
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

#[tauri::command]
fn make_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(err)
}

#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(_) => fs::remove_dir_all(&path).map_err(err),
    }
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    fs::rename(&from, &to).map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            read_text_file,
            write_file,
            write_file_atomic,
            list_dir,
            path_exists,
            make_dir,
            remove_file,
            rename_path,
            raw::raw_metadata,
            raw::develop_raw
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
