import { describe, expect, it } from "vitest";
import { assignConversations, groupKey, type SessionRef } from "./assign";

const ref = (id: string, conversationId: string | null = null, cwd = "/proyecto"): SessionRef => ({
  id,
  profileId: "claude",
  cwd,
  conversationId,
});

const grupo = (cwd = "/proyecto"): string => groupKey(ref("x", null, cwd));

describe("reparto de conversaciones", () => {
  it("conserva la conversación anotada si sigue existiendo", () => {
    const asignadas = assignConversations(
      [ref("a", "conv-1")],
      new Map([[grupo(), ["conv-9", "conv-1"]]]),
    );
    expect(asignadas.get("a")).toBe("conv-1");
  });

  it("adopta la más reciente cuando la pestaña no tiene ninguna", () => {
    const asignadas = assignConversations(
      [ref("a")],
      new Map([[grupo(), ["conv-nueva", "conv-vieja"]]]),
    );
    expect(asignadas.get("a")).toBe("conv-nueva");
  });

  it("no da la misma conversación a dos pestañas de la misma carpeta", () => {
    const asignadas = assignConversations(
      [ref("a"), ref("b")],
      new Map([[grupo(), ["conv-1", "conv-2"]]]),
    );
    expect(asignadas.get("a")).toBe("conv-1");
    expect(asignadas.get("b")).toBe("conv-2");
  });

  it("respeta lo anotado y reparte el resto entre las demás", () => {
    const asignadas = assignConversations(
      [ref("a"), ref("b", "conv-1")],
      new Map([[grupo(), ["conv-1", "conv-2"]]]),
    );
    expect(asignadas.get("b")).toBe("conv-1");
    expect(asignadas.get("a")).toBe("conv-2");
  });

  it("deja sin conversación a las pestañas que sobran", () => {
    const asignadas = assignConversations([ref("a"), ref("b")], new Map([[grupo(), ["conv-1"]]]));
    expect(asignadas.get("a")).toBe("conv-1");
    expect(asignadas.get("b")).toBeNull();
  });

  it("conserva un id reservado aunque aún no tenga transcripción", () => {
    // Claude Code reserva el id al abrir, pero no escribe el archivo hasta
    // que hay un primer mensaje.
    const asignadas = assignConversations([ref("a", "reservada")], new Map([[grupo(), []]]));
    expect(asignadas.get("a")).toBe("reservada");
  });

  it("no mezcla carpetas distintas", () => {
    const asignadas = assignConversations(
      [ref("a", null, "/uno"), ref("b", null, "/dos")],
      new Map([
        [grupo("/uno"), ["conv-uno"]],
        [grupo("/dos"), ["conv-dos"]],
      ]),
    );
    expect(asignadas.get("a")).toBe("conv-uno");
    expect(asignadas.get("b")).toBe("conv-dos");
  });
});
