import { useEffect, useRef } from "preact/hooks";
import { openUrl } from "@tauri-apps/plugin-opener";
import { profileById } from "../profiles";
import type { AppState, Tab } from "../state";
import type { Activity } from "../session";

const ESTADOS: Record<Activity, string> = {
  trabajando: "Trabajando",
  atencion: "Te espera",
  listo: "Sin actividad",
  terminada: "Proceso terminado",
  dormida: "Sin abrir todavía",
};

/**
 * Distintivo del agente: monograma sobre su color, con el estado en la
 * esquina. Es una marca propia, no el logotipo del fabricante.
 */
function AgentBadge({ tab }: { tab: Tab }) {
  const profile = profileById(tab.profileId);
  const activity = tab.activity;
  return (
    <span
      class="agent-badge"
      style={{ "--agent": profile?.color ?? "var(--fg-dim)" }}
      title={`${profile?.label ?? tab.profileId} · ${ESTADOS[activity]}`}
    >
      <span class="agent-mark">{profile?.mark ?? "?"}</span>
      <span class={`state-dot ${activity}`} />
    </span>
  );
}

function shortenPath(path: string): string {
  if (!path) return "~";
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}

/**
 * Campo de edición del nombre, dentro de la propia pestaña.
 *
 * Antes esto era un `<input>` creado a mano que el redibujado del panel
 * destruía a media escritura; ahora la reconciliación lo conserva, porque la
 * pestaña mantiene su clave entre renders.
 */
function NameEditor({ state, tab }: { state: AppState; tab: Tab }) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      type="text"
      class="session-name-input"
      spellcheck={false}
      value={tab.name}
      onKeyDown={(event) => {
        // El campo vive dentro del panel: sin esto, ⌘W o los dígitos llegarían
        // a los atajos globales mientras se escribe el nombre.
        event.stopPropagation();
        if (event.key === "Enter") state.commitRename(tab, event.currentTarget.value);
        else if (event.key === "Escape") state.cancelRename();
      }}
      onBlur={(event) => state.commitRename(tab, event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onDblClick={(event) => event.stopPropagation()}
    />
  );
}

export function Sidebar({ state }: { state: AppState }) {
  return (
    <aside id="sidebar">
      <header class="sidebar-head" data-tauri-drag-region>
        <span class="brand">Multiagentes</span>
      </header>

      <nav class="session-list">
        {state.tabs.map((tab, index) => {
          const clases = ["session-item"];
          if (tab === state.active) clases.push("active");
          if (tab.activity === "terminada") clases.push("exited");
          else if (tab.unread) clases.push("unread");
          if (!tab.session) clases.push("asleep");

          return (
            <button
              key={tab.id}
              type="button"
              class={clases.join(" ")}
              onClick={() => {
                if (state.renaming !== tab) void state.activate(tab);
              }}
              onDblClick={() => state.startRename(tab)}
              onContextMenu={(event) => {
                event.preventDefault();
                state.openMenu(tab, event.clientX, event.clientY);
              }}
            >
              <AgentBadge tab={tab} />
              <span class="session-labels">
                {state.renaming === tab ? (
                  <NameEditor state={state} tab={tab} />
                ) : (
                  <span class="session-name">{tab.name}</span>
                )}
                <span class="session-sub">{shortenPath(tab.cwd)}</span>
              </span>
              <span class="session-index">{index < 9 ? `⌘${index + 1}` : ""}</span>
            </button>
          );
        })}
      </nav>

      <footer class="sidebar-foot">
        {state.update ? (
          <div class="update-note">
            <span class="update-title">Versión {state.update.version} disponible</span>
            <div class="update-actions">
              <button
                type="button"
                class="link"
                onClick={() => void openUrl(state.update!.url)}
              >
                Descargar
              </button>
              <button type="button" class="link muted" onClick={() => state.dismissUpdate()}>
                Ahora no
              </button>
            </div>
          </div>
        ) : null}
        <button type="button" class="new-btn" onClick={() => state.openLauncher()}>
          <span>+</span> Nueva sesión
        </button>
      </footer>
    </aside>
  );
}
