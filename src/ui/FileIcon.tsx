import {
  ARCHIVO_POR_DEFECTO,
  CARPETA_ABIERTA_POR_DEFECTO,
  CARPETA_POR_DEFECTO,
  POR_CARPETA,
  POR_CARPETA_ABIERTA,
  POR_EXTENSION,
  POR_NOMBRE,
  SVG,
} from "./icons.generated";

/**
 * Elige el icono como lo hace Material Icon Theme: primero por nombre exacto
 * (`package.json` tiene el suyo), después por extensión, y sólo entonces el
 * genérico. Las extensiones compuestas se prueban de más larga a más corta,
 * para que `.d.ts` no acabe con el icono de `.ts`.
 */
function nombreDelIcono(name: string, isDir: boolean, abierta: boolean): string {
  const clave = name.toLowerCase();

  if (isDir) {
    const mapa = abierta ? POR_CARPETA_ABIERTA : POR_CARPETA;
    return mapa[clave] ?? (abierta ? CARPETA_ABIERTA_POR_DEFECTO : CARPETA_POR_DEFECTO);
  }

  if (POR_NOMBRE[clave]) return POR_NOMBRE[clave];

  const partes = clave.split(".");
  for (let i = 1; i < partes.length; i++) {
    const extension = partes.slice(i).join(".");
    if (POR_EXTENSION[extension]) return POR_EXTENSION[extension];
  }
  return ARCHIVO_POR_DEFECTO;
}

export function FileIcon({
  name,
  isDir = false,
  abierta = false,
}: {
  name: string;
  isDir?: boolean;
  abierta?: boolean;
}) {
  const svg = SVG[nombreDelIcono(name, isDir, abierta)] ?? SVG[ARCHIVO_POR_DEFECTO];
  // Los iconos son SVG del tema, ya con sus colores; se insertan tal cual.
  return <span class="file-icon" dangerouslySetInnerHTML={{ __html: svg ?? "" }} />;
}
