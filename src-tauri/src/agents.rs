//! Descubrimiento de conversaciones ya existentes de los agentes.
//!
//! Cada agente guarda sus conversaciones a su manera, asi que aqui vive una
//! funcion por agente que devuelve los ids de las conversaciones de una
//! carpeta, de la mas reciente a la mas antigua. El frontend reparte esos ids
//! entre las pestanas al restaurarlas.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

/// Tope para las consultas que lanzan un proceso externo: si el agente se
/// cuelga, la restauracion no debe quedarse esperando.
const CONSULTA_MAX: Duration = Duration::from_secs(8);

#[tauri::command]
pub fn conversations_for(profile_id: String, cwd: String) -> Vec<String> {
    match profile_id.as_str() {
        "claude" => claude_conversations(&cwd),
        "opencode" => opencode_conversations(&cwd),
        _ => Vec::new(),
    }
}

/// Reserva una conversacion nueva pidiendosela al propio agente.
///
/// Cursor no deja fijar el id al arrancar, pero sabe crear un chat vacio y
/// devolver el suyo; con eso la pestana queda atada a esa conversacion desde
/// el primer momento, igual que Claude Code con su `--session-id`.
#[tauri::command]
pub fn create_conversation(profile_id: String, cwd: String) -> Option<String> {
    if profile_id != "cursor" {
        return None;
    }
    let binario = crate::pty::which("cursor-agent".into())?;
    let salida = ejecutar_con_tope(Command::new(binario).arg("create-chat").current_dir(&cwd))?;
    let id = salida.trim();
    // La CLI imprime el identificador y nada mas; cualquier otra cosa
    // (un aviso de sesion caducada, por ejemplo) se descarta.
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        Some(id.to_string())
    } else {
        None
    }
}

/* ---------- Claude Code ---------- */

/// Nombre del directorio de proyecto que usa Claude Code para una ruta.
fn project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Claude Code guarda cada conversacion en
/// `~/.claude/projects/<carpeta>/<uuid>.jsonl`.
fn claude_conversations(cwd: &str) -> Vec<String> {
    let Some(home) = crate::pty::home_dir() else {
        return Vec::new();
    };
    let dir = home
        .join(".claude")
        .join("projects")
        .join(project_slug(cwd));

    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut encontradas: Vec<(SystemTime, String)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension()? != "jsonl" {
                return None;
            }
            // Una transcripcion practicamente vacia no sirve para reanudar.
            let metadata = entry.metadata().ok()?;
            if metadata.len() < 128 {
                return None;
            }
            Some((metadata.modified().ok()?, path.file_stem()?.to_str()?.to_string()))
        })
        .collect();

    encontradas.sort_by(|a, b| b.0.cmp(&a.0));
    encontradas.into_iter().map(|(_, id)| id).collect()
}

/* ---------- opencode ---------- */

/// opencode expone sus sesiones por CLI, con la carpeta de cada una. Se usa
/// el formato JSON, que es contrato publico, en vez de leer su base interna.
fn opencode_conversations(cwd: &str) -> Vec<String> {
    let Some(binario) = crate::pty::which("opencode".into()) else {
        return Vec::new();
    };

    let salida = match ejecutar_con_tope(
        Command::new(binario)
            .args(["session", "list", "--format", "json", "-n", "200"])
            .current_dir(cwd),
    ) {
        Some(salida) => salida,
        None => return Vec::new(),
    };

    let Ok(sesiones) = serde_json::from_str::<Vec<serde_json::Value>>(&salida) else {
        return Vec::new();
    };

    let objetivo = std::fs::canonicalize(cwd).ok();
    let mut encontradas: Vec<(i64, String)> = sesiones
        .iter()
        .filter(|sesion| {
            let Some(directorio) = sesion.get("directory").and_then(|d| d.as_str()) else {
                return false;
            };
            // Se comparan rutas resueltas: el cwd puede llegar con enlaces
            // simbolicos («/tmp» frente a «/private/tmp») o barra final.
            match (&objetivo, std::fs::canonicalize(directorio).ok()) {
                (Some(a), Some(b)) => a == &b,
                _ => directorio == cwd,
            }
        })
        .filter_map(|sesion| {
            Some((
                sesion.get("updated").and_then(|u| u.as_i64()).unwrap_or(0),
                sesion.get("id")?.as_str()?.to_string(),
            ))
        })
        .collect();

    encontradas.sort_by(|a, b| b.0.cmp(&a.0));
    encontradas.into_iter().map(|(_, id)| id).collect()
}

/// Lanza un proceso y devuelve su salida estandar, matandolo si tarda de mas.
fn ejecutar_con_tope(comando: &mut Command) -> Option<String> {
    let mut hijo = comando
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let limite = Instant::now() + CONSULTA_MAX;
    loop {
        match hijo.try_wait() {
            Ok(Some(estado)) if estado.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if Instant::now() >= limite => {
                let _ = hijo.kill();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
        }
    }

    let mut salida = String::new();
    use std::io::Read as _;
    hijo.stdout.take()?.read_to_string(&mut salida).ok()?;
    Some(salida)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_ruta_se_convierte_en_el_nombre_de_carpeta_de_claude() {
        assert_eq!(
            project_slug("/Users/sebastianveliz/mediahuella/apro-click"),
            "-Users-sebastianveliz-mediahuella-apro-click"
        );
        // Los puntos y los guiones bajos también son separadores.
        assert_eq!(project_slug("/tmp/mi_proyecto.v2"), "-tmp-mi-proyecto-v2");
    }

    #[test]
    fn un_agente_sin_soporte_no_devuelve_conversaciones() {
        assert!(conversations_for("aider".into(), "/tmp".into()).is_empty());
        // Cursor guarda sus chats en la nube: no hay nada que listar por
        // carpeta, el id se reserva al crear la pestaña.
        assert!(conversations_for("cursor".into(), "/tmp".into()).is_empty());
    }

    #[test]
    fn solo_cursor_reserva_conversacion_por_cli() {
        assert_eq!(create_conversation("claude".into(), "/tmp".into()), None);
        assert_eq!(create_conversation("shell".into(), "/tmp".into()), None);
    }
}
