use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::store::Store;

/// Una sesion viva: el extremo maestro del PTY mas lo necesario para
/// escribir, redimensionar y terminar el proceso hijo.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    /// Identificador elegido por el frontend, que asi puede suscribirse a la
    /// salida antes de que el proceso escriba su primer byte.
    pub id: String,
    /// Sesion persistida a la que pertenece este PTY: el id del PTY cambia en
    /// cada reinicio, pero el historial se acumula bajo el mismo registro.
    pub store_id: Option<String>,
    /// Programa a ejecutar. Si es `None` se usa el shell de inicio de sesion.
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize, Clone)]
struct ExitPayload {
    id: String,
    code: u32,
}

/// El shell interactivo por defecto de la plataforma.
fn default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        // PowerShell antes que cmd.exe: es lo que esperan los agentes y
        // maneja UTF-8 y colores sin configuración extra.
        (
            "powershell.exe".to_string(),
            vec!["-NoLogo".to_string()],
        )
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        // `-l` carga el perfil del usuario: sin eso los agentes instalados en
        // ~/.local/bin o via nvm no aparecen en el PATH.
        (shell, vec!["-l".into()])
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    manager: State<'_, Arc<PtyManager>>,
    options: SpawnOptions,
) -> Result<String, String> {
    if !options
        .id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
        || options.id.is_empty()
    {
        return Err("identificador de sesion invalido".into());
    }
    if manager.sessions.lock().unwrap().contains_key(&options.id) {
        return Err("identificador de sesion duplicado".into());
    }

    let pty_system = portable_pty::native_pty_system();
    let size = PtySize {
        rows: options.rows.max(1),
        cols: options.cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let (program, base_args) = match options.program {
        Some(p) if !p.trim().is_empty() => (p, options.args.clone()),
        _ => default_shell(),
    };

    let mut cmd = CommandBuilder::new(&program);
    for arg in base_args {
        cmd.arg(arg);
    }
    if let Some(cwd) = options.cwd.as_ref().filter(|c| !c.is_empty()) {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for (key, value) in &options.env {
        cmd.env(key, value);
    }

    let child: Box<dyn Child + Send + Sync> =
        pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = options.id;
    let store_id = options.store_id;

    manager.sessions.lock().unwrap().insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            killer,
        },
    );

    spawn_reader(app.clone(), id.clone(), store_id, reader);
    spawn_waiter(app, Arc::clone(&manager), id.clone(), child);

    Ok(id)
}

/// Bombea la salida del PTY hacia el frontend. Los bytes viajan en base64
/// porque una lectura puede cortar un caracter UTF-8 por la mitad; el
/// renderer los reensambla con un decoder incremental.
fn spawn_reader(
    app: AppHandle,
    id: String,
    store_id: Option<String>,
    mut reader: Box<dyn Read + Send>,
) {
    let store = store_id.and_then(|sid| {
        app.try_state::<Arc<Store>>()
            .map(|store| (sid, Arc::clone(&store)))
    });
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Some((session_id, store)) = &store {
                        store.append_output(session_id, &buf[..n]);
                    }
                    let payload = B64.encode(&buf[..n]);
                    if app.emit(&format!("pty://output/{id}"), payload).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

fn spawn_waiter(
    app: AppHandle,
    manager: Arc<PtyManager>,
    id: String,
    mut child: Box<dyn Child + Send + Sync>,
) {
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        manager.sessions.lock().unwrap().remove(&id);
        let _ = app.emit("pty://exit", ExitPayload { id, code });
    });
}

#[tauri::command]
pub fn pty_write(manager: State<'_, Arc<PtyManager>>, id: String, data: String) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("sesion inexistente")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, Arc<PtyManager>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = manager.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("sesion inexistente")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, Arc<PtyManager>>, id: String) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().unwrap();
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.killer.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn pty_list(manager: State<'_, Arc<PtyManager>>) -> Vec<String> {
    manager.sessions.lock().unwrap().keys().cloned().collect()
}

/// Directorio personal del usuario en cualquier plataforma.
pub fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

/// Extensiones que hacen ejecutable a un archivo. En Windows un agente
/// instalado por npm es un `.cmd`, no un archivo sin extension.
fn ejecutables() -> Vec<String> {
    if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(|ext| ext.to_lowercase())
            .collect()
    } else {
        vec![String::new()]
    }
}

/// Detecta que agentes estan instalados para no ofrecer perfiles que fallarian.
#[tauri::command]
pub fn which(program: String) -> Option<String> {
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();

    // La aplicacion no hereda el PATH del perfil del usuario, asi que se
    // anaden a mano los sitios habituales de los gestores de paquetes.
    if cfg!(not(windows)) {
        dirs.push("/opt/homebrew/bin".into());
        dirs.push("/usr/local/bin".into());
    }
    if let Some(home) = home_dir() {
        if cfg!(windows) {
            dirs.push(home.join("AppData/Roaming/npm"));
        } else {
            dirs.push(home.join(".local/bin"));
            dirs.push(home.join(".bun/bin"));
        }
    }

    let extensiones = ejecutables();
    dirs.into_iter()
        .flat_map(|dir| {
            extensiones
                .iter()
                .map(|ext| dir.join(format!("{program}{ext}")))
                .collect::<Vec<_>>()
        })
        .find(|candidato| candidato.is_file())
        .map(|candidato| candidato.to_string_lossy().into_owned())
}

/// Mata todo lo vivo al cerrar la ventana; sin esto quedan procesos huerfanos.
pub fn shutdown(app: &AppHandle) {
    if let Some(manager) = app.try_state::<Arc<PtyManager>>() {
        let mut sessions = manager.sessions.lock().unwrap();
        for (_, mut session) in sessions.drain() {
            let _ = session.killer.kill();
        }
    }
}
