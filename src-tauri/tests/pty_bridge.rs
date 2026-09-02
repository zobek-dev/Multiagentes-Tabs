//! Comprueba el mismo flujo que usa la aplicacion: abrir un PTY, lanzar el
//! shell de inicio de sesion en un directorio dado, escribirle un comando y
//! leer la salida.
use std::io::{Read, Write};
use std::time::{Duration, Instant};

use portable_pty::{CommandBuilder, PtySize};

#[test]
fn el_shell_ejecuta_comandos_en_el_cwd_indicado() {
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("no se pudo abrir el pty");

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.cwd("/usr");
    cmd.env("TERM", "xterm-256color");

    let mut child = pair.slave.spawn_command(cmd).expect("no se pudo lanzar el shell");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();

    std::thread::sleep(Duration::from_millis(400));
    writer.write_all(b"pwd && echo LISTO-\xc3\xa1\xc3\xa9\r").unwrap();
    writer.flush().unwrap();

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut acc = Vec::new();
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            acc.extend_from_slice(&buf[..n]);
            if tx.send(String::from_utf8_lossy(&acc).into_owned()).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut salida = String::new();
    while Instant::now() < deadline {
        if let Ok(texto) = rx.recv_timeout(Duration::from_millis(500)) {
            salida = texto;
            if salida.contains("LISTO-áé") && salida.contains("/usr") {
                break;
            }
        }
    }

    let _ = child.kill();
    assert!(salida.contains("/usr"), "el cwd no se aplico; salida: {salida}");
    assert!(
        salida.contains("LISTO-áé"),
        "no llego la salida utf-8 completa; salida: {salida}"
    );
}

#[test]
fn el_redimensionado_llega_al_proceso() {
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();

    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.arg("-c");
    cmd.arg("sleep 0.6; stty size");
    let mut child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().unwrap();
    pair.master
        .resize(PtySize {
            rows: 40,
            cols: 132,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();

    let mut salida = String::new();
    let mut buf = [0u8; 1024];
    while let Ok(n) = reader.read(&mut buf) {
        if n == 0 {
            break;
        }
        salida.push_str(&String::from_utf8_lossy(&buf[..n]));
        if salida.contains("40 132") {
            break;
        }
    }
    let _ = child.kill();
    assert!(salida.contains("40 132"), "stty devolvio: {salida:?}");
}
