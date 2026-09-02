import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => VERSION_INSTALADA) }));

let VERSION_INSTALADA = "0.1.2";

const { buscarActualizacion, esPosterior } = await import("./update");

/** Respuesta de la API de versiones de GitHub, recortada a lo que se usa. */
function responder(body: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response),
  );
}

// El entorno de pruebas es Node, sin almacenamiento del navegador.
const memoria = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (clave: string) => memoria.get(clave) ?? null,
  setItem: (clave: string, valor: string) => void memoria.set(clave, valor),
  removeItem: (clave: string) => void memoria.delete(clave),
  clear: () => memoria.clear(),
});

beforeEach(() => {
  VERSION_INSTALADA = "0.1.2";
  memoria.clear();
});

describe("comparación de versiones", () => {
  it("reconoce una versión posterior en cualquiera de los tres números", () => {
    expect(esPosterior("0.1.3", "0.1.2")).toBe(true);
    expect(esPosterior("0.2.0", "0.1.9")).toBe(true);
    expect(esPosterior("1.0.0", "0.9.9")).toBe(true);
  });

  it("no avisa de la misma versión ni de una anterior", () => {
    expect(esPosterior("0.1.2", "0.1.2")).toBe(false);
    expect(esPosterior("0.1.1", "0.1.2")).toBe(false);
    expect(esPosterior("0.9.9", "1.0.0")).toBe(false);
  });

  it("compara números, no texto", () => {
    // El fallo clásico: alfabéticamente "0.1.10" va antes que "0.1.9".
    expect(esPosterior("0.1.10", "0.1.9")).toBe(true);
    expect(esPosterior("0.1.9", "0.1.10")).toBe(false);
  });

  it("acepta la etiqueta con la v delante", () => {
    expect(esPosterior("v0.2.0", "0.1.0")).toBe(true);
  });

  it("no toma una preliberación por versión nueva", () => {
    expect(esPosterior("0.1.2-beta.1", "0.1.2")).toBe(false);
  });

  it("tolera versiones de distinta longitud", () => {
    expect(esPosterior("0.2", "0.1.9")).toBe(true);
    expect(esPosterior("0.1", "0.1.0")).toBe(false);
  });
});

describe("consulta de la última versión", () => {
  const release = {
    tag_name: "v0.1.3",
    html_url: "https://github.com/zobek-dev/Multiagentes-Tabs/releases/tag/v0.1.3",
  };

  it("avisa cuando la publicada es posterior", async () => {
    responder(release);
    expect(await buscarActualizacion()).toEqual({
      version: "0.1.3",
      url: release.html_url,
    });
  });

  it("calla cuando ya se tiene la última", async () => {
    VERSION_INSTALADA = "0.1.3";
    responder(release);
    expect(await buscarActualizacion()).toBeNull();
  });

  it("no propone borradores ni preliberaciones", async () => {
    responder({ ...release, prerelease: true });
    expect(await buscarActualizacion()).toBeNull();
    responder({ ...release, draft: true });
    expect(await buscarActualizacion()).toBeNull();
  });

  it("respeta el «ahora no» de esa versión", async () => {
    memoria.set("multiagentes.updateDescartada", "0.1.3");
    responder(release);
    expect(await buscarActualizacion()).toBeNull();
  });

  it("quedarse sin conexión no es un error que mostrar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("sin red"); }));
    expect(await buscarActualizacion()).toBeNull();
    responder({}, false);
    expect(await buscarActualizacion()).toBeNull();
  });
});
