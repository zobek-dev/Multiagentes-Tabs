import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AppState } from "../state";

interface Accion {
  label: string;
  danger?: boolean;
  run: () => void;
}

export function ContextMenu({ state }: { state: AppState }) {
  const anchor = state.menu;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Se mide una vez montado para no salirse por el borde de la ventana.
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const caja = ref.current.getBoundingClientRect();
    setPos({
      left: Math.min(anchor.x, window.innerWidth - caja.width - 8),
      top: Math.min(anchor.y, window.innerHeight - caja.height - 8),
    });
  }, [anchor?.tab.id, anchor?.x, anchor?.y]);

  if (!anchor) return null;
  const { tab } = anchor;

  const acciones: Accion[] = [
    { label: "Renombrar", run: () => state.startRename(tab) },
    { label: "Nombre por defecto", run: () => state.resetName(tab) },
    { label: "Duplicar sesión", run: () => void state.duplicate(tab) },
    {
      label: tab.session ? "Reiniciar (mata el proceso)" : "Abrir",
      run: () => void state.restartTab(tab),
    },
    ...(tab.conversationId
      ? [
          {
            label: "Empezar conversación nueva",
            run: () => void state.startFreshConversation(tab),
          },
        ]
      : []),
    { label: "Borrar historial guardado", run: () => void state.clearHistory(tab) },
    { label: "Cerrar", danger: true, run: () => void state.closeTab(tab) },
  ];

  return (
    <div
      ref={ref}
      class="context-menu"
      style={{
        left: `${pos?.left ?? anchor.x}px`,
        top: `${pos?.top ?? anchor.y}px`,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {acciones.map((accion) => (
        <button
          key={accion.label}
          type="button"
          class={accion.danger ? "menu-item danger" : "menu-item"}
          onClick={() => {
            state.closeMenu();
            accion.run();
          }}
        >
          {accion.label}
        </button>
      ))}
    </div>
  );
}
