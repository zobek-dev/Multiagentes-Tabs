import { useEffect, useRef } from "preact/hooks";
import { profileById } from "../profiles";
import type { AppState } from "../state";
import { ContextMenu } from "./ContextMenu";
import { FileTree } from "./FileTree";
import { Launcher } from "./Launcher";
import { Sidebar } from "./Sidebar";
import { useAppState } from "./hooks";

/**
 * Tapa la terminal mientras el agente se pinta por primera vez. Sin esto se ve
 * cómo borra la pantalla, se mide y repinta: una terminal a medio hacer.
 */
function Loader({ state }: { state: AppState }) {
  const tab = state.active;
  const cargando = tab ? tab.opening || tab.session?.loading : false;
  if (!tab || !cargando) return null;
  const profile = profileById(tab.profileId);
  return (
    <div class="loader">
      <span class="agent-badge big" style={{ "--agent": profile?.color ?? "var(--fg-dim)" }}>
        <span class="agent-mark">{profile?.mark ?? "?"}</span>
      </span>
      <p class="loader-title">Iniciando {profile?.label ?? "la sesión"}…</p>
      <p class="loader-sub">{tab.cwd || "~"}</p>
      <span class="loader-bar" />
    </div>
  );
}

function Topbar({ state }: { state: AppState }) {
  const activa = state.active;
  const viva = activa?.session ?? null;
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
          onClick={() => viva?.clear()}
        >
          Limpiar
        </button>
        <button
          type="button"
          class="ghost"
          title="Reiniciar la sesión retomando la conversación"
          disabled={!activa}
          onClick={() => activa && void state.restartTab(activa)}
        >
          Reiniciar
        </button>
        <button
          type="button"
          class="ghost danger"
          title="Cerrar (⌘W)"
          disabled={!activa}
          onClick={() => activa && void state.closeTab(activa)}
        >
          Cerrar
        </button>
      </div>
    </header>
  );
}

/** Divisor que ajusta el ancho del explorador arrastrando. */
function Resizer({ state }: { state: AppState }) {
  const arrastrando = useRef(false);

  useEffect(() => {
    const mover = (event: PointerEvent): void => {
      if (!arrastrando.current) return;
      // A la derecha el ancho se mide desde el borde de la ventana; a la
      // izquierda, desde donde acaba el panel de sesiones.
      state.files.setWidth(
        state.files.side === "derecha"
          ? window.innerWidth - event.clientX
          : event.clientX - 232,
      );
      state.fitAll();
    };
    const soltar = (): void => {
      arrastrando.current = false;
      document.body.classList.remove("resizing");
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar);
    return () => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", soltar);
    };
  }, [state]);

  return (
    <div
      class="resizer"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={() => {
        arrastrando.current = true;
        document.body.classList.add("resizing");
      }}
      onDblClick={() => state.files.setWidth(240)}
    />
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
        if (state.active) void state.closeTab(state.active);
      } else if (tecla === "b") {
        event.preventDefault();
        state.files.toggle();
        // El área de terminal cambia de ancho: hay que rehacer las medidas.
        requestAnimationFrame(() => state.fitAll());
      } else if (tecla === "k") {
        event.preventDefault();
        state.active?.session?.clear();
      } else if (tecla === "r" && event.shiftKey) {
        event.preventDefault();
        if (state.active) state.startRename(state.active);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        state.active?.session?.scrollToBottom();
      } else if (event.key === "]" || (event.key === "Tab" && !event.shiftKey && event.ctrlKey)) {
        event.preventDefault();
        state.cycle(1);
      } else if (event.key === "[" || (event.key === "Tab" && event.shiftKey && event.ctrlKey)) {
        event.preventDefault();
        state.cycle(-1);
      } else if (/^[1-9]$/.test(event.key)) {
        const destino = state.tabs[Number(event.key) - 1];
        if (destino) {
          event.preventDefault();
          void state.activate(destino);
        }
      }
    };

    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, [state]);

  // Un clic en cualquier parte cierra el menú contextual abierto.
  useEffect(() => {
    const cerrar = (): void => {
      state.closeMenu();
      state.files.closeMenu();
    };
    window.addEventListener("click", cerrar);
    window.addEventListener("blur", cerrar);
    return () => {
      window.removeEventListener("click", cerrar);
      window.removeEventListener("blur", cerrar);
    };
  }, [state]);

  const vacio = state.ready && !state.tabs.length;

  return (
    <>
      <div id="app">
        <Sidebar state={state} />
        {state.files.open && state.files.side === "izquierda" ? (
          <>
            <FileTree state={state} />
            <Resizer state={state} />
          </>
        ) : null}
        <main class="main">
          <Topbar state={state} />
          <section class="terminals">
            {/* Territorio de xterm: Preact no pone hijos aquí dentro, así que
                nunca compite con los nodos que monta la clase Session. */}
            <div class="term-mount" ref={terminales} />
            <Loader state={state} />
            {!state.atBottom && state.active ? (
              <button
                type="button"
                class="to-bottom"
                onClick={() => state.active?.session?.scrollToBottom()}
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
        {state.files.open && state.files.side === "derecha" ? (
          <>
            <Resizer state={state} />
            <FileTree state={state} />
          </>
        ) : null}
      </div>
      {state.launcher ? <Launcher state={state} /> : null}
      <ContextMenu state={state} />
    </>
  );
}
