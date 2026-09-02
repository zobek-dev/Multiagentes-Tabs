/** Datos mínimos de una pestaña guardada para repartir conversaciones. */
export interface SessionRef {
  id: string;
  profileId: string;
  cwd: string;
  conversationId: string | null;
}

/** Las pestañas del mismo agente y la misma carpeta compiten por el mismo lote. */
export function groupKey(record: SessionRef): string {
  return `${record.profileId}\n${record.cwd}`;
}

/**
 * Decide qué conversación retoma cada pestaña, sin repetir ninguna.
 *
 * Primero se sirven las pestañas que ya traen una conversación anotada y sigue
 * existiendo; después, las que no tienen ninguna —porque el agente se lanzó a
 * mano, o porque no permite reservar el id de antemano— toman las restantes
 * por orden de recencia. Sin este reparto, dos pestañas del mismo agente sobre
 * la misma carpeta acabarían peleándose por la misma conversación.
 */
export function assignConversations(
  records: SessionRef[],
  availableByGroup: Map<string, string[]>,
): Map<string, string | null> {
  const assigned = new Map<string, string | null>();

  const groups = new Map<string, SessionRef[]>();
  for (const record of records) {
    const list = groups.get(groupKey(record));
    if (list) list.push(record);
    else groups.set(groupKey(record), [record]);
  }

  for (const [key, group] of groups) {
    const available = new Set(availableByGroup.get(key) ?? []);
    const pending: SessionRef[] = [];

    for (const record of group) {
      if (record.conversationId && available.has(record.conversationId)) {
        assigned.set(record.id, record.conversationId);
        available.delete(record.conversationId);
      } else {
        pending.push(record);
      }
    }

    const remaining = (availableByGroup.get(key) ?? []).filter((id) => available.has(id));
    for (const record of pending) {
      // Sin conversación libre la pestaña arranca limpia; si el agente permitía
      // reservar el id, se conserva el suyo aunque aún no haya transcripción
      // (una conversación abierta y cerrada sin escribir nada).
      assigned.set(record.id, remaining.shift() ?? record.conversationId ?? null);
    }
  }

  return assigned;
}
