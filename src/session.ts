import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";

const THEME = {
  background: "#0e1013",
  foreground: "#e6e9ef",
  cursor: "#d97757",
  selectionBackground: "#2c3542",
  black: "#14171c",
  red: "#e5534b",
  green: "#4ec9a0",
  yellow: "#d7ba7d",
  blue: "#6ba8e8",
  magenta: "#c586c0",
  cyan: "#56b6c2",
  white: "#d4d4d4",
  brightBlack: "#5f6875",
};

/**
 * En qué anda el agente de esta pestaña.
 *
 * No se deduce leyendo su salida —el texto cambia con cada versión y con el
 * idioma— sino de dos señales que da la propia terminal: si están entrando
 * datos ahora mismo, y la campana que los agentes disparan al pedir atención.
 */
export type Activity = "trabajando" | "atencion" | "listo" | "terminada";

/** Silencio a partir del cual se considera que el agente dejó de trabajar. */
const QUIETO_MS = 1200;

export interface SessionInit {
  /** Id persistente; se genera si la sesión es nueva. */
  id?: string;
  name: string;
  cwd: string;
  profileId: string;
  /** Comando del perfil; es lo que se persiste y lo que hereda un duplicado. */
  command: string;
  /** Comando realmente enviado al shell, si difiere (p. ej. al reanudar). */
  launchCommand?: string;
  /** Id de la conversación del agente, cuando el agente permite fijarlo. */
  conversationId?: string | null;
}

/** Una pestaña: su terminal en pantalla y el PTY que la alimenta. */
export class Session {
  /** Id estable entre reinicios: es la clave del registro en SQLite. */
  readonly key: string;
  /** Id del PTY: lo elige el frontend para poder escuchar antes del arranque. */
  ptyId: string | null = null;
  name: string;
  cwd: string;
  profileId: string;
  command: string;
  /** Id de la conversación del agente; se persiste para poder retomarla. */
  conversationId: string | null;
  private launchCommand: string;
  exited = false;
  unread = false;
  /** Si el agente pidió atención con la campana y aún no se ha atendido. */
  private attention = false;
  private working = false;
  private quietTimer: number | null = null;

  readonly host: HTMLDivElement;
  private term: Terminal;
  private fit: FitAddon;
  private decoder = new TextDecoder("utf-8");
  private unlisten: UnlistenFn | null = null;
  private webgl: WebglAddon | null = null;
  private observer: ResizeObserver | null = null;
  private generation = 0;

  onUpdate: () => void = () => {};

  constructor(init: SessionInit, parent: HTMLElement) {
    this.key = init.id ?? `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    this.name = init.name;
    this.cwd = init.cwd;
    this.profileId = init.profileId;
    this.command = init.command;
    this.launchCommand = init.launchCommand ?? init.command;
    this.conversationId = init.conversationId ?? null;

    this.host = document.createElement("div");
    this.host.className = "term-host hidden";
    parent.appendChild(this.host);

    this.term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      // 10 000 líneas cubren una conversación larga sin que cada cambio de
      // tamaño tenga que rehacer el ajuste de línea de medio megabyte de
      // salida. El historial completo vive en SQLite, no en el buffer.
      scrollback: 10000,
      smoothScrollDuration: 0,
      // Alt + rueda salta de pantalla en pantalla: llegar al principio de una
      // sesión larga a rueda normal es inviable.
      fastScrollModifier: "alt",
      scrollOnUserInput: true,
      theme: THEME,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon());
    this.term.open(this.host);

    // Defensa de fondo: cualquier cambio de tamaño del contenedor reajusta la
    // terminal, venga de donde venga (ventana, panel lateral, layout tardío).
    this.observer = new ResizeObserver(() => this.fitNow());
    this.observer.observe(this.host);

    // La campana es la única señal explícita que dan los agentes cuando
    // terminan o piden permiso; xterm la expone tal cual.
    this.term.onBell(() => {
      this.attention = true;
      this.onUpdate();
    });

    this.term.onData((data) => {
      if (this.ptyId) void invoke("pty_write", { id: this.ptyId, data });
    });
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyId) void invoke("pty_resize", { id: this.ptyId, cols, rows });
    });
  }

  /** Arranca el PTY y, si el perfil lo pide, escribe el comando inicial. */
  async start(): Promise<void> {
    this.fitNow();
    const { cols, rows } = this.term;
    const id = `${this.key}-${++this.generation}`;

    // Suscribirse primero: si el proceso escribe antes de que exista el
    // listener, ese primer trozo de salida se pierde para siempre.
    this.unlisten = await listen<string>(`pty://output/${id}`, (event) => {
      const bytes = Uint8Array.from(atob(event.payload), (c) => c.charCodeAt(0));
      this.term.write(this.decoder.decode(bytes, { stream: true }));
      this.noteOutput();
      if (this.host.classList.contains("hidden") && !this.unread) {
        this.unread = true;
        this.onUpdate();
      }
    });

    try {
      await invoke<string>("pty_spawn", {
        options: {
          id,
          storeId: this.key,
          program: null,
          args: [],
          cwd: this.cwd || null,
          env: {},
          cols,
          rows,
        },
      });
    } catch (error) {
      this.unlisten();
      this.unlisten = null;
      throw error;
    }
    this.ptyId = id;

    if (this.launchCommand.trim()) {
      // El shell de login tarda un instante en habilitar el modo canónico;
      // enviar antes de eso hace que se pierda la línea.
      setTimeout(() => {
        if (this.ptyId) void invoke("pty_write", { id: this.ptyId, data: `${this.launchCommand}\r` });
      }, 350);
    }
  }

  /**
   * Vuelca en la terminal el historial guardado de una ejecución anterior.
   * Se antepone un reset porque el trozo restaurado empieza a media sesión y
   * puede arrastrar modos (color inverso, pantalla alternativa) sin cerrar.
   */
  restoreHistory(base64: string): void {
    if (!base64) return;
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    this.term.write("\x1bc");
    this.term.write(this.decoder.decode(bytes, { stream: true }));
    this.term.write("\r\n\x1b[38;5;244m— sesión restaurada —\x1b[0m\r\n");
  }

  markExited(code: number): void {
    this.exited = true;
    this.working = false;
    if (this.quietTimer !== null) {
      window.clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    this.term.write(`\r\n\x1b[38;5;244m— proceso terminado (código ${code}) —\x1b[0m\r\n`);
    this.onUpdate();
  }

  /** Vuelve a lanzar el PTY reutilizando la misma pestaña. */
  /** Cambia el comando que se enviará en el próximo arranque. */
  launchWith(command: string): void {
    this.launchCommand = command;
  }

  async restart(): Promise<void> {
    await this.disposePty();
    this.term.reset();
    this.exited = false;
    this.attention = false;
    await this.start();
    this.onUpdate();
  }

  show(): void {
    this.host.classList.remove("hidden");
    this.unread = false;
    this.attention = false;
    this.mountWebgl();
    requestAnimationFrame(() => {
      this.fitNow();
      this.term.focus();
    });
  }

  hide(): void {
    this.host.classList.add("hidden");
    // El navegador sólo mantiene un puñado de contextos WebGL vivos; al
    // superarlo descarta el más antiguo y esa terminal deja de repintarse.
    // Con una sola terminal visible, basta con acelerar la activa.
    this.unmountWebgl();
  }

  private mountWebgl(): void {
    if (this.webgl) return;
    try {
      const addon = new WebglAddon();
      // Si el sistema retira el contexto, se cae al renderer DOM en vez de
      // quedarse con una terminal congelada.
      addon.onContextLoss(() => this.unmountWebgl());
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch {
      /* sin aceleración: el renderer DOM sigue funcionando */
    }
  }

  private unmountWebgl(): void {
    this.webgl?.dispose();
    this.webgl = null;
  }

  /** Estado que muestra la pestaña en el panel lateral. */
  get activity(): Activity {
    if (this.exited) return "terminada";
    if (this.working) return "trabajando";
    return this.attention ? "atencion" : "listo";
  }

  /** Marca actividad y programa la vuelta a la calma tras el silencio. */
  private noteOutput(): void {
    if (!this.working) {
      this.working = true;
      // Escribir es trabajar: lo que pidiera atención ya está atendido.
      this.attention = false;
      this.onUpdate();
    }
    if (this.quietTimer !== null) window.clearTimeout(this.quietTimer);
    this.quietTimer = window.setTimeout(() => {
      this.quietTimer = null;
      this.working = false;
      this.onUpdate();
    }, QUIETO_MS);
  }

  /** ¿La vista está pegada al final de la salida? */
  get atBottom(): boolean {
    const buffer = this.term.buffer.active;
    return buffer.viewportY >= buffer.baseY;
  }

  /** Salta al final del historial. */
  scrollToBottom(): void {
    this.term.scrollToBottom();
  }

  /** Avisa cada vez que la vista se despega del final o vuelve a él. */
  onScrollStateChange(listener: (atBottom: boolean) => void): void {
    let previo = true;
    const notificar = (): void => {
      const ahora = this.atBottom;
      if (ahora !== previo) {
        previo = ahora;
        listener(ahora);
      }
    };
    this.term.onScroll(notificar);
    this.term.onWriteParsed(notificar);
  }

  clear(): void {
    this.term.clear();
  }

  focus(): void {
    this.term.focus();
  }

  /** Dimensiones actuales, en celdas. */
  get dims(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  fitNow(): void {
    try {
      this.fit.fit();
    } catch {
      /* el contenedor aún no tiene tamaño */
    }
  }

  private async disposePty(): Promise<void> {
    this.unlisten?.();
    this.unlisten = null;
    if (this.ptyId) {
      await invoke("pty_kill", { id: this.ptyId }).catch(() => {});
      this.ptyId = null;
    }
  }

  async dispose(): Promise<void> {
    if (this.quietTimer !== null) window.clearTimeout(this.quietTimer);
    await this.disposePty();
    this.observer?.disconnect();
    this.unmountWebgl();
    this.term.dispose();
    this.host.remove();
  }
}
