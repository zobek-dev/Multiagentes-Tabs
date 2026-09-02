import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { assignConversations, groupKey, type SessionRef } from "./assign";
import { FileBrowser } from "./files";
import {
  PROFILES,
  commandToStore,
  conversationsFor,
  detectAvailable,
  profileById,
  reserveConversation,
  resumeCommandFor,
  startCommandFor,
  type Profile,
} from "./profiles";
import { Session, type Activity } from "./session";
import {
  INTERVALO_COMPROBACION_MS,
  buscarActualizacion,
  descartar,
  type UpdateInfo,
} from "./update";

const LAST_CWD_KEY = "multiagentes.lastCwd";

/** Una pestaña tal como vuelve de la base de datos. */
interface StoredTab {
  id: string;
  name: string;
  cwd: string;
  profileId: string;
  command: string;
  conversationId: string | null;
  position: number;
  active: boolean;
}

/**
 * Una pestaña: sus datos, y su terminal sólo si se ha llegado a abrir.
 *
 * Al arrancar existen todas las pestañas pero ninguna terminal. Cada `Session`
 * es un xterm con su búfer, un PTY y un agente en marcha; restaurar diez de
 * golpe son diez agentes y varios cientos de megabytes antes de que nadie haya
 * escrito nada.
 */
export class Tab {
  id: string;
  name: string;
  cwd: string;
  profileId: string;
  /** Comando propio, o cadena vacía si manda el del perfil. */
  command: string;
  conversationId: string | null;
  session: Session | null = null;
  /** La terminal se está creando ahora mismo. */
  opening = false;

  constructor(meta: Omit<StoredTab, "position" | "active">) {
    this.id = meta.id;
    this.name = meta.name;
    this.cwd = meta.cwd;
    this.profileId = meta.profileId;
    this.command = meta.command;
    this.conversationId = meta.conversationId;
  }

  /** Estado para el panel lateral; sin terminal, la pestaña está dormida. */
  get activity(): Activity {
    if (this.opening) return "trabajando";
    return this.session ? this.session.activity : "dormida";
  }

  get unread(): boolean {
    return this.session?.unread ?? false;
  }
}

/** El formulario de nueva sesión, mientras está abierto. */
export interface LauncherDraft {
  profile: Profile;
  cwd: string;
  command: string;
}

export interface MenuAnchor {
  tab: Tab;
  x: number;
  y: number;
}

/**
 * Todo el estado de la aplicación, sin una sola referencia al DOM.
 *
 * La interfaz se suscribe y se redibuja cuando algo cambia; las terminales
 * viven fuera de ese ciclo, porque xterm gestiona su propio nodo y volver a
 * montarlo perdería el búfer entero.
 */
export class AppState {
  tabs: Tab[] = [];
  active: Tab | null = null;
  /** Pestaña cuyo nombre se está editando en el panel lateral. */
  renaming: Tab | null = null;
  menu: MenuAnchor | null = null;
  launcher: LauncherDraft | null = null;
  available = new Set<string>(PROFILES.map((profile) => profile.id));
  /** Si la terminal visible está pegada al final de su salida. */
  atBottom = true;
  ready = false;
  update: UpdateInfo | null = null;
  readonly files = new FileBrowser(() => this.emit());

  private host: HTMLElement | null = null;
  private listeners = new Set<() => void>();
  /** Grupos de agente y carpeta cuyas conversaciones ya se repartieron. */
  private conversacionesResueltas = new Set<string>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /* ---------- Arranque ---------- */

  /** Recibe el contenedor donde se montan las terminales y arranca. */
  async attach(host: HTMLElement): Promise<void> {
    if (this.host) return;
    this.host = host;

    listen<{ id: string; code: number }>("pty://exit", (event) => {
      const tab = this.tabs.find((t) => t.session?.ptyId === event.payload.id);
      if (tab?.session) {
        tab.session.markExited(event.payload.code);
        this.emit();
      }
    });

    try {
      this.available = await detectAvailable();
    } catch {
      /* sin detección: todos los perfiles quedan disponibles */
    }

    let stored: StoredTab[] = [];
    try {
      stored = await invoke<StoredTab[]>("sessions_load");
    } catch (error) {
      console.error("no se pudieron cargar las sesiones guardadas", error);
    }

    this.tabs = stored.map((meta) => new Tab(meta));
    this.ready = true;

    // Sólo se abre de verdad la pestaña que estaba activa; el resto esperan.
    const activa = this.tabs.find((tab) => stored.find((s) => s.id === tab.id)?.active);
    if (this.tabs.length) {
      await this.activate(activa ?? this.tabs[0]);
    } else {
      this.openLauncher();
    }
    this.emit();
    this.watchForUpdates();
  }

  /**
   * Mira si hay una versión nueva, sin estorbar el arranque: la primera
   * consulta espera a que la sesión esté en marcha.
   */
  private watchForUpdates(): void {
    const mirar = async (): Promise<void> => {
      const update = await buscarActualizacion();
      if (update && update.version !== this.update?.version) {
        this.update = update;
        this.emit();
      }
    };
    window.setTimeout(() => void mirar(), 8000);
    window.setInterval(() => void mirar(), INTERVALO_COMPROBACION_MS);
  }

  dismissUpdate(): void {
    if (this.update) descartar(this.update.version);
    this.update = null;
    this.emit();
  }

  /* ---------- Conversaciones ---------- */

  /**
   * Reparte las conversaciones del agente y la carpeta de esta pestaña.
   *
   * Se hace la primera vez que se abre una pestaña del grupo, no al arrancar:
   * consultar a cada agente lanza un proceso, y con muchas pestañas eso era
   * una ristra de procesos antes de ver nada. El grupo entero se resuelve de
   * una vez, para que dos pestañas de la misma carpeta no se peleen por el
   * mismo hilo.
   */
  private async resolveConversations(tab: Tab): Promise<void> {
    const clave = groupKey(tab);
    if (this.conversacionesResueltas.has(clave)) return;
    this.conversacionesResueltas.add(clave);

    const grupo = this.tabs.filter((otra) => groupKey(otra) === clave);
    const refs: SessionRef[] = grupo.map((otra) => ({
      id: otra.id,
      profileId: otra.profileId,
      cwd: otra.cwd,
      conversationId: otra.conversationId,
    }));

    const disponibles = new Map([[clave, await conversationsFor(tab.profileId, tab.cwd)]]);
    const asignadas = assignConversations(refs, disponibles);

    for (const otra of grupo) {
      const conversationId = asignadas.get(otra.id) ?? null;
      if (conversationId !== otra.conversationId) {
        otra.conversationId = conversationId;
        this.persist(otra);
      }
    }
  }

  /* ---------- Abrir una pestaña ---------- */

  /** Crea la terminal de una pestaña dormida y arranca su agente. */
  private async materialize(tab: Tab): Promise<void> {
    if (!this.host || tab.session || tab.opening) return;
    tab.opening = true;
    this.emit();

    try {
      await this.resolveConversations(tab);

      const profile = profileById(tab.profileId) ?? PROFILES[0];
      // Se normaliza al abrir: lo que coincide con el perfil se guarda vacío,
      // para que la pestaña adopte los cambios que reciba el perfil en vez de
      // quedarse con el texto de una versión vieja.
      const normalizado = commandToStore(profile, tab.command);
      if (normalizado !== tab.command) {
        tab.command = normalizado;
        this.persist(tab);
      }

      const session = new Session(
        {
          id: tab.id,
          cwd: tab.cwd,
          launchCommand: resumeCommandFor(tab.profileId, tab.command, tab.conversationId),
        },
        this.host,
      );
      this.wire(tab, session);
      tab.session = session;
      if (this.active === tab) session.show();
      this.emit();

      // El historial se pide ahora, no al arrancar la aplicación: son decenas
      // de kilobytes por pestaña que casi nunca se llegan a mirar.
      const output = await invoke<string>("session_output", { id: tab.id }).catch(() => "");
      if (output) session.restoreHistory(output);

      await session.start();
    } catch (error) {
      console.error(`no se pudo abrir ${tab.name}`, error);
    } finally {
      tab.opening = false;
      this.emit();
    }
  }

  private wire(tab: Tab, session: Session): void {
    session.onUpdate = () => this.emit();
    session.onScrollStateChange((atBottom) => {
      if (this.active === tab) {
        this.atBottom = atBottom;
        this.emit();
      }
    });
  }

  /* ---------- Ciclo de vida ---------- */

  async createSession(profile: Profile, cwd: string, typed: string): Promise<void> {
    if (!this.host) return;
    const command = commandToStore(profile, typed);
    const count = this.tabs.filter((t) => t.profileId === profile.id).length;
    const conversationId = command ? null : await reserveConversation(profile, cwd);

    const tab = new Tab({
      id: `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      name: count ? `${profile.label} ${count + 1}` : profile.label,
      cwd,
      profileId: profile.id,
      command,
      conversationId,
    });
    this.tabs.push(tab);
    // Una pestaña recién creada ya trae su conversación: nada que repartir.
    this.conversacionesResueltas.add(groupKey(tab));
    this.persist(tab);

    this.active?.session?.hide();
    this.active = tab;
    this.files.setRoot(tab.cwd);
    tab.opening = true;
    this.emit();

    const session = new Session(
      {
        id: tab.id,
        cwd,
        launchCommand: command || startCommandFor(profile, conversationId),
      },
      this.host,
    );
    this.wire(tab, session);
    tab.session = session;
    session.show();

    try {
      await session.start();
    } catch (error) {
      window.alert(`No se pudo abrir la terminal: ${error}`);
      await this.closeTab(tab);
    } finally {
      tab.opening = false;
      this.emit();
    }
  }

  async closeTab(tab: Tab): Promise<void> {
    const index = this.tabs.indexOf(tab);
    if (index === -1) return;
    this.tabs.splice(index, 1);
    if (this.renaming === tab) this.renaming = null;
    await invoke("session_delete", { id: tab.id }).catch(() => {});
    await tab.session?.dispose();
    void invoke("sessions_set_order", { ids: this.tabs.map((t) => t.id) }).catch(() => {});
    if (this.active === tab) {
      this.active = null;
      await this.activate(this.tabs[Math.min(index, this.tabs.length - 1)] ?? null);
    }
    this.emit();
  }

  async activate(tab: Tab | null): Promise<void> {
    if (this.active === tab) {
      tab?.session?.focus();
      return;
    }
    this.active?.session?.hide();
    this.active = tab;
    // El explorador sigue a la pestaña: enseña el proyecto en el que se está
    // trabajando, sin tener que elegir carpeta por separado.
    this.files.setRoot(tab?.cwd ?? null);
    if (tab) {
      void invoke("session_set_active", { id: tab.id }).catch(() => {});
      this.atBottom = tab.session?.atBottom ?? true;
      if (tab.session) tab.session.show();
      else void this.materialize(tab);
    }
    this.emit();
  }

  cycle(delta: number): void {
    if (!this.tabs.length) return;
    const index = this.active ? this.tabs.indexOf(this.active) : -1;
    void this.activate(this.tabs[(index + delta + this.tabs.length) % this.tabs.length]);
  }

  /** Relanza el proceso retomando la misma conversación del agente. */
  async restartTab(tab: Tab): Promise<void> {
    if (!tab.session) return void this.activate(tab);
    tab.session.launchWith(resumeCommandFor(tab.profileId, tab.command, tab.conversationId));
    await tab.session.restart();
    this.emit();
  }

  /** Descarta el hilo actual y arranca uno limpio con un id nuevo. */
  async startFreshConversation(tab: Tab): Promise<void> {
    const profile = profileById(tab.profileId);
    if (!profile) return;
    tab.conversationId = await reserveConversation(profile, tab.cwd);
    this.persist(tab);
    if (tab.session) {
      tab.session.launchWith(startCommandFor(profile, tab.conversationId));
      await tab.session.restart();
    }
    this.emit();
  }

  async clearHistory(tab: Tab): Promise<void> {
    await invoke("session_clear_output", { id: tab.id }).catch(() => {});
    tab.session?.clear();
    this.emit();
  }

  async duplicate(tab: Tab): Promise<void> {
    const profile = profileById(tab.profileId);
    if (profile) await this.createSession(profile, tab.cwd, tab.command);
  }

  /* ---------- Nombres ---------- */

  startRename(tab: Tab): void {
    this.menu = null;
    this.renaming = tab;
    this.emit();
  }

  commitRename(tab: Tab, name: string): void {
    if (this.renaming !== tab) return;
    this.renaming = null;
    const limpio = name.trim();
    if (limpio && limpio !== tab.name) {
      tab.name = limpio;
      this.persist(tab);
    }
    this.emit();
    this.active?.session?.focus();
  }

  cancelRename(): void {
    this.renaming = null;
    this.emit();
    this.active?.session?.focus();
  }

  /** Vuelve al nombre derivado del perfil y su posición entre las hermanas. */
  resetName(tab: Tab): void {
    const label = profileById(tab.profileId)?.label ?? "Sesión";
    const position = this.tabs.filter((t) => t.profileId === tab.profileId).indexOf(tab);
    tab.name = position ? `${label} ${position + 1}` : label;
    this.persist(tab);
    this.emit();
  }

  /* ---------- Menú y lanzador ---------- */

  openMenu(tab: Tab, x: number, y: number): void {
    void this.activate(tab);
    this.menu = { tab, x, y };
    this.emit();
  }

  closeMenu(): void {
    if (!this.menu) return;
    this.menu = null;
    this.emit();
  }

  openLauncher(): void {
    const profile =
      this.launcher?.profile ??
      PROFILES.find((p) => this.available.has(p.id)) ??
      PROFILES[PROFILES.length - 1];
    this.launcher = {
      profile,
      cwd: this.active?.cwd || localStorage.getItem(LAST_CWD_KEY) || "",
      command: profile.command,
    };
    this.emit();
  }

  updateLauncher(patch: Partial<LauncherDraft>): void {
    if (!this.launcher) return;
    this.launcher = { ...this.launcher, ...patch };
    // Cambiar de agente reescribe el comando propuesto.
    if (patch.profile) this.launcher.command = patch.profile.command;
    this.emit();
  }

  closeLauncher(): void {
    this.launcher = null;
    this.emit();
    this.active?.session?.focus();
  }

  async submitLauncher(): Promise<void> {
    const draft = this.launcher;
    if (!draft) return;
    const cwd = draft.cwd.trim();
    if (cwd) localStorage.setItem(LAST_CWD_KEY, cwd);
    this.launcher = null;
    this.emit();
    await this.createSession(draft.profile, cwd, draft.command);
  }

  /* ---------- Persistencia ---------- */

  /**
   * Guarda los metadatos de una pestaña. Un fallo aquí no debe tumbar la
   * sesión en marcha: se registra y se sigue trabajando en memoria.
   */
  persist(tab: Tab): void {
    void invoke("session_save", {
      session: {
        id: tab.id,
        name: tab.name,
        cwd: tab.cwd,
        profileId: tab.profileId,
        command: tab.command,
        conversationId: tab.conversationId,
        position: this.tabs.indexOf(tab),
        active: tab === this.active,
      },
    }).catch((error) => console.error("no se pudo guardar la sesión", error));
  }

  fitAll(): void {
    for (const tab of this.tabs) tab.session?.fitNow();
  }

  disposeAll(): void {
    for (const tab of this.tabs) void tab.session?.dispose();
  }
}
