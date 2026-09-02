import { describe, expect, it, vi } from "vitest";

// `invoke` sólo existe dentro de la WebView de Tauri.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { commandToStore, effectiveCommand, profileById, resumeCommandFor, startCommandFor } =
  await import("./profiles");

const claude = profileById("claude")!;
const gemini = profileById("gemini")!;
const shell = profileById("shell")!;
const UUID = "e7d036f2-c7d0-4e13-9c2f-6cf1afaf81da";

describe("comando guardado", () => {
  it("no guarda nada cuando coincide con el perfil", () => {
    expect(commandToStore(claude, claude.command)).toBe("");
    expect(commandToStore(claude, "  ")).toBe("");
  });

  it("trata el binario suelto como no personalizado", () => {
    // Así una sesión guardada por una versión anterior adopta las banderas
    // que se añadan después al perfil.
    expect(commandToStore(claude, "claude")).toBe("");
    expect(effectiveCommand(claude, "claude")).toBe(claude.command);
  });

  it("conserva un comando escrito a mano", () => {
    expect(commandToStore(claude, "claude --model opus")).toBe("claude --model opus");
    expect(effectiveCommand(claude, "claude --model opus")).toBe("claude --model opus");
  });

  it("deja vacío el perfil de shell", () => {
    expect(effectiveCommand(shell, "")).toBe("");
  });
});

describe("arranque y reanudación", () => {
  it("fija el id de la conversación al abrir", () => {
    expect(startCommandFor(claude, UUID)).toBe(
      `claude --session-id ${UUID} --dangerously-skip-permissions`,
    );
  });

  it("retoma esa misma conversación al restaurar", () => {
    expect(resumeCommandFor("claude", "", UUID)).toBe(
      `claude --resume ${UUID} --dangerously-skip-permissions`,
    );
  });

  it("arranca limpio si no hay conversación que retomar", () => {
    expect(resumeCommandFor("claude", "", null)).toBe(claude.command);
  });

  it("respeta un comando propio y no le añade banderas", () => {
    expect(resumeCommandFor("claude", "claude --model opus", UUID)).toBe("claude --model opus");
  });

  it("usa la reanudación genérica de los agentes que no fijan id", () => {
    expect(resumeCommandFor("gemini", "", null)).toBe(gemini.resumeCommand);
    expect(startCommandFor(gemini, UUID)).toBe(gemini.command);
  });

  it("no inventa reanudación para los agentes que no la ofrecen", () => {
    expect(resumeCommandFor("codex", "", null)).toBe("codex");
  });
});
