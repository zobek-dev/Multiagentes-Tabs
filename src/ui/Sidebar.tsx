import { useEffect, useRef } from "preact/hooks";
import type { AppState } from "../state";
import type { Session } from "../session";

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
function NameEditor({ state, session }: { state: AppState; session: Session }) {
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
      value={session.name}
      onKeyDown={(event) => {
        // El campo vive dentro del panel: sin esto, ⌘W o los dígitos llegarían
        // a los atajos globales mientras se escribe el nombre.
        event.stopPropagation();
        if (event.key === "Enter") state.commitRename(session, event.currentTarget.value);
        else if (event.key === "Escape") state.cancelRename();
      }}
      onBlur={(event) => state.commitRename(session, event.currentTarget.value)}
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
        {state.sessions.map((session, index) => {
          const clases = ["session-item"];
          if (session === state.active) clases.push("active");
          if (session.exited) clases.push("exited");
          else if (session.unread) clases.push("busy");

          return (
            <button
              key={session.key}
              type="button"
              class={clases.join(" ")}
              onClick={() => {
                if (state.renaming !== session) state.activate(session);
              }}
              onDblClick={() => state.startRename(session)}
              onContextMenu={(event) => {
                event.preventDefault();
                state.openMenu(session, event.clientX, event.clientY);
              }}
            >
              <span class="session-dot" />
              <span class="session-labels">
                {state.renaming === session ? (
                  <NameEditor state={state} session={session} />
                ) : (
                  <span class="session-name">{session.name}</span>
                )}
                <span class="session-sub">{shortenPath(session.cwd)}</span>
              </span>
              <span class="session-index">{index < 9 ? `⌘${index + 1}` : ""}</span>
            </button>
          );
        })}
      </nav>

      <footer class="sidebar-foot">
        <button type="button" class="new-btn" onClick={() => state.openLauncher()}>
          <span>+</span> Nueva sesión
        </button>
      </footer>
    </aside>
  );
}
