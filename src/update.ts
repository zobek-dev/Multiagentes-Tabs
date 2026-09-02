import { getVersion } from "@tauri-apps/api/app";

/** Dónde se publican las versiones. */
const RELEASES = "https://api.github.com/repos/zobek-dev/Multiagentes-Tabs/releases/latest";

/** Cada cuánto se vuelve a mirar mientras la aplicación sigue abierta. */
export const INTERVALO_COMPROBACION_MS = 6 * 60 * 60 * 1000;

const DESCARTADA_KEY = "multiagentes.updateDescartada";

export interface UpdateInfo {
  version: string;
  /** Página de la versión, que es donde están los instaladores. */
  url: string;
}

/**
 * Compara dos versiones estilo `1.2.3`.
 *
 * Se compara número a número, no como texto: `0.1.10` es posterior a `0.1.9`,
 * aunque alfabéticamente vaya antes. Lo que siga a un guion (`0.2.0-beta`) se
 * ignora, de modo que una preliberación no cuenta como versión nueva.
 */
export function esPosterior(candidata: string, actual: string): boolean {
  const partes = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);

  const a = partes(candidata);
  const b = partes(actual);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Versiones que el usuario ya dijo no querer. */
function descartada(version: string): boolean {
  try {
    return localStorage.getItem(DESCARTADA_KEY) === version;
  } catch {
    return false;
  }
}

export function descartar(version: string): void {
  try {
    localStorage.setItem(DESCARTADA_KEY, version);
  } catch {
    /* sin almacenamiento: se volverá a avisar en el próximo arranque */
  }
}

/**
 * Mira si hay una versión publicada posterior a la instalada.
 *
 * Devuelve `null` cuando no la hay, cuando el usuario ya descartó esa versión
 * o cuando no se puede consultar: quedarse sin conexión no es algo que deba
 * interrumpir a nadie con un error.
 */
export async function buscarActualizacion(): Promise<UpdateInfo | null> {
  try {
    const [actual, respuesta] = await Promise.all([
      getVersion(),
      fetch(RELEASES, { headers: { Accept: "application/vnd.github+json" } }),
    ]);
    if (!respuesta.ok) return null;

    const release = (await respuesta.json()) as {
      tag_name?: string;
      html_url?: string;
      draft?: boolean;
      prerelease?: boolean;
    };
    if (release.draft || release.prerelease) return null;

    const version = (release.tag_name ?? "").replace(/^v/, "");
    if (!version || descartada(version) || !esPosterior(version, actual)) return null;

    return { version, url: release.html_url ?? "" };
  } catch {
    return null;
  }
}
