import { invoke } from "@tauri-apps/api/core";

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  hidden: boolean;
  size: number;
}

export interface Listing {
  path: string;
  entries: Entry[];
  truncated: boolean;
}

export interface Editor {
  id: string;
  label: string;
}

/** Fila del árbol ya aplanado, lista para dibujar. */
export interface Row {
  entry: Entry;
  depth: number;
}

export interface FileMenuAnchor {
  entry: Entry;
  x: number;
  y: number;
}

const ANCHO_MIN = 180;
const ANCHO_MAX = 520;
const ANCHO_KEY = "multiagentes.filesWidth";
const ABIERTO_KEY = "multiagentes.filesOpen";
const LADO_KEY = "multiagentes.filesSide";

export type Lado = "izquierda" | "derecha";

function leerNumero(clave: string, porDefecto: number): number {
  try {
    const valor = Number.parseInt(localStorage.getItem(clave) ?? "", 10);
    return Number.isFinite(valor) ? valor : porDefecto;
  } catch {
    return porDefecto;
  }
}

/**
 * El árbol de archivos del panel lateral.
 *
 * La carga es perezosa: sólo se pide el contenido de las carpetas que el
 * usuario abre, porque un proyecto con `node_modules` tiene cientos de miles
 * de archivos y recorrerlo entero al arrancar bloquearía la interfaz.
 */
export class FileBrowser {
  root: string | null = null;
  open: boolean;
  width: number;
  /** A qué lado de la terminal se dibuja el panel. */
  side: Lado;
  showHidden = false;
  selected: string | null = null;
  menu: FileMenuAnchor | null = null;
  editors: Editor[] = [];
  /** Ruta que se está renombrando en el árbol. */
  renaming: string | null = null;
  /** Carpeta donde se está creando algo, y de qué tipo. */
  creating: { parent: string; isDir: boolean } | null = null;
  error: string | null = null;

  private listings = new Map<string, Listing>();
  private expanded = new Set<string>();
  private cargando = new Set<string>();

  constructor(private emit: () => void) {
    this.open = (() => {
      try {
        return localStorage.getItem(ABIERTO_KEY) !== "0";
      } catch {
        return true;
      }
    })();
    this.width = Math.min(ANCHO_MAX, Math.max(ANCHO_MIN, leerNumero(ANCHO_KEY, 240)));
    this.side = (() => {
      try {
        return localStorage.getItem(LADO_KEY) === "izquierda" ? "izquierda" : "derecha";
      } catch {
        return "derecha";
      }
    })();
    void invoke<Editor[]>("available_editors")
      .then((editors) => {
        this.editors = editors;
        this.emit();
      })
      .catch(() => {});
  }

  /* ---------- Panel ---------- */

  toggle(): void {
    this.open = !this.open;
    try {
      localStorage.setItem(ABIERTO_KEY, this.open ? "1" : "0");
    } catch {
      /* sin almacenamiento: se abrirá por defecto la próxima vez */
    }
    this.emit();
  }

  setWidth(px: number): void {
    this.width = Math.min(ANCHO_MAX, Math.max(ANCHO_MIN, Math.round(px)));
    try {
      localStorage.setItem(ANCHO_KEY, String(this.width));
    } catch {
      /* idem */
    }
    this.emit();
  }

  /** Cambia el panel de lado; el ancho y lo demás se conservan. */
  toggleSide(): void {
    this.side = this.side === "derecha" ? "izquierda" : "derecha";
    try {
      localStorage.setItem(LADO_KEY, this.side);
    } catch {
      /* sin almacenamiento: volverá a la derecha en el próximo arranque */
    }
    this.emit();
  }

  toggleHidden(): void {
    this.showHidden = !this.showHidden;
    this.emit();
  }

  /* ---------- Árbol ---------- */

  /** Cambia la carpeta raíz, normalmente al cambiar de pestaña. */
  setRoot(path: string | null): void {
    const raiz = path || null;
    if (raiz === this.root) return;
    this.root = raiz;
    this.expanded.clear();
    this.listings.clear();
    this.selected = null;
    this.menu = null;
    if (raiz) void this.load(raiz);
    this.emit();
  }

  isExpanded(path: string): boolean {
    return this.expanded.has(path);
  }

  isLoading(path: string): boolean {
    return this.cargando.has(path);
  }

  async toggleDir(path: string): Promise<void> {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      this.emit();
      return;
    }
    this.expanded.add(path);
    this.emit();
    if (!this.listings.has(path)) await this.load(path);
  }

  private async load(path: string): Promise<void> {
    if (this.cargando.has(path)) return;
    this.cargando.add(path);
    this.emit();
    try {
      this.listings.set(path, await invoke<Listing>("list_dir", { path }));
      this.error = null;
    } catch (error) {
      // Una carpeta sin permisos no debe dejar el árbol en un estado a medias.
      this.expanded.delete(path);
      this.error = String(error);
    } finally {
      this.cargando.delete(path);
      this.emit();
    }
  }

  private async reload(path: string): Promise<void> {
    this.listings.delete(path);
    await this.load(path);
  }

  /** ¿Está recortada la carpeta raíz o alguna abierta? */
  get truncated(): boolean {
    for (const listing of this.listings.values()) if (listing.truncated) return true;
    return false;
  }

  /** El árbol aplanado, en el orden en que se dibuja. */
  rows(): Row[] {
    if (!this.root) return [];
    const filas: Row[] = [];
    const visitar = (path: string, depth: number): void => {
      const listing = this.listings.get(path);
      if (!listing) return;
      for (const entry of listing.entries) {
        if (entry.hidden && !this.showHidden) continue;
        filas.push({ entry, depth });
        if (entry.isDir && this.expanded.has(entry.path)) visitar(entry.path, depth + 1);
      }
    };
    visitar(this.root, 0);
    return filas;
  }

  /* ---------- Menú y selección ---------- */

  select(path: string): void {
    this.selected = path;
    this.emit();
  }

  openMenu(entry: Entry, x: number, y: number): void {
    this.selected = entry.path;
    this.menu = { entry, x, y };
    this.emit();
  }

  closeMenu(): void {
    if (!this.menu) return;
    this.menu = null;
    this.emit();
  }

  /* ---------- Operaciones ---------- */

  private parentOf(path: string): string {
    const corte = path.lastIndexOf("/");
    return corte > 0 ? path.slice(0, corte) : "/";
  }

  async openWith(editor: string, path: string): Promise<void> {
    try {
      await invoke("open_in_editor", { editor, path });
    } catch (error) {
      this.error = `No se pudo abrir el editor: ${error}`;
      this.emit();
    }
  }

  startCreate(parent: string, isDir: boolean): void {
    this.menu = null;
    // Crear dentro de una carpeta cerrada no se vería: se abre primero.
    if (parent !== this.root && !this.expanded.has(parent)) void this.toggleDir(parent);
    this.creating = { parent, isDir };
    this.emit();
  }

  startRename(path: string): void {
    this.menu = null;
    this.renaming = path;
    this.emit();
  }

  cancelEdit(): void {
    this.creating = null;
    this.renaming = null;
    this.emit();
  }

  async confirmCreate(name: string): Promise<void> {
    const creating = this.creating;
    this.creating = null;
    if (!creating || !name.trim()) return this.emit();
    try {
      const path = await invoke<string>("create_entry", {
        parent: creating.parent,
        name: name.trim(),
        isDir: creating.isDir,
      });
      this.selected = path;
      this.error = null;
      await this.reload(creating.parent);
    } catch (error) {
      this.error = String(error);
      this.emit();
    }
  }

  async confirmRename(name: string): Promise<void> {
    const path = this.renaming;
    this.renaming = null;
    if (!path || !name.trim()) return this.emit();
    try {
      const nuevo = await invoke<string>("rename_entry", { path, name: name.trim() });
      this.selected = nuevo;
      this.error = null;
      await this.reload(this.parentOf(path));
    } catch (error) {
      this.error = String(error);
      this.emit();
    }
  }

  async duplicate(path: string): Promise<void> {
    try {
      this.selected = await invoke<string>("duplicate_entry", { path });
      this.error = null;
    } catch (error) {
      this.error = String(error);
    }
    await this.reload(this.parentOf(path));
  }

  async trash(path: string): Promise<void> {
    try {
      await invoke("trash_entry", { path });
      if (this.selected === path) this.selected = null;
      this.expanded.delete(path);
      this.listings.delete(path);
      this.error = null;
    } catch (error) {
      this.error = String(error);
    }
    await this.reload(this.parentOf(path));
  }

  dismissError(): void {
    this.error = null;
    this.emit();
  }
}
