import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { assignConversations, groupKey, type SessionRef } from "./assign";
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
import { Session } from "./session";
import {
  INTERVALO_COMPROBACION_MS,
  buscarActualizacion,
  descartar,
  type UpdateInfo,
} from "./update";

const LAST_CWD_KEY = "multiagentes.lastCwd";

/** Una sesión tal como vuelve de la base de datos. */
interface RestoredSession {
  id: string;
  name: string;
  cwd: string;
  profileId: string;
  command: string;
  conversationId: string | null;
  position: number;
  active: boolean;
  output: string;
}

/** El formulario de nueva sesión, mientras está abierto. */
export interface LauncherDraft {
  profile: Profile;
  cwd: string;
  command: string;
}

export interface MenuAnchor {
  session: Session;
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
  sessions: Session[] = [];
  active: Session | null = null;
  /** Sesión cuyo nombre se está editando en el panel lateral. */
  renaming: Session | null = null;
  menu: MenuAnchor | null = null;
  launcher: LauncherDraft | null = null;
  available = new Set<string>(PROFILES.map((profile) => profile.id));
  /** Si la terminal visible está pegada al final de su salida. */
  atBottom = true;
  ready = false;
  /** Versión publicada posterior a la instalada, si la hay. */
  update: UpdateInfo | null = null;

  private host: HTMLElement | null = null;
  private listeners = new Set<() => void>();

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
      const session = this.sessions.find((s) => s.ptyId === event.payload.id);
      if (session) {
        session.markExited(event.payload.code);
        this.emit();
      }
    });

    try {
      this.available = await detectAvailable();
    } catch {
      /* sin detección: todos los perfiles quedan disponibles */
    }

    const restored = await this.restore();
    this.ready = true;
    if (!restored) this.openLauncher();
    this.emit();
    this.watchForUpdates();
  }

  /**
   * Mira si hay una versión nueva, sin estorbar el arranque: la primera
   * consulta espera a que las sesiones estén en marcha.
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

  /** Deja de avisar de esta versión hasta que salga otra. */
  dismissUpdate(): void {
    if (this.update) descartar(this.update.version);
    this.update = null;
    this.emit();
  }

  private async restore(): Promise<boolean> {
    let stored: RestoredSession[] = [];
    try {
      stored = await invoke<RestoredSession[]>("sessions_load");
    } catch (error) {
      console.error("no se pudieron cargar las sesiones guardadas", error);
      return false;
    }
    if (!stored.length) return false;

    const conversaciones = await this.assignConversations(stored);
    let toActivate: Session | null = null;

    for (const record of stored) {
      const conversationId = conversaciones.get(record.id) ?? null;
      const profile = profileById(record.profileId) ?? PROFILES[0];
      const session = this.track(
        new Session(
          {
            id: record.id,
            name: record.name,
            cwd: record.cwd,
            profileId: record.profileId,
            // Se normaliza al recuperar: lo que coincide con el perfil se
            // guarda vacío, para que la pestaña adopte los cambios que reciba
            // el perfil en vez de quedarse con el texto de una versión vieja.
            command: commandToStore(profile, record.command),
            conversationId,
            launchCommand: resumeCommandFor(record.profileId, record.command, conversationId),
          },
          this.host!,
        ),
      );
      if (conversationId !== record.conversationId || session.command !== record.command) {
        this.persist(session);
      }
      if (record.active) toActivate = session;
    }

    this.activate(toActivate ?? this.sessions[0]);
    this.emit();
    // Las pestañas de fondo ya ocupan su sitio aunque no se vean, así que
    // cada una puede medirse sola antes de arrancar su proceso.
    await new Promise((resolve) => requestAnimationFrame(resolve));

    for (const session of this.sessions) {
      const record = stored.find((r) => r.id === session.key);
      if (record) session.restoreHistory(record.output);
      try {
        await session.start();
      } catch (error) {
        console.error(`no se pudo reanudar ${session.name}`, error);
      }
    }
    this.emit();
    return true;
  }

  /** Consulta al backend las conversaciones de cada grupo y las reparte. */
  private async assignConversations(
    stored: RestoredSession[],
  ): Promise<Map<string, string | null>> {
    const refs: SessionRef[] = stored.map((record) => ({
      id: record.id,
      profileId: record.profileId,
      cwd: record.cwd,
      conversationId: record.conversationId,
    }));

    const claves = new Map(refs.map((ref) => [groupKey(ref), ref]));
    const disponibles = new Map<string, string[]>();
    await Promise.all(
      Array.from(claves.entries()).map(async ([clave, ref]) => {
        disponibles.set(clave, await conversationsFor(ref.profileId, ref.cwd));
      }),
    );

    return assignConversations(refs, disponibles);
  }

  /* ---------- Ciclo de vida de las sesiones ---------- */

  private track(session: Session): Session {
    session.onUpdate = () => this.emit();
    session.onScrollStateChange((atBottom) => {
      if (this.active === session) {
        this.atBottom = atBottom;
        this.emit();
      }
    });
    this.sessions.push(session);
    return session;
  }

  async createSession(profile: Profile, cwd: string, typed: string): Promise<void> {
    if (!this.host) return;
    const command = commandToStore(profile, typed);
    const count = this.sessions.filter((s) => s.profileId === profile.id).length;
    // La conversación se reserva antes de arrancar: así la pestaña sabe cuál
    // retomar aunque haya varias sobre la misma carpeta. Con Claude Code el id
    // lo pone la aplicación; con Cursor hay que pedírselo al agente.
    const conversationId = command ? null : await reserveConversation(profile, cwd);

    const session = this.track(
      new Session(
        {
          name: count ? `${profile.label} ${count + 1}` : profile.label,
          cwd,
          profileId: profile.id,
          command,
          // Un comando propio se envía tal cual; si no, manda el del perfil,
          // con el id de conversación reservado cuando el agente lo admite.
          launchCommand: command || startCommandFor(profile, conversationId),
          conversationId,
        },
        this.host,
      ),
    );

    this.activate(session);
    this.persist(session);
    try {
      await session.start();
    } catch (error) {
      window.alert(`No se pudo abrir la terminal: ${error}`);
      await this.closeSession(session);
    }
    this.emit();
  }

  async closeSession(session: Session): Promise<void> {
    const index = this.sessions.indexOf(session);
    if (index === -1) return;
    this.sessions.splice(index, 1);
    if (this.renaming === session) this.renaming = null;
    await invoke("session_delete", { id: session.key }).catch(() => {});
    await session.dispose();
    void invoke("sessions_set_order", { ids: this.sessions.map((s) => s.key) }).catch(() => {});
    if (this.active === session) {
      this.active = null;
      this.activate(this.sessions[Math.min(index, this.sessions.length - 1)] ?? null);
    }
    this.emit();
  }

  activate(session: Session | null): void {
    if (this.active === session) {
      this.active?.focus();
      return;
    }
    this.active?.hide();
    this.active = session;
    if (session) {
      session.show();
      this.atBottom = session.atBottom;
      void invoke("session_set_active", { id: session.key }).catch(() => {});
    }
    this.emit();
  }

  cycle(delta: number): void {
    if (!this.sessions.length) return;
    const index = this.active ? this.sessions.indexOf(this.active) : -1;
    this.activate(this.sessions[(index + delta + this.sessions.length) % this.sessions.length]);
  }

  /** Relanza el proceso retomando la misma conversación del agente. */
  async restartSession(session: Session): Promise<void> {
    session.launchWith(
      resumeCommandFor(session.profileId, session.command, session.conversationId),
    );
    await session.restart();
    this.emit();
  }

  /** Descarta el hilo actual y arranca uno limpio con un id nuevo. */
  async startFreshConversation(session: Session): Promise<void> {
    const profile = profileById(session.profileId);
    if (!profile) return;
    session.conversationId = await reserveConversation(profile, session.cwd);
    session.launchWith(startCommandFor(profile, session.conversationId));
    this.persist(session);
    await session.restart();
    this.emit();
  }

  async clearHistory(session: Session): Promise<void> {
    await invoke("session_clear_output", { id: session.key }).catch(() => {});
    session.clear();
    this.emit();
  }

  async duplicate(session: Session): Promise<void> {
    const profile = profileById(session.profileId);
    if (profile) await this.createSession(profile, session.cwd, session.command);
  }

  /* ---------- Nombres ---------- */

  startRename(session: Session): void {
    this.menu = null;
    this.renaming = session;
    this.emit();
  }

  commitRename(session: Session, name: string): void {
    if (this.renaming !== session) return;
    this.renaming = null;
    const limpio = name.trim();
    if (limpio && limpio !== session.name) {
      session.name = limpio;
      this.persist(session);
    }
    this.emit();
    this.active?.focus();
  }

  cancelRename(): void {
    this.renaming = null;
    this.emit();
    this.active?.focus();
  }

  /** Vuelve al nombre derivado del perfil y su posición entre las hermanas. */
  resetName(session: Session): void {
    const label = profileById(session.profileId)?.label ?? "Sesión";
    const position = this.sessions
      .filter((s) => s.profileId === session.profileId)
      .indexOf(session);
    session.name = position ? `${label} ${position + 1}` : label;
    this.persist(session);
    this.emit();
  }

  /* ---------- Menú y lanzador ---------- */

  openMenu(session: Session, x: number, y: number): void {
    this.activate(session);
    this.menu = { session, x, y };
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
    this.active?.focus();
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
  persist(session: Session): void {
    void invoke("session_save", {
      session: {
        id: session.key,
        name: session.name,
        cwd: session.cwd,
        profileId: session.profileId,
        command: session.command,
        conversationId: session.conversationId,
        position: this.sessions.indexOf(session),
        active: session === this.active,
      },
    }).catch((error) => console.error("no se pudo guardar la sesión", error));
  }

  fitAll(): void {
    // Se reajustan todas, no sólo la visible: las de fondo comparten el mismo
    // hueco, y si quedan con el tamaño viejo el agente repinta mal al volver.
    for (const session of this.sessions) session.fitNow();
  }

  disposeAll(): void {
    for (const session of this.sessions) void session.dispose();
  }
}
