// Genera src/ui/icons.generated.ts con un subconjunto de Material Icon Theme
// (MIT, Philipp Kief). Se incrusta sólo lo que el explorador usa: el tema
// completo son 1251 iconos y no tiene sentido llevárselos todos al paquete.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tema = require("material-icon-theme/dist/material-icons.json");
const RAIZ = "node_modules/material-icon-theme/icons/";

// Lo que se ve de verdad en un proyecto de código.
const EXTENSIONES = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "md", "mdx",
  "html", "css", "scss", "sass", "less", "svg", "png", "jpg", "jpeg", "gif",
  "webp", "ico", "pdf", "zip", "tar", "gz", "rs", "py", "rb", "go", "java",
  "kt", "swift", "c", "h", "cpp", "cs", "php", "sh", "bash", "zsh", "fish",
  "yml", "yaml", "toml", "ini", "env", "sql", "db", "sqlite", "sqlite3",
  "lock", "log", "txt", "csv", "vue", "svelte", "astro", "liquid", "graphql",
  "prisma", "dockerfile", "makefile", "wasm", "ttf", "woff", "woff2", "mp4",
  "mp3", "wav",
];

const NOMBRES = [
  "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts",
  "readme.md", "license", "dockerfile", "docker-compose.yml", "makefile",
  ".gitignore", ".gitattributes", ".env", ".editorconfig", ".npmrc",
  "cargo.toml", "cargo.lock", "yarn.lock", "pnpm-lock.yaml", "bun.lock",
  ".eslintrc.json", "eslint.config.js", ".prettierrc", "claude.md",
  "agents.md", "index.html", "main.rs", "lib.rs",
];

const CARPETAS = [
  "src", "dist", "build", "test", "tests", "node_modules", "public", "assets",
  "images", "components", "config", "scripts", "docs", "lib", "utils", "hooks",
  "styles", "api", "server", "client", "target", "tools", "ui", ".git",
  ".github", ".vscode", "android", "ios",
];

const usados = new Map();

function svg(nombreIcono) {
  if (!nombreIcono) return null;
  if (usados.has(nombreIcono)) return nombreIcono;
  const def = tema.iconDefinitions[nombreIcono];
  if (!def) return null;
  const archivo = def.iconPath.replace("./../icons/", "");
  try {
    const contenido = readFileSync(RAIZ + archivo, "utf8")
      .replace(/<\?xml[^>]*\?>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, " ")
      .trim();
    usados.set(nombreIcono, contenido);
    return nombreIcono;
  } catch {
    return null;
  }
}

const mapa = (claves, origen) => {
  const salida = {};
  for (const clave of claves) {
    const icono = svg(origen[clave]);
    if (icono) salida[clave] = icono;
  }
  return salida;
};

const porExtension = mapa(EXTENSIONES, tema.fileExtensions);
const porNombre = mapa(NOMBRES, tema.fileNames);
const porCarpeta = mapa(CARPETAS, tema.folderNames);
const porCarpetaAbierta = mapa(CARPETAS, tema.folderNamesExpanded);

// Los tres respaldos, para lo que no encaje en ninguna lista.
for (const base of [tema.file, tema.folder, tema.folderExpanded]) svg(base);

const literal = (objeto) =>
  `{\n${Object.entries(objeto)
    .map(([clave, valor]) => `  ${JSON.stringify(clave)}: ${JSON.stringify(valor)},`)
    .join("\n")}\n}`;

const salida = `// Generado por tools/build-icons.mjs — no editar a mano.
// Iconos de Material Icon Theme (MIT, Philipp Kief):
// https://github.com/material-extensions/vscode-material-icon-theme

export const SVG: Record<string, string> = ${literal(Object.fromEntries(usados))};

export const POR_EXTENSION: Record<string, string> = ${literal(porExtension)};
export const POR_NOMBRE: Record<string, string> = ${literal(porNombre)};
export const POR_CARPETA: Record<string, string> = ${literal(porCarpeta)};
export const POR_CARPETA_ABIERTA: Record<string, string> = ${literal(porCarpetaAbierta)};

export const ARCHIVO_POR_DEFECTO = ${JSON.stringify(tema.file)};
export const CARPETA_POR_DEFECTO = ${JSON.stringify(tema.folder)};
export const CARPETA_ABIERTA_POR_DEFECTO = ${JSON.stringify(tema.folderExpanded)};
`;

writeFileSync("src/ui/icons.generated.ts", salida);
const peso = Buffer.byteLength(salida) / 1024;
console.log(`${usados.size} iconos · ${peso.toFixed(0)} KB en src/ui/icons.generated.ts`);
