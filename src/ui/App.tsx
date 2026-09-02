import { useEffect, useRef } from "preact/hooks";
import type { AppState } from "../state";
import { ContextMenu } from "./ContextMenu";
import { Launcher } from "./Launcher";
import { Sidebar } from "./Sidebar";
import { useAppState } from "./hooks";

function Topbar({ state }: { state: AppState }) {
  const activa = state.active;
  return (
    <header class="topbar" data-tauri-drag-region>
      <div class="topbar-info">
        <span class="active-title">{activa ? activa.name : "Sin sesiones"}</span>
        <span class="active-cwd">{activa ? activa.cwd || "~" : ""}</span>
      </div>
      <div class="topbar-actions">
        <button
          type="button"
          class="ghost"
          title="Limpiar (⌘K)"
          disabled={!activa}
          onClick={() => activa?.clear()}
        >
          Limpiar
        </button>
        <button
          type="button"
          class="ghost"
          title="Reiniciar la sesión retomando la conversación"
          disabled={!activa}
          onClick={() => activa && void state.restartSession(activa)}
        >
          Reiniciar
        </button>
        <button
          type="button"
          class="ghost danger"
          title="Cerrar (⌘W)"
          disabled={!activa}
          onClick={() => activa && void state.closeSession(activa)}
        >
          Cerrar
        </button>
      </div>
    </header>
  );
}

export function App({ state }: { state: AppState }) {
  useAppState(state);
  const terminales = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (terminales.current) void state.attach(terminales.current);
  }, []);

  useEffect(() => {
    const alRedimensionar = (): void => {
      state.closeMenu();
      state.fitAll();
    };
    const alSalir = (): void => state.disposeAll();

    window.addEventListener("resize", alRedimensionar);
    window.addEventListener("beforeunload", alSalir);
    return () => {
      window.removeEventListener("resize", alRedimensionar);
      window.removeEventListener("beforeunload", alSalir);
    };
  }, [state]);

  useEffect(() => {
    const alPulsar = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;

      if (event.key === "Escape") {
        if (state.menu) return state.closeMenu();
        if (state.launcher) return state.closeLauncher();
      }
      if (!mod) return;

      const tecla = event.key.toLowerCase();
      if (tecla === "t") {
        event.preventDefault();
        state.openLauncher();
      } else if (tecla === "w") {
        event.preventDefault();
        if (state.active) void state.closeSession(state.active);
      } else if (tecla === "k") {
        event.preventDefault();
        state.active?.clear();
      } else if (tecla === "r" && event.shiftKey) {
        event.preventDefault();
        if (state.active) state.startRename(state.active);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        state.active?.scrollToBottom();
      } else if (event.key === "]" || (event.key === "Tab" && !event.shiftKey && event.ctrlKey)) {
        event.preventDefault();
        state.cycle(1);
      } else if (event.key === "[" || (event.key === "Tab" && event.shiftKey && event.ctrlKey)) {
        event.preventDefault();
        state.cycle(-1);
      } else if (/^[1-9]$/.test(event.key)) {
        const destino = state.sessions[Number(event.key) - 1];
        if (destino) {
          event.preventDefault();
          state.activate(destino);
        }
      }
    };

    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, [state]);

  // Un clic en cualquier parte cierra el menú contextual abierto.
  useEffect(() => {
    const cerrar = (): void => state.closeMenu();
    window.addEventListener("click", cerrar);
    window.addEventListener("blur", cerrar);
    return () => {
      window.removeEventListener("click", cerrar);
      window.removeEventListener("blur", cerrar);
    };
  }, [state]);

  const vacio = state.ready && !state.sessions.length;

  return (
    <>
      <div id="app">
        <Sidebar state={state} />
        <main class="main">
          <Topbar state={state} />
          <section class="terminals">
            {/* Territorio de xterm: Preact no pone hijos aquí dentro, así que
                nunca compite con los nodos que monta la clase Session. */}
            <div class="term-mount" ref={terminales} />
            {!state.atBottom && state.active ? (
              <button
                type="button"
                class="to-bottom"
                onClick={() => state.active?.scrollToBottom()}
              >
                Ir al final <span class="key">⌘↓</span>
              </button>
            ) : null}
          </section>
          {vacio ? (
            <div class="empty">
              <p class="empty-title">No hay sesiones abiertas</p>
              <p class="empty-hint">
                Pulsa <kbd>⌘</kbd>
                <kbd>T</kbd> o «Nueva sesión» para lanzar un agente.
              </p>
            </div>
          ) : null}
        </main>
      </div>
      {state.launcher ? <Launcher state={state} /> : null}
      <ContextMenu state={state} />
    </>
  );
}
