//! Explorador de archivos: listado, operaciones y apertura en un editor.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Tope de entradas por carpeta. `node_modules` tiene decenas de miles y
/// pintarlas no ayuda a nadie; se avisa de que la lista viene recortada.
const MAX_ENTRADAS: usize = 2000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub hidden: bool,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub entries: Vec<Entry>,
    /// La carpeta tenía más entradas de las que se devuelven.
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Editor {
    pub id: String,
    pub label: String,
}

/// Editores de codigo que la aplicacion sabe abrir, si estan instalados.
#[tauri::command]
pub fn available_editors() -> Vec<Editor> {
    [("cursor", "Cursor"), ("code", "VS Code"), ("windsurf", "Windsurf"), ("subl", "Sublime Text"), ("zed", "Zed")]
        .into_iter()
        .filter(|(binario, _)| crate::pty::which((*binario).to_string()).is_some())
        .map(|(id, label)| Editor {
            id: id.to_string(),
            label: label.to_string(),
        })
        .collect()
}

#[tauri::command]
pub fn open_in_editor(editor: String, path: String) -> Result<(), String> {
    // Sólo se lanzan los editores de la lista: `editor` llega del frontend y
    // no debe poder convertirse en «ejecuta lo que quieras».
    if !available_editors().iter().any(|e| e.id == editor) {
        return Err("editor no disponible".into());
    }
    let binario = crate::pty::which(editor).ok_or("no se encontró el editor")?;
    std::process::Command::new(binario)
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn entrada(ruta: &Path) -> Option<Entry> {
    let name = ruta.file_name()?.to_str()?.to_string();
    let metadata = std::fs::symlink_metadata(ruta).ok()?;
    // Un enlace a una carpeta se recorre como carpeta.
    let is_dir = if metadata.file_type().is_symlink() {
        std::fs::metadata(ruta).map(|m| m.is_dir()).unwrap_or(false)
    } else {
        metadata.is_dir()
    };
    Some(Entry {
        hidden: name.starts_with('.'),
        path: ruta.to_string_lossy().into_owned(),
        size: if is_dir { 0 } else { metadata.len() },
        name,
        is_dir,
    })
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Listing, String> {
    let raiz = PathBuf::from(&path);
    let lectura = std::fs::read_dir(&raiz).map_err(|e| e.to_string())?;

    let mut entries: Vec<Entry> = Vec::new();
    let mut truncated = false;
    for elemento in lectura {
        if entries.len() >= MAX_ENTRADAS {
            truncated = true;
            break;
        }
        if let Some(entrada) = elemento.ok().and_then(|e| entrada(&e.path())) {
            entries.push(entrada);
        }
    }

    // Carpetas primero y, dentro de cada grupo, por nombre sin distinguir
    // mayúsculas: es el orden que espera cualquiera que venga de un editor.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(Listing {
        path: raiz.to_string_lossy().into_owned(),
        entries,
        truncated,
    })
}

/// Comprueba que un nombre nuevo es un nombre y no una ruta.
fn nombre_valido(nombre: &str) -> Result<(), String> {
    if nombre.trim().is_empty() {
        return Err("el nombre está vacío".into());
    }
    if nombre.contains('/') || nombre.contains('\\') || nombre == "." || nombre == ".." {
        return Err("el nombre no puede contener separadores de ruta".into());
    }
    Ok(())
}

#[tauri::command]
pub fn create_entry(parent: String, name: String, is_dir: bool) -> Result<String, String> {
    nombre_valido(&name)?;
    let destino = PathBuf::from(parent).join(&name);
    if destino.exists() {
        return Err(format!("«{name}» ya existe"));
    }
    if is_dir {
        std::fs::create_dir(&destino).map_err(|e| e.to_string())?;
    } else {
        std::fs::File::create(&destino).map_err(|e| e.to_string())?;
    }
    Ok(destino.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn rename_entry(path: String, name: String) -> Result<String, String> {
    nombre_valido(&name)?;
    let origen = PathBuf::from(&path);
    let destino = origen
        .parent()
        .ok_or("no se puede renombrar la raíz")?
        .join(&name);
    if destino == origen {
        return Ok(path);
    }
    if destino.exists() {
        return Err(format!("«{name}» ya existe"));
    }
    std::fs::rename(&origen, &destino).map_err(|e| e.to_string())?;
    Ok(destino.to_string_lossy().into_owned())
}

/// Copia junto al original, buscando un nombre libre («notas copia 2.md»).
#[tauri::command]
pub fn duplicate_entry(path: String) -> Result<String, String> {
    let origen = PathBuf::from(&path);
    let padre = origen.parent().ok_or("no se puede duplicar la raíz")?;
    let tallo = origen
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("nombre ilegible")?;
    let extension = origen.extension().and_then(|s| s.to_str());

    let mut destino = PathBuf::new();
    for intento in 1..1000 {
        let sufijo = if intento == 1 {
            " copia".to_string()
        } else {
            format!(" copia {intento}")
        };
        let nombre = match extension {
            Some(ext) => format!("{tallo}{sufijo}.{ext}"),
            None => format!("{tallo}{sufijo}"),
        };
        destino = padre.join(nombre);
        if !destino.exists() {
            break;
        }
    }

    if origen.is_dir() {
        copiar_arbol(&origen, &destino).map_err(|e| e.to_string())?;
    } else {
        std::fs::copy(&origen, &destino).map_err(|e| e.to_string())?;
    }
    Ok(destino.to_string_lossy().into_owned())
}

fn copiar_arbol(origen: &Path, destino: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(destino)?;
    for elemento in std::fs::read_dir(origen)? {
        let elemento = elemento?;
        let hijo = destino.join(elemento.file_name());
        if elemento.file_type()?.is_dir() {
            copiar_arbol(&elemento.path(), &hijo)?;
        } else {
            std::fs::copy(elemento.path(), hijo)?;
        }
    }
    Ok(())
}

/// A la papelera del sistema, nunca un borrado definitivo: si el usuario se
/// equivoca, lo recupera desde el Finder o el Explorador.
#[tauri::command]
pub fn trash_entry(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporal(nombre: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("multiagentes-files-{}-{nombre}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lista_carpetas_primero_y_marca_las_ocultas() {
        let dir = temporal("listado");
        std::fs::write(dir.join("zeta.txt"), "x").unwrap();
        std::fs::write(dir.join("Alfa.txt"), "xx").unwrap();
        std::fs::write(dir.join(".oculto"), "x").unwrap();
        std::fs::create_dir(dir.join("subcarpeta")).unwrap();

        let listado = list_dir(dir.to_string_lossy().into()).unwrap();
        let nombres: Vec<&str> = listado.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(nombres, ["subcarpeta", ".oculto", "Alfa.txt", "zeta.txt"]);
        assert!(listado.entries[1].hidden);
        assert!(listado.entries[0].is_dir);
        assert_eq!(listado.entries[2].size, 2);
        assert!(!listado.truncated);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicar_busca_un_nombre_libre() {
        let dir = temporal("duplicar");
        let archivo = dir.join("notas.md");
        std::fs::write(&archivo, "contenido").unwrap();

        let primera = duplicate_entry(archivo.to_string_lossy().into()).unwrap();
        assert!(primera.ends_with("notas copia.md"), "{primera}");
        let segunda = duplicate_entry(archivo.to_string_lossy().into()).unwrap();
        assert!(segunda.ends_with("notas copia 2.md"), "{segunda}");
        assert_eq!(std::fs::read_to_string(primera).unwrap(), "contenido");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn renombrar_rechaza_rutas_y_nombres_ocupados() {
        let dir = temporal("renombrar");
        let archivo = dir.join("uno.txt");
        std::fs::write(&archivo, "x").unwrap();
        std::fs::write(dir.join("dos.txt"), "x").unwrap();

        let ruta: String = archivo.to_string_lossy().into();
        assert!(rename_entry(ruta.clone(), "../fuera.txt".into()).is_err());
        assert!(rename_entry(ruta.clone(), "".into()).is_err());
        assert!(rename_entry(ruta.clone(), "dos.txt".into()).is_err());

        let nuevo = rename_entry(ruta, "tres.txt".into()).unwrap();
        assert!(nuevo.ends_with("tres.txt"));
        assert!(dir.join("tres.txt").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn crear_no_pisa_lo_que_ya_existe() {
        let dir = temporal("crear");
        let padre: String = dir.to_string_lossy().into();
        create_entry(padre.clone(), "nuevo.txt".into(), false).unwrap();
        assert!(create_entry(padre.clone(), "nuevo.txt".into(), false).is_err());
        create_entry(padre, "carpeta".into(), true).unwrap();
        assert!(dir.join("carpeta").is_dir());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
