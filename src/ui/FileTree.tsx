import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Entry } from "../files";
import type { AppState } from "../state";
import { FileIcon } from "./FileIcon";

/** Campo para escribir el nombre de algo nuevo o renombrado, en su fila. */
function NameField({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // Se preselecciona el nombre sin la extensión, que es lo que se suele
    // querer cambiar.
    const punto = initial.lastIndexOf(".");
    input.setSelectionRange(0, punto > 0 ? punto : initial.length);
  }, []);

  return (
    <input
      ref={ref}
      type="text"
      class="file-name-input"
      spellcheck={false}
      value={initial}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") onCommit(event.currentTarget.value);
        else if (event.key === "Escape") onCancel();
      }}
      onBlur={(event) => onCommit(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

function FileMenu({ state }: { state: AppState }) {
  const files = state.files;
  const anchor = files.menu;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const caja = ref.current.getBoundingClientRect();
    setPos({
      left: Math.min(anchor.x, window.innerWidth - caja.width - 8),
      top: Math.min(anchor.y, window.innerHeight - caja.height - 8),
    });
  }, [anchor?.entry.path, anchor?.x, anchor?.y]);

  if (!anchor) return null;
  const { entry } = anchor;
  const carpeta = entry.isDir ? entry.path : entry.path.slice(0, entry.path.lastIndexOf("/"));

  const acciones: { label: string; danger?: boolean; run: () => void }[] = [
    ...files.editors.map((editor) => ({
      label: `Abrir con ${editor.label}`,
      run: () => void files.openWith(editor.id, entry.path),
    })),
    {
      label: "Insertar ruta en la terminal",
      run: () => state.active?.session?.insertText(entry.path),
    },
    { label: "Copiar ruta", run: () => void navigator.clipboard.writeText(entry.path) },
    { label: "Mostrar en el Finder", run: () => void revealItemInDir(entry.path) },
    { label: "Nuevo archivo", run: () => files.startCreate(carpeta, false) },
    { label: "Nueva carpeta", run: () => files.startCreate(carpeta, true) },
    { label: "Renombrar", run: () => files.startRename(entry.path) },
    { label: "Duplicar", run: () => void files.duplicate(entry.path) },
    {
      label: "Mover a la papelera",
      danger: true,
      run: () => {
        // Va a la papelera del sistema, pero sigue siendo el código de alguien:
        // más vale una pregunta de sobra que un susto.
        const que = entry.isDir ? "la carpeta" : "el archivo";
        if (window.confirm(`¿Mover ${que} «${entry.name}» a la papelera?`)) {
          void files.trash(entry.path);
        }
      },
    },
  ];

  // Los separadores marcan los tres grupos: abrir, crear, modificar.
  const separadores = new Set([files.editors.length + 2, files.editors.length + 5]);

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
      {acciones.map((accion, indice) => (
        <>
          {separadores.has(indice) ? <span class="menu-sep" /> : null}
          <button
            key={accion.label}
            type="button"
            class={accion.danger ? "menu-item danger" : "menu-item"}
            onClick={() => {
              files.closeMenu();
              accion.run();
            }}
          >
            {accion.label}
          </button>
        </>
      ))}
    </div>
  );
}

function Fila({ state, entry, depth }: { state: AppState; entry: Entry; depth: number }) {
  const files = state.files;
  const abierta = entry.isDir && files.isExpanded(entry.path);
  const clases = ["file-row"];
  if (files.selected === entry.path) clases.push("selected");
  if (entry.hidden) clases.push("hidden-entry");

  const abrir = (): void => {
    files.select(entry.path);
    if (entry.isDir) void files.toggleDir(entry.path);
    else if (files.editors.length) void files.openWith(files.editors[0].id, entry.path);
  };

  return (
    <div
      class={clases.join(" ")}
      style={{ paddingLeft: `${8 + depth * 13}px` }}
      onClick={abrir}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        files.openMenu(entry, event.clientX, event.clientY);
      }}
    >
      <span class={`twisty ${entry.isDir ? "" : "leaf"} ${abierta ? "open" : ""}`}>
        {entry.isDir ? "›" : ""}
      </span>
      <FileIcon name={entry.name} isDir={entry.isDir} abierta={abierta} />
      {files.renaming === entry.path ? (
        <NameField
          initial={entry.name}
          onCommit={(valor) => void files.confirmRename(valor)}
          onCancel={() => files.cancelEdit()}
        />
      ) : (
        <span class="file-name">{entry.name}</span>
      )}
    </div>
  );
}

export function FileTree({ state }: { state: AppState }) {
  const files = state.files;
  const rows = files.rows();
  const raizNombre = files.root?.split("/").filter(Boolean).pop() ?? "";

  return (
    <aside class={`files ${files.side}`} style={{ width: `${files.width}px` }}>
      <header class="files-head">
        <span class="files-title" title={files.root ?? ""}>
          {raizNombre || "Sin carpeta"}
        </span>
        <div class="files-actions">
          <button
            type="button"
            class="icon-btn"
            title="Nuevo archivo en la raíz"
            disabled={!files.root}
            onClick={() => files.root && files.startCreate(files.root, false)}
          >
            +
          </button>
          <button
            type="button"
            class={files.showHidden ? "icon-btn on" : "icon-btn"}
            title="Mostrar archivos ocultos"
            onClick={() => files.toggleHidden()}
          >
            ·
          </button>
          <button
            type="button"
            class="icon-btn"
            title={files.side === "derecha" ? "Mover a la izquierda" : "Mover a la derecha"}
            onClick={() => {
              files.toggleSide();
              requestAnimationFrame(() => state.fitAll());
            }}
          >
            {files.side === "derecha" ? "‹" : "›"}
          </button>
        </div>
      </header>

      <div
        class="files-tree"
        onContextMenu={(event) => {
          // Clic derecho en el hueco: se opera sobre la carpeta raíz.
          if (!files.root) return;
          event.preventDefault();
          files.openMenu(
            { name: raizNombre, path: files.root, isDir: true, hidden: false, size: 0 },
            event.clientX,
            event.clientY,
          );
        }}
      >
        {files.creating?.parent === files.root ? (
          <div class="file-row" style={{ paddingLeft: "8px" }}>
            <span class="twisty leaf" />
            <FileIcon name={files.creating.isDir ? "nueva" : "nuevo.txt"} isDir={files.creating.isDir} />
            <NameField
              initial=""
              onCommit={(valor) => void files.confirmCreate(valor)}
              onCancel={() => files.cancelEdit()}
            />
          </div>
        ) : null}

        {rows.map(({ entry, depth }) => (
          <Fila key={entry.path} state={state} entry={entry} depth={depth} />
        ))}

        {files.root && !rows.length && !files.isLoading(files.root) ? (
          <p class="files-empty">Carpeta vacía</p>
        ) : null}
        {files.truncated ? (
          <p class="files-empty">Se muestran las primeras 2000 entradas</p>
        ) : null}
      </div>

      {files.error ? (
        <div class="files-error" onClick={() => files.dismissError()}>
          {files.error}
        </div>
      ) : null}

      <footer class="files-foot">
        <button
          type="button"
          class="link muted"
          onClick={() => void openUrl("https://github.com/material-extensions/vscode-material-icon-theme")}
        >
          Iconos: Material Icon Theme
        </button>
      </footer>

      <FileMenu state={state} />
    </aside>
  );
}
