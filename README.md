# Multiagentes

Aplicación de escritorio para lanzar y manejar varias terminales a la vez,
pensada para trabajar con agentes de línea de comandos (Claude Code, Codex,
Gemini, Aider, opencode) sin llenar la pantalla de ventanas sueltas.

Construida con **Tauri 2** (Rust), **Preact** y **xterm.js**. Cada sesión es un PTY real
—no una emulación— así que el modo interactivo, los colores y las teclas de los
agentes funcionan igual que en la terminal del sistema.

## Requisitos

- Node.js 20.19 o superior
- Rust estable (1.77+)
- macOS: Xcode Command Line Tools

## Uso

```bash
npm install
npm start        # abre la app en modo desarrollo (alias de `tauri dev`)
npm test         # pruebas del frontend (vitest) y del backend (cargo test)
npm run dist     # genera el .app / .dmg en src-tauri/target/release/bundle
```

Hay además una prueba que consulta la instalación real de opencode, apagada por
defecto porque depende de las sesiones del equipo:

```bash
OPENCODE_TEST_CWD=/ruta/a/un/proyecto \
  cargo test --manifest-path src-tauri/Cargo.toml --test agents_lookup -- --ignored --nocapture
```

## Instaladores

### macOS

```bash
npm run dist
```

Deja `Multiagentes_<versión>_aarch64.dmg` en
`src-tauri/target/release/bundle/dmg/` y el `.app` suelto en `bundle/macos/`.
El binario ronda los 4 MB y el DMG los 2 MB.

Se compila para la arquitectura del equipo. Para un DMG que funcione también en
Macs Intel hace falta el objetivo universal:

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

### Windows

No se puede construir desde macOS de forma fiable: el instalador necesita las
herramientas de Visual Studio. Se genera en un equipo Windows con Node, Rust y
las *Build Tools* de Visual Studio (carga «Desarrollo para el escritorio con
C++»), con el mismo `npm run dist`, o —más cómodo— en integración continua.

### Los dos a la vez, en integración continua

`.github/workflows/build.yml` compila en máquinas reales de macOS y Windows y
sube los instaladores como artefactos descargables. Se dispara al publicar una
etiqueta `v*` o a mano desde la pestaña *Actions*:

```bash
git remote add origin git@github.com:<usuario>/<repo>.git
git push -u origin main
git tag v0.1.0 && git push --tags
```

### Aplicación sin firmar

Ninguno de los dos instaladores va firmado, así que el sistema avisará al
abrirlos:

- **macOS**: «no se puede verificar el desarrollador». Se abre con clic derecho
  sobre la aplicación → *Abrir*, o quitando la marca de cuarentena:
  `xattr -dr com.apple.quarantine /Applications/Multiagentes.app`.
- **Windows**: SmartScreen mostrará *Más información* → *Ejecutar de todas
  formas*.

Para distribuirla sin avisos hacen falta un certificado de desarrollador de
Apple (y notarización) y un certificado de firma de código en Windows.

## Cómo funciona

Al crear una sesión se lanza el **shell de inicio de sesión** del usuario
(`$SHELL -l`) en el directorio elegido y, unos milisegundos después, se escribe
el comando del agente. Esto tiene dos ventajas sobre ejecutar el binario del
agente directamente:

- el PATH del perfil está cargado, así que se ven los agentes instalados vía
  nvm, homebrew o `~/.local/bin`;
- cuando el agente termina, la pestaña sigue viva con un shell utilizable.

El lanzador solo marca como disponibles los perfiles cuyo binario existe en el
sistema; los demás aparecen atenuados pero se pueden lanzar igualmente.

## Atajos

| Atajo | Acción |
| --- | --- |
| `⌘T` | Nueva sesión |
| `⌘W` | Cerrar la sesión activa |
| `⌘K` | Limpiar la terminal |
| `⌘↓` | Saltar al final de la salida |
| `Alt` + rueda | Desplazar de pantalla en pantalla |
| `⌘1` … `⌘9` | Ir a la sesión n |
| `⌘[` / `⌘]` | Sesión anterior / siguiente |
| `⇧⌘R` | Renombrar la sesión activa |
| Doble clic en la lista | Renombrar la sesión |
| Clic derecho en la lista | Menú de la sesión |

## Gestión de sesiones

El clic derecho sobre una pestaña abre su menú: **renombrar**, **volver al
nombre por defecto** (el del perfil más su posición), **duplicar** la sesión en
el mismo directorio, **reiniciar** el proceso reutilizando la pestaña y
**cerrar**.

El renombrado ocurre en línea, dentro de la propia pestaña: `Enter` confirma,
`Escape` cancela y hacer clic fuera guarda. Mientras hay una edición abierta el
panel lateral deja de redibujarse, porque la salida de los agentes lo refresca
sin parar y eso robaría el foco del campo.

## Persistencia

Las sesiones viven en SQLite, en el directorio de datos de la aplicación
(`~/Library/Application Support/com.mediahuella.multiagentes/sesiones.sqlite3`
en macOS). Se guardan el nombre, la carpeta, el perfil, el comando, el orden de
las pestañas, cuál estaba activa y el historial de salida de cada terminal.

Al abrir la aplicación se restauran todas las pestañas: primero se vuelca su
historial en la terminal y después arranca el proceso.

### El contexto de la conversación

El contexto no lo guarda esta aplicación: lo guarda cada agente. Lo que se
persiste aquí es el **puntero** a esa conversación, para poder pedirle al
agente que la retome.

Cuando el agente permite fijar el identificador de la conversación por
adelantado, la aplicación reserva un UUID al abrir la pestaña y lo guarda junto
al resto de sus datos:

| Perfil | Al abrir | Al restaurar | Cómo se sabe el id |
| --- | --- | --- | --- |
| Claude Code | `claude --session-id <uuid> --dangerously-skip-permissions` | `claude --resume <uuid> --dangerously-skip-permissions` | La aplicación lo reserva antes de arrancar |
| opencode | `opencode` | `opencode --session <ses_…>` | Se consulta a `opencode session list` |
| Gemini | `gemini` | `gemini --resume latest` | No hay id: retoma la última de la carpeta |
| Codex, Aider | `codex` / `aider` | mismo comando, sin reanudar | — |

Claude Code y opencode recuperan **exactamente** su conversación, incluso con
varias pestañas abiertas sobre la misma carpeta. Gemini sólo sabe retomar «la
última conversación del proyecto», así que dos pestañas suyas en la misma
carpeta se disputan el mismo hilo. Los agentes que no ofrecen ninguna
reanudación arrancan limpios.

### Conversaciones que la aplicación no lanzó

Cada agente lleva su propio registro de conversaciones, y `agents.rs` sabe
consultarlo:

- **Claude Code** guarda cada una en `~/.claude/projects/<carpeta>/<uuid>.jsonl`;
  se lee ese directorio y se ordenan por fecha de modificación. Las
  transcripciones de menos de 128 bytes se descartan: son conversaciones que se
  abrieron y cerraron sin escribir nada, y no hay nada que retomar en ellas.
- **opencode** no permite fijar el id de antemano, pero publica sus sesiones en
  `opencode session list --format json`, con la carpeta de cada una. Se filtra
  por la carpeta de la pestaña y se ordena por fecha. Se usa el formato JSON de
  la CLI, que es contrato público, en vez de leer su base de datos interna. La
  consulta se lanza con un tope de 8 segundos, para que un agente colgado no
  bloquee la restauración.

Gracias a esto se reanudan también las conversaciones abiertas a mano desde la
terminal, o las de pestañas creadas por versiones anteriores que no anotaban
identificador.

**El reparto** (`src/assign.ts`) evita que dos pestañas del mismo agente sobre
la misma carpeta peleen por la misma conversación: primero se sirven las que ya
traen una anotada y sigue existiendo, y después las que no tienen ninguna van
tomando las restantes por orden de recencia. El id que acaba usando cada
pestaña queda anclado, así que la detección sólo actúa una vez.

### Comandos propios

El comando guardado sólo se almacena cuando difiere del perfil; si coincide, se
guarda vacío y manda el perfil. Gracias a eso, añadir una bandera al perfil
—como `--dangerously-skip-permissions`— alcanza también a las pestañas ya
guardadas, en vez de dejarlas congeladas con el texto antiguo. Un comando que
escribas tú se respeta tal cual, sin añadirle identificadores ni banderas.

En el menú contextual, **Reiniciar** vuelve a la misma conversación y **Empezar
conversación nueva** reserva un identificador nuevo y arranca un hilo limpio
en la misma pestaña.

Cerrar una pestaña la borra de la base; cerrar la aplicación no borra nada.
«Borrar historial guardado», en el menú contextual, vacía sólo la salida
acumulada de esa sesión.

Detalles del almacén (`src-tauri/src/store.rs`):

- La salida no se escribe fila a fila: un hilo dedicado la agrupa cada 400 ms y
  la vuelca en una sola transacción, para no castigar el disco con miles de
  escrituras diminutas. Al cerrar la ventana el volcado es síncrono.
- Cada sesión guarda como mucho 512 KB de historial; al superarlo se podan los
  trozos más antiguos. En la restauración se devuelven los últimos 64 KB.
- El historial restaurado se antepone con un reset de terminal, porque el
  fragmento empieza a media sesión y puede arrastrar modos sin cerrar. Con
  agentes de pantalla completa lo que se ve al reabrir es el último repintado,
  no un scrollback navegable.

## Estructura

```
src/                  frontend (TypeScript + Preact)
  main.tsx            arranque
  state.ts            todo el estado y las acciones, sin tocar el DOM
  session.ts          una pestaña: terminal xterm + PTY asociado
  profiles.ts         perfiles de agente, comandos y reanudación
  assign.ts           reparto de conversaciones entre pestañas
  ui/                 componentes: App, Sidebar, Launcher, ContextMenu
  *.test.ts           pruebas de comandos y de reparto
src-tauri/
  src/pty.rs          puente PTY: spawn, escritura, resize, kill
  src/store.rs        persistencia SQLite de sesiones e historial
  src/agents.rs       consulta de conversaciones existentes por agente
  src/lib.rs          arranque de Tauri y registro de comandos
tools/make-icon.mjs   genera el PNG fuente del icono (`npx tauri icon`)
```

### Añadir un agente

Basta con una entrada nueva en `PROFILES` (`src/profiles.ts`):

```ts
{
  id: "mi-agente",
  label: "Mi agente",
  binary: "mi-agente",
  command: "mi-agente --flag",
  // Opcionales: si el agente sabe retomar una conversación.
  startTemplate: "mi-agente --session {id}",
  resumeTemplate: "mi-agente --resume {id}",
  hint: "mi-agente",
}
```

## Por qué Preact y no una interfaz a mano

El panel lateral se redibuja cada vez que un agente escribe algo. Con nodos
creados a mano, eso destruía el campo de renombrado a media escritura y hubo
que congelar la lista mientras hubiera una edición abierta. Con reconciliación
por clave el problema desaparece de raíz, y lo mismo valdrá para el resto de
elementos con estado propio: scroll, selección, un menú abierto.

Las terminales quedan **fuera** del árbol de Preact, montadas en
`div.term-mount` por la clase `Session`: xterm gestiona su propio nodo y
guarda el búfer, así que volver a montarlo perdería el historial. Preact nunca
pone hijos dentro de ese contenedor.

Preact en lugar de React por tamaño: la misma API en unos 7 KB comprimidos
sobre el paquete final, frente a los ~45 KB de React.

## Detalles de implementación

- La salida del PTY viaja en base64 y se decodifica en el renderer con un
  `TextDecoder` incremental por sesión: una lectura de 8 KB puede cortar un
  carácter UTF-8 por la mitad y así no se rompen los acentos ni los emojis.
- El identificador de la sesión lo elige el frontend, que se suscribe al evento
  de salida **antes** de pedir el spawn; si no, los primeros bytes del prompt
  se perderían.
- Al cerrar la ventana se matan todos los procesos hijos, para no dejar agentes
  huérfanos corriendo en segundo plano.
- Las pestañas de fondo se ocultan con `visibility`, no con `display:none`:
  conservando su tamaño, xterm no tiene que rehacer el ajuste de línea de todo
  el historial al volver a mostrarlas. Ésa era la causa de que el scroll diera
  saltos en las sesiones largas.
- El complemento WebGL lo usa sólo la pestaña visible. El navegador mantiene
  vivos unos pocos contextos y, al superarlos, descarta el más antiguo: con uno
  por pestaña, las más viejas dejaban de repintarse.
