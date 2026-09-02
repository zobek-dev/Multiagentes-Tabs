//! Persistencia de sesiones en SQLite: metadatos de cada pestana y el
//! historial de salida de su terminal, para poder reanudarlas al reabrir.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// Tope de historial guardado por sesion. Por encima se podan los trozos mas
/// antiguos; con 512 KB entran varios miles de lineas de salida.
const MAX_OUTPUT_BYTES: i64 = 512 * 1024;
/// Cada cuanto se vuelca a disco lo acumulado en memoria.
const FLUSH_INTERVAL: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub profile_id: String,
    pub command: String,
    /// Id de la conversación del agente, si el agente permite fijarlo.
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub position: i64,
    #[serde(default)]
    pub active: bool,
}



enum Job {
    Append { session_id: String, data: Vec<u8> },
    /// Vuelca lo pendiente y avisa: se usa al cerrar, donde el proceso muere
    /// antes de que salte el temporizador.
    Flush(Sender<()>),
}

pub struct Store {
    conn: Arc<Mutex<Connection>>,
    writer: Sender<Job>,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl Store {
    pub fn open(path: PathBuf) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        // WAL: el hilo de volcado escribe sin bloquear las lecturas de la UI.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sessions (
                 id         TEXT PRIMARY KEY,
                 name       TEXT NOT NULL,
                 cwd        TEXT NOT NULL,
                 profile_id TEXT NOT NULL,
                 command    TEXT NOT NULL,
                 position   INTEGER NOT NULL DEFAULT 0,
                 active     INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS output (
                 id         INTEGER PRIMARY KEY AUTOINCREMENT,
                 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                 data       BLOB NOT NULL
             );
             CREATE INDEX IF NOT EXISTS output_by_session ON output (session_id, id);",
        )?;
        migrate(&conn)?;

        let conn = Arc::new(Mutex::new(conn));
        let (tx, rx) = mpsc::channel::<Job>();
        let writer_conn = Arc::clone(&conn);

        // Un unico hilo agrupa la salida: escribir cada lectura del PTY por
        // separado saturaria el disco con transacciones diminutas.
        std::thread::spawn(move || {
            let mut buffers: HashMap<String, Vec<u8>> = HashMap::new();
            let mut last_flush = Instant::now();
            loop {
                match rx.recv_timeout(FLUSH_INTERVAL) {
                    Ok(Job::Append { session_id, data }) => {
                        buffers.entry(session_id).or_default().extend_from_slice(&data);
                    }
                    Ok(Job::Flush(ack)) => {
                        flush(&writer_conn, &mut buffers);
                        last_flush = Instant::now();
                        let _ = ack.send(());
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        flush(&writer_conn, &mut buffers);
                        return;
                    }
                }
                if last_flush.elapsed() >= FLUSH_INTERVAL && !buffers.is_empty() {
                    flush(&writer_conn, &mut buffers);
                    last_flush = Instant::now();
                }
            }
        });

        Ok(Store { conn, writer: tx })
    }

    pub fn append_output(&self, session_id: &str, data: &[u8]) {
        let _ = self.writer.send(Job::Append {
            session_id: session_id.to_string(),
            data: data.to_vec(),
        });
    }

    /// Espera a que el historial pendiente llegue a disco (con tope de 3 s
    /// para no colgar el cierre de la ventana si el hilo esta ocupado).
    pub fn flush(&self) {
        let (tx, rx) = mpsc::channel();
        if self.writer.send(Job::Flush(tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(3));
        }
    }

    pub fn save(&self, record: &SessionRecord) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let ts = now();
        conn.execute(
            "INSERT INTO sessions
                 (id, name, cwd, profile_id, command, conversation_id, position, active, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 cwd = excluded.cwd,
                 profile_id = excluded.profile_id,
                 command = excluded.command,
                 conversation_id = excluded.conversation_id,
                 position = excluded.position,
                 active = excluded.active,
                 updated_at = excluded.updated_at",
            params![
                record.id,
                record.name,
                record.cwd,
                record.profile_id,
                record.command,
                record.conversation_id,
                record.position,
                record.active as i64,
                ts
            ],
        )?;
        if record.active {
            conn.execute("UPDATE sessions SET active = 0 WHERE id <> ?1", params![record.id])?;
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn clear_output(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM output WHERE session_id = ?1", params![id])?;
        Ok(())
    }

    pub fn set_order(&self, ids: &[String]) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for (index, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE sessions SET position = ?1 WHERE id = ?2",
                params![index as i64, id],
            )?;
        }
        tx.commit()
    }

    pub fn set_active(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET active = (id = ?1)", params![id])?;
        Ok(())
    }

    /// Devuelve las sesiones en orden, sin su historial.
    ///
    /// El historial se pide aparte, cuando la pestaña se abre: cargar la cola
    /// de todas al arrancar significaba decenas de megabytes en memoria y una
    /// espera proporcional al número de pestañas.
    pub fn load(&self) -> rusqlite::Result<Vec<SessionRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, cwd, profile_id, command, conversation_id, position, active
             FROM sessions ORDER BY position, created_at",
        )?;
        let records: Vec<SessionRecord> = stmt
            .query_map([], |row| {
                Ok(SessionRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    cwd: row.get(2)?,
                    profile_id: row.get(3)?,
                    command: row.get(4)?,
                    conversation_id: row.get(5)?,
                    position: row.get(6)?,
                    active: row.get::<_, i64>(7)? != 0,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;

        Ok(records)
    }

    /// Cola del historial de una sesión, en base64.
    pub fn output(&self, id: &str, tail_bytes: i64) -> rusqlite::Result<String> {
        let conn = self.conn.lock().unwrap();
        Ok(B64.encode(read_tail(&conn, id, tail_bytes)?))
    }
}

/// Anade las columnas que faltan en bases creadas por versiones anteriores.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(sessions)")?;
    let columnas: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<_>>()?;
    if !columnas.iter().any(|c| c == "conversation_id") {
        conn.execute("ALTER TABLE sessions ADD COLUMN conversation_id TEXT", [])?;
    }
    Ok(())
}

/// Ultimos `limit` bytes del historial, respetando los limites de cada trozo
/// para no cortar una secuencia de escape por la mitad.
fn read_tail(conn: &Connection, session_id: &str, limit: i64) -> rusqlite::Result<Vec<u8>> {
    let mut stmt = conn.prepare(
        "SELECT data FROM output WHERE session_id = ?1 ORDER BY id DESC",
    )?;
    let mut chunks: Vec<Vec<u8>> = Vec::new();
    let mut total: i64 = 0;
    let mut rows = stmt.query(params![session_id])?;
    while let Some(row) = rows.next()? {
        let data: Vec<u8> = row.get(0)?;
        total += data.len() as i64;
        chunks.push(data);
        if total >= limit {
            break;
        }
    }
    chunks.reverse();
    Ok(chunks.concat())
}

fn flush(conn: &Arc<Mutex<Connection>>, buffers: &mut HashMap<String, Vec<u8>>) {
    let mut conn = match conn.lock() {
        Ok(conn) => conn,
        Err(_) => return,
    };
    let tx = match conn.transaction() {
        Ok(tx) => tx,
        Err(_) => return,
    };
    for (session_id, data) in buffers.drain() {
        if data.is_empty() {
            continue;
        }
        // La sesion puede haberse borrado mientras el buffer esperaba: la
        // clave foranea rechaza la fila y el error se ignora a proposito.
        let _ = tx.execute(
            "INSERT INTO output (session_id, data) VALUES (?1, ?2)",
            params![session_id, data],
        );
        let _ = prune(&tx, &session_id);
    }
    let _ = tx.commit();
}

/// Descarta los trozos mas antiguos que exceden el tope de la sesion.
fn prune(tx: &rusqlite::Transaction<'_>, session_id: &str) -> rusqlite::Result<()> {
    let total: i64 = tx.query_row(
        "SELECT COALESCE(SUM(LENGTH(data)), 0) FROM output WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;
    if total <= MAX_OUTPUT_BYTES {
        return Ok(());
    }
    tx.execute(
        "DELETE FROM output WHERE id IN (
             SELECT id FROM (
                 SELECT id, SUM(LENGTH(data)) OVER (ORDER BY id DESC) AS acumulado
                 FROM output WHERE session_id = ?1
             ) WHERE acumulado > ?2
         )",
        params![session_id, MAX_OUTPUT_BYTES],
    )?;
    Ok(())
}

/* ---------- Comandos expuestos al frontend ---------- */

/// Cuanto historial se devuelve al restaurar. Menos que lo guardado: basta
/// para dar contexto y evita que el xterm procese medio megabyte al arrancar.
const RESTORE_TAIL_BYTES: i64 = 64 * 1024;

#[tauri::command]
pub fn sessions_load(store: tauri::State<'_, Arc<Store>>) -> Result<Vec<SessionRecord>, String> {
    store.load().map_err(|e| e.to_string())
}

/// Historial de una sesión concreta, al abrir su pestaña.
#[tauri::command]
pub fn session_output(store: tauri::State<'_, Arc<Store>>, id: String) -> Result<String, String> {
    store.output(&id, RESTORE_TAIL_BYTES).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_save(
    store: tauri::State<'_, Arc<Store>>,
    session: SessionRecord,
) -> Result<(), String> {
    store.save(&session).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_delete(store: tauri::State<'_, Arc<Store>>, id: String) -> Result<(), String> {
    store.delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_clear_output(
    store: tauri::State<'_, Arc<Store>>,
    id: String,
) -> Result<(), String> {
    store.clear_output(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sessions_set_order(
    store: tauri::State<'_, Arc<Store>>,
    ids: Vec<String>,
) -> Result<(), String> {
    store.set_order(&ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_set_active(store: tauri::State<'_, Arc<Store>>, id: String) -> Result<(), String> {
    store.set_active(&id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, position: i64) -> SessionRecord {
        SessionRecord {
            id: id.into(),
            name: format!("Sesión {id}"),
            cwd: "/tmp".into(),
            profile_id: "claude".into(),
            command: "claude".into(),
            conversation_id: None,
            position,
            active: false,
        }
    }

    fn store() -> (Store, tempdir::Guard) {
        let guard = tempdir::Guard::new();
        (Store::open(guard.path().join("test.sqlite3")).unwrap(), guard)
    }

    #[test]
    fn guarda_y_restaura_sesiones_en_orden() {
        let (store, _guard) = store();
        store.save(&record("b", 1)).unwrap();
        store.save(&record("a", 0)).unwrap();

        let cargadas = store.load().unwrap();
        assert_eq!(
            cargadas.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(cargadas[0].name, "Sesión a");
    }

    #[test]
    fn el_historial_sobrevive_y_se_devuelve_la_cola() {
        let (store, _guard) = store();
        store.save(&record("a", 0)).unwrap();
        store.append_output("a", b"primera linea\n");
        store.append_output("a", b"segunda linea con acentos: aeiou\n");
        store.flush();

        let salida = String::from_utf8(B64.decode(store.output("a", 4096).unwrap()).unwrap()).unwrap();
        assert!(salida.contains("primera linea"), "salida: {salida}");
        assert!(salida.ends_with("acentos: aeiou\n"), "salida: {salida}");
    }

    #[test]
    fn el_historial_se_poda_al_superar_el_tope() {
        let (store, _guard) = store();
        store.save(&record("a", 0)).unwrap();
        // 40 trozos de 32 KB = 1.25 MB, mas del doble del tope.
        let bloque = vec![b'x'; 32 * 1024];
        for _ in 0..40 {
            store.append_output("a", &bloque);
            store.flush();
        }

        let conn = store.conn.lock().unwrap();
        let total: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(data)), 0) FROM output WHERE session_id = 'a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(total <= MAX_OUTPUT_BYTES, "quedaron {total} bytes guardados");
        assert!(total > MAX_OUTPUT_BYTES / 2, "se podó de más: {total} bytes");
    }

    #[test]
    fn el_id_de_conversacion_va_y_vuelve() {
        let (store, _guard) = store();
        let mut r = record("a", 0);
        r.conversation_id = Some("3f2a1b0c-0000-4000-8000-000000000001".into());
        store.save(&r).unwrap();

        let cargada = &store.load().unwrap()[0];
        assert_eq!(cargada.conversation_id.as_deref(), Some("3f2a1b0c-0000-4000-8000-000000000001"));
    }

    #[test]
    fn una_base_antigua_gana_la_columna_de_conversacion() {
        let guard = tempdir::Guard::new();
        let path = guard.path().join("antigua.sqlite3");
        // Esquema tal como lo creaba la versión previa, sin conversation_id.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE sessions (
                     id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL,
                     profile_id TEXT NOT NULL, command TEXT NOT NULL,
                     position INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0,
                     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 INSERT INTO sessions VALUES ('vieja','Antigua','/tmp','claude','claude',0,1,0,0);",
            )
            .unwrap();
        }

        let store = Store::open(path).unwrap();
        let cargadas = store.load().unwrap();
        assert_eq!(cargadas.len(), 1);
        assert_eq!(cargadas[0].name, "Antigua");
        assert_eq!(cargadas[0].conversation_id, None);
    }

    #[test]
    fn borrar_una_sesion_arrastra_su_historial() {
        let (store, _guard) = store();
        store.save(&record("a", 0)).unwrap();
        store.append_output("a", b"hola");
        store.flush();
        store.delete("a").unwrap();

        let conn = store.conn.lock().unwrap();
        let filas: i64 = conn
            .query_row("SELECT COUNT(*) FROM output", [], |row| row.get(0))
            .unwrap();
        assert_eq!(filas, 0, "el historial quedó huérfano");
    }

    #[test]
    fn solo_una_sesion_queda_marcada_como_activa() {
        let (store, _guard) = store();
        store.save(&record("a", 0)).unwrap();
        store.save(&record("b", 1)).unwrap();
        store.set_active("a").unwrap();
        store.set_active("b").unwrap();

        let activas: Vec<String> = store
            .load()
            .unwrap()
            .into_iter()
            .filter(|s| s.active)
            .map(|s| s.id)
            .collect();
        assert_eq!(activas, ["b"]);
    }

    /// Directorio temporal propio: evita sumar una dependencia sólo para esto.
    mod tempdir {
        use std::path::{Path, PathBuf};

        pub struct Guard(PathBuf);

        impl Guard {
            pub fn new() -> Self {
                let path = std::env::temp_dir().join(format!(
                    "multiagentes-test-{}-{:?}",
                    std::process::id(),
                    std::thread::current().id()
                ));
                let _ = std::fs::remove_dir_all(&path);
                std::fs::create_dir_all(&path).unwrap();
                Guard(path)
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Guard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}
