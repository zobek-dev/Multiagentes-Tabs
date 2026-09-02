import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  PROFILES,
  detectAvailable,
  commandToStore,
  conversationsFor,
  newConversationId,
  profileById,
  resumeCommandFor,
  startCommandFor,
  tracksConversation,
  type Profile,
} from "./profiles";
import { assignConversations, groupKey, type SessionRef } from "./assign";
import { Session } from "./session";

/** `getElementById` con tipo y con un fallo claro si el elemento no está. */
const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`falta el elemento #${id}`);
  return el as T;
};

const sessionList = byId("session-list");
const terminals = byId("terminals");
const emptyState = byId("empty");
const activeTitle = byId("active-title");
const activeCwd = byId("active-cwd");
const launcher = byId("launcher");
const profileGrid = byId("profile-grid");
const cwdInput = byId<HTMLInputElement>("cwd-input");
const cmdInput = byId<HTMLInputElement>("cmd-input");

const LAST_CWD_KEY = "multiagentes.lastCwd";

const sessions: Session[] = [];
let active: Session | null = null;
let selectedProfile: Profile = PROFILES[0];
/** Sesión que se está renombrando en línea, si la hay. */
let renaming: Session | null = null;
/** Confirma el renombrado en curso desde fuera del propio input. */
let commitRenaming: (() => void) | null = null;
let available = new Set<string>(PROFILES.map((p) => p.id));

/* ---------- Persistencia ---------- */

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

/**
 * Guarda los metadatos de una pestaña. Un fallo aquí no debe tumbar la
 * sesión en marcha: se registra y se sigue trabajando en memoria.
 */
function persist(session: Session): void {
  void invoke("session_save", {
    session: {
      id: session.key,
      name: session.name,
      cwd: session.cwd,
      profileId: session.profileId,
      command: session.command,
      conversationId: session.conversationId,
      position: sessions.indexOf(session),
      active: session === active,
    },
  }).catch((error) => console.error("no se pudo guardar la sesión", error));
}

function persistOrder(): void {
  void invoke("sessions_set_order", { ids: sessions.map((s) => s.key) }).catch(() => {});
}

/* ---------- Renderizado del panel lateral ---------- */

function shortenPath(path: string): string {
  if (!path) return "~";
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}

/**
 * Redibuja el panel lateral. Mientras se renombra en línea la lista queda
 * congelada: la salida de los PTY dispara render() constantemente y
 * reconstruir el `<input>` bajo el cursor le robaría el foco y el texto.
 */
function render(force = false): void {
  if (renaming && !force) {
    renderHeader();
    return;
  }
  sessionList.replaceChildren(
    ...sessions.map((session, index) => {
      const item = document.createElement("button");
      item.className = "session-item";
      if (session === active) item.classList.add("active");
      if (session.exited) item.classList.add("exited");
      else if (session.unread) item.classList.add("busy");

      const dot = document.createElement("span");
      dot.className = "session-dot";

      const labels = document.createElement("span");
      labels.className = "session-labels";
      const name = renaming === session ? buildNameEditor(session) : document.createElement("span");
      if (renaming !== session) {
        name.className = "session-name";
        name.textContent = session.name;
      }
      const sub = document.createElement("span");
      sub.className = "session-sub";
      sub.textContent = shortenPath(session.cwd);
      labels.append(name, sub);

      const badge = document.createElement("span");
      badge.className = "session-index";
      badge.textContent = index < 9 ? `⌘${index + 1}` : "";

      item.append(dot, labels, badge);
      item.addEventListener("click", () => {
        if (renaming !== session) activate(session);
      });
      item.addEventListener("dblclick", () => startRename(session));
      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        activate(session);
        openContextMenu(session, event.clientX, event.clientY);
      });
      return item;
    }),
  );

  renderHeader();
}

function renderHeader(): void {
  emptyState.style.display = sessions.length ? "none" : "flex";
  activeTitle.textContent = active ? active.name : "Sin sesiones";
  activeCwd.textContent = active ? active.cwd || "~" : "";
}

function activate(session: Session | null): void {
  if (renaming && renaming !== session) commitRenaming?.();
  if (active === session) {
    active?.focus();
    return;
  }
  active?.hide();
  active = session;
  active?.show();
  if (active) void invoke("session_set_active", { id: active.key }).catch(() => {});
  render();
}

/** Campo de edición que reemplaza al nombre dentro de la propia pestaña. */
function buildNameEditor(session: Session): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "session-name-input";
  input.value = session.name;
  input.spellcheck = false;
  commitRenaming = () => commit();

  const commit = (): void => {
    if (renaming !== session) return;
    const value = input.value.trim();
    renaming = null;
    commitRenaming = null;
    if (value && value !== session.name) {
      session.name = value;
      persist(session);
    }
    render();
    active?.focus();
  };

  const cancel = (): void => {
    if (renaming !== session) return;
    renaming = null;
    commitRenaming = null;
    render();
    active?.focus();
  };

  input.addEventListener("keydown", (event) => {
    // El input vive dentro del panel lateral: sin esto, ⌘W o los dígitos
    // llegarían a los atajos globales mientras se escribe el nombre.
    event.stopPropagation();
    if (event.key === "Enter") commit();
    else if (event.key === "Escape") cancel();
  });
  input.addEventListener("blur", commit);
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("dblclick", (event) => event.stopPropagation());
  // El nodo aún no está en el DOM cuando se construye.
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
  return input;
}

function startRename(session: Session): void {
  closeContextMenu();
  renaming = session;
  render(true);
}

/* ---------- Menú contextual de la pestaña ---------- */

let contextMenu: HTMLElement | null = null;

interface MenuAction {
  label: string;
  danger?: boolean;
  run: () => void;
}

function closeContextMenu(): void {
  contextMenu?.remove();
  contextMenu = null;
}

function openContextMenu(session: Session, x: number, y: number): void {
  closeContextMenu();
  if (renaming && renaming !== session) commitRenaming?.();

  const actions: MenuAction[] = [
    { label: "Renombrar", run: () => startRename(session) },
    { label: "Nombre por defecto", run: () => resetName(session) },
    { label: "Duplicar sesión", run: () => void duplicateSession(session) },
    {
      label: session.exited ? "Reiniciar" : "Reiniciar (mata el proceso)",
      run: () => void restartSession(session),
    },
    ...(session.conversationId
      ? [{ label: "Empezar conversación nueva", run: () => void startFreshConversation(session) }]
      : []),
    { label: "Borrar historial guardado", run: () => void clearHistory(session) },
    { label: "Cerrar", danger: true, run: () => void closeSession(session) },
  ];

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.append(
    ...actions.map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.danger ? "menu-item danger" : "menu-item";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        closeContextMenu();
        action.run();
      });
      return button;
    }),
  );

  document.body.appendChild(menu);
  // Se posiciona después de medir para no salirse por el borde de la ventana.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  contextMenu = menu;
}

/** Vuelve al nombre derivado del perfil y su posición entre las hermanas. */
function resetName(session: Session): void {
  const profile = PROFILES.find((p) => p.id === session.profileId);
  const label = profile?.label ?? "Sesión";
  const position = sessions.filter((s) => s.profileId === session.profileId).indexOf(session);
  session.name = position ? `${label} ${position + 1}` : label;
  persist(session);
  render();
}

/** Relanza el proceso retomando la misma conversación del agente. */
async function restartSession(session: Session): Promise<void> {
  session.launchWith(
    resumeCommandFor(session.profileId, session.command, session.conversationId),
  );
  await session.restart();
}

/** Descarta el hilo actual y arranca uno limpio con un id nuevo. */
async function startFreshConversation(session: Session): Promise<void> {
  const profile = profileById(session.profileId);
  if (!profile) return;
  session.conversationId = tracksConversation(profile) ? newConversationId() : null;
  session.launchWith(startCommandFor(profile, session.conversationId));
  persist(session);
  await session.restart();
}

async function clearHistory(session: Session): Promise<void> {
  await invoke("session_clear_output", { id: session.key }).catch(() => {});
  session.clear();
}

async function duplicateSession(session: Session): Promise<void> {
  const profile = PROFILES.find((p) => p.id === session.profileId);
  if (profile) await createSession(profile, session.cwd, session.command);
}

window.addEventListener("click", closeContextMenu);
window.addEventListener("blur", closeContextMenu);
window.addEventListener("resize", closeContextMenu);
window.addEventListener("contextmenu", (event) => {
  // Fuera del panel lateral no hay menú propio: se evita el nativo de la
  // WebView, que en producción sólo ofrece «recargar».
  if (!(event.target as HTMLElement).closest(".session-item")) closeContextMenu();
});

/* ---------- Ciclo de vida de sesiones ---------- */

async function createSession(profile: Profile, cwd: string, command: string): Promise<void> {
  const count = sessions.filter((s) => s.profileId === profile.id).length;
  // Si el agente deja fijar el id de la conversación, se reserva aquí: así la
  // pestaña sabe cuál retomar aunque haya varias sobre la misma carpeta.
  const usaElPerfil = !command;
  const conversationId =
    usaElPerfil && tracksConversation(profile) ? newConversationId() : null;
  const session = new Session(
    {
      name: count ? `${profile.label} ${count + 1}` : profile.label,
      cwd,
      profileId: profile.id,
      command,
      // Un comando propio se envía tal cual; si no, manda el del perfil, con
      // el id de conversación reservado cuando el agente lo admite.
      launchCommand: command || startCommandFor(profile, conversationId),
      conversationId,
    },
    terminals,
  );
  session.onUpdate = render;
  sessions.push(session);
  activate(session);
  persist(session);
  try {
    await session.start();
  } catch (error) {
    window.alert(`No se pudo abrir la terminal: ${error}`);
    await closeSession(session);
  }
  render();
}

async function closeSession(session: Session): Promise<void> {
  const index = sessions.indexOf(session);
  if (index === -1) return;
  sessions.splice(index, 1);
  await invoke("session_delete", { id: session.key }).catch(() => {});
  await session.dispose();
  persistOrder();
  if (active === session) {
    active = null;
    activate(sessions[Math.min(index, sessions.length - 1)] ?? null);
  }
  render();
}

listen<{ id: string; code: number }>("pty://exit", (event) => {
  const session = sessions.find((s) => s.ptyId === event.payload.id);
  session?.markExited(event.payload.code);
});

/* ---------- Lanzador ---------- */

function renderProfiles(): void {
  profileGrid.replaceChildren(
    ...PROFILES.map((profile) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "profile-btn";
      if (profile === selectedProfile) button.classList.add("selected");
      if (!available.has(profile.id)) button.classList.add("missing");

      const label = document.createElement("span");
      label.textContent = profile.label;
      const hint = document.createElement("small");
      hint.textContent = available.has(profile.id) ? profile.hint : "no instalado";
      button.append(label, hint);

      button.addEventListener("click", () => {
        selectedProfile = profile;
        cmdInput.value = profile.command;
        renderProfiles();
      });
      return button;
    }),
  );
}

function openLauncher(): void {
  cwdInput.value = active?.cwd || localStorage.getItem(LAST_CWD_KEY) || "";
  cmdInput.value = selectedProfile.command;
  renderProfiles();
  launcher.classList.remove("hidden");
  cmdInput.focus();
}

function closeLauncher(): void {
  launcher.classList.add("hidden");
  active?.focus();
}

async function submitLauncher(): Promise<void> {
  const cwd = cwdInput.value.trim();
  const command = commandToStore(selectedProfile, cmdInput.value);
  if (cwd) localStorage.setItem(LAST_CWD_KEY, cwd);
  closeLauncher();
  await createSession(selectedProfile, cwd, command);
}

byId("new-session").addEventListener("click", openLauncher);
byId("launch-cancel").addEventListener("click", closeLauncher);
byId("launch-go").addEventListener("click", () => void submitLauncher());
byId("pick-cwd").addEventListener("click", async () => {
  const picked = await open({ directory: true, multiple: false, defaultPath: cwdInput.value || undefined });
  if (typeof picked === "string") cwdInput.value = picked;
});
launcher.addEventListener("click", (event) => {
  if (event.target === launcher) closeLauncher();
});
[cwdInput, cmdInput].forEach((input) =>
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void submitLauncher();
  }),
);

byId("btn-clear").addEventListener("click", () => active?.clear());
byId("btn-restart").addEventListener("click", () => {
  if (active) void restartSession(active);
});
byId("btn-close").addEventListener("click", () => {
  if (active) void closeSession(active);
});

/* ---------- Atajos ---------- */

window.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (event.key === "Escape") {
    if (contextMenu) {
      closeContextMenu();
      return;
    }
    if (!launcher.classList.contains("hidden")) {
      closeLauncher();
      return;
    }
  }
  if (!mod) return;

  if (event.key === "t") {
    event.preventDefault();
    openLauncher();
  } else if (event.key === "w") {
    event.preventDefault();
    if (active) void closeSession(active);
  } else if (event.key === "k") {
    event.preventDefault();
    active?.clear();
  } else if (event.key.toLowerCase() === "r" && event.shiftKey) {
    event.preventDefault();
    if (active) startRename(active);
  } else if (event.key === "]" || (event.key === "Tab" && !event.shiftKey && event.ctrlKey)) {
    event.preventDefault();
    cycle(1);
  } else if (event.key === "[" || (event.key === "Tab" && event.shiftKey && event.ctrlKey)) {
    event.preventDefault();
    cycle(-1);
  } else if (/^[1-9]$/.test(event.key)) {
    const target = sessions[Number(event.key) - 1];
    if (target) {
      event.preventDefault();
      activate(target);
    }
  }
});

function cycle(delta: number): void {
  if (!sessions.length) return;
  const index = active ? sessions.indexOf(active) : -1;
  const next = (index + delta + sessions.length) % sessions.length;
  activate(sessions[next]);
}

window.addEventListener("resize", () => active?.fitNow());
window.addEventListener("beforeunload", () => {
  sessions.forEach((session) => void session.dispose());
});

/* ---------- Arranque ---------- */

/**
 * Rehidrata las pestañas de la ejecución anterior: primero el historial en
 * pantalla y después el proceso, con el comando de reanudación del perfil
 * (`claude --continue` en lugar de `claude`) cuando el perfil define uno.
 */
async function restoreSessions(): Promise<boolean> {
  let stored: RestoredSession[] = [];
  try {
    stored = await invoke<RestoredSession[]>("sessions_load");
  } catch (error) {
    console.error("no se pudieron cargar las sesiones guardadas", error);
    return false;
  }
  if (!stored.length) return false;

  const conversaciones = await asignarConversaciones(stored);

  let toActivate: Session | null = null;
  for (const record of stored) {
    const conversationId = conversaciones.get(record.id) ?? null;
    const session = new Session(
      {
        id: record.id,
        name: record.name,
        cwd: record.cwd,
        profileId: record.profileId,
        // Se normaliza al recuperar: lo que coincide con el perfil se guarda
        // como vacío, de modo que la pestaña adopte los cambios posteriores
        // del perfil en vez de quedarse con el texto de una versión anterior.
        command: commandToStore(profileById(record.profileId) ?? PROFILES[0], record.command),
        conversationId,
        launchCommand: resumeCommandFor(record.profileId, record.command, conversationId),
      },
      terminals,
    );
    session.onUpdate = render;
    sessions.push(session);
    if (conversationId !== record.conversationId || session.command !== record.command) {
      persist(session);
    }
    if (record.active) toActivate = session;
  }

  // La activa se muestra primero para poder medir: su tamaño se copia al
  // resto, que arrancan ocultas y por tanto no pueden calcular el suyo.
  activate(toActivate ?? sessions[0]);
  render();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const { cols, rows } = (toActivate ?? sessions[0]).dims;

  for (const session of sessions) {
    if (session !== active) session.adoptSize(cols, rows);
    const record = stored.find((r) => r.id === session.key);
    if (record) session.restoreHistory(record.output);
    try {
      await session.start();
    } catch (error) {
      console.error(`no se pudo reanudar ${session.name}`, error);
    }
  }
  render();
  return true;
}

/** Consulta al backend las conversaciones de cada grupo y las reparte. */
async function asignarConversaciones(
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

async function boot(): Promise<void> {
  try {
    available = await detectAvailable();
    selectedProfile = PROFILES.find((p) => available.has(p.id)) ?? PROFILES[PROFILES.length - 1];
  } catch {
    /* sin detección: todos los perfiles quedan disponibles */
  }
  renderProfiles();
  render();
  const restored = await restoreSessions();
  if (!restored) openLauncher();
}

void boot();
