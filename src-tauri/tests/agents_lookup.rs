//! Comprueba el listado de conversaciones contra un `~/.claude/projects` falso.
//! Va en su propio binario de test porque sobrescribe HOME para el proceso.
use std::fs;
use std::path::Path;

use multiagentes_lib::agents::conversations_for;

fn escribir(dir: &Path, nombre: &str, bytes: usize) {
    fs::write(dir.join(nombre), "x".repeat(bytes)).unwrap();
}

#[test]
fn lista_las_conversaciones_de_claude_de_la_mas_reciente_a_la_mas_antigua() {
    let home = std::env::temp_dir().join(format!("multiagentes-agents-{}", std::process::id()));
    let _ = fs::remove_dir_all(&home);
    let dir = home.join(".claude/projects/-Users-alguien-proyecto-demo");
    fs::create_dir_all(&dir).unwrap();
    std::env::set_var("HOME", &home);

    let cwd = "/Users/alguien/proyecto/demo".to_string();

    // Sin conversaciones no hay nada que reanudar.
    assert!(conversations_for("claude".into(), cwd.clone()).is_empty());

    escribir(&dir, "11111111-1111-4111-8111-111111111111.jsonl", 4096);
    std::thread::sleep(std::time::Duration::from_millis(1100));
    escribir(&dir, "22222222-2222-4222-8222-222222222222.jsonl", 4096);
    // Una transcripción casi vacía (conversación abierta y cerrada sin
    // escribir nada) no sirve para reanudar y no debe aparecer.
    escribir(&dir, "33333333-3333-4333-8333-333333333333.jsonl", 12);
    // Los archivos que no son transcripciones se ignoran.
    escribir(&dir, "notas.txt", 4096);

    assert_eq!(
        conversations_for("claude".into(), cwd.clone()),
        [
            "22222222-2222-4222-8222-222222222222",
            "11111111-1111-4111-8111-111111111111"
        ]
    );

    // Otra carpeta del mismo equipo no comparte conversaciones.
    assert!(conversations_for("claude".into(), "/Users/alguien/otro".into()).is_empty());

    let _ = fs::remove_dir_all(&home);
}

/// Consulta la instalación real de opencode. Se ejecuta a petición
/// (`cargo test -- --ignored`) porque depende de las sesiones del equipo.
#[test]
#[ignore]
fn smoke_opencode() {
    let Ok(cwd) = std::env::var("OPENCODE_TEST_CWD") else {
        println!("sin OPENCODE_TEST_CWD: nada que comprobar");
        return;
    };
    let ids = conversations_for("opencode".into(), cwd.clone());
    println!("conversaciones de opencode en {cwd}: {ids:?}");
    assert!(!ids.is_empty(), "no se encontró ninguna sesión de opencode");
    assert!(ids.iter().all(|id| id.starts_with("ses_")));
}

/// Consulta la instalación real de Cursor. Se ejecuta a petición
/// (`cargo test -- --ignored`) porque crea un chat vacío en la cuenta.
#[test]
#[ignore]
fn smoke_cursor() {
    use multiagentes_lib::agents::create_conversation;

    let id = create_conversation("cursor".into(), std::env::temp_dir().to_string_lossy().into())
        .expect("cursor-agent create-chat no devolvió ningún identificador");
    println!("chat creado: {id}");
    assert_eq!(id.len(), 36, "no parece un UUID: {id}");
    assert_eq!(id.matches('-').count(), 4, "no parece un UUID: {id}");
}
