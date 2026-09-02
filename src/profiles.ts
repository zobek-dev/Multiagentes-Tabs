import { invoke } from "@tauri-apps/api/core";

export interface Profile {
  id: string;
  label: string;
  /** Binario que se busca en el PATH para saber si el agente está instalado. */
  binary: string | null;
  /** Comando que se escribe en el shell al abrir la sesión. */
  command: string;
  /**
   * Comando de arranque cuando el agente permite fijar el id de la
   * conversación. `{id}` se sustituye por un UUID que genera la aplicación.
   */
  startTemplate?: string;
  /** Comando para retomar exactamente esa conversación por su id. */
  resumeTemplate?: string;
  /**
   * Reanudación sin id: retoma la última conversación de la carpeta. Es lo
   * único que ofrecen los agentes que no dejan fijar el id de antemano.
   */
  resumeCommand?: string;
  hint: string;
  /** Monograma de la pestaña: una o dos letras, no un logotipo ajeno. */
  mark: string;
  /** Color del monograma, para reconocer el agente de un vistazo. */
  color: string;
}

export const PROFILES: Profile[] = [
  {
    id: "claude",
    label: "Claude Code",
    binary: "claude",
    command: "claude --dangerously-skip-permissions",
    startTemplate: "claude --session-id {id} --dangerously-skip-permissions",
    resumeTemplate: "claude --resume {id} --dangerously-skip-permissions",
    hint: "claude",
    mark: "C",
    color: "#d97757",
  },
  {
    id: "codex",
    label: "Codex",
    binary: "codex",
    command: "codex",
    hint: "codex",
    mark: "X",
    color: "#8b93a7",
  },
  {
    id: "gemini",
    label: "Gemini",
    binary: "gemini",
    command: "gemini",
    resumeCommand: "gemini --resume latest",
    hint: "gemini",
    mark: "G",
    color: "#5b8dd9",
  },
  {
    id: "aider",
    label: "Aider",
    binary: "aider",
    command: "aider",
    hint: "aider",
    mark: "A",
    color: "#4ec9a0",
  },
  {
    id: "opencode",
    label: "opencode",
    binary: "opencode",
    command: "opencode",
    resumeTemplate: "opencode --session {id}",
    resumeCommand: "opencode --continue",
    hint: "opencode",
    mark: "O",
    color: "#b18cd9",
  },
  {
    id: "shell",
    label: "Shell",
    binary: null,
    command: "",
    hint: "sin comando",
    mark: "$",
    color: "#7a8492",
  },
];

export function profileById(id: string): Profile | undefined {
  return PROFILES.find((profile) => profile.id === id);
}

/** True si el agente admite que la aplicación fije el id de la conversación. */
export function tracksConversation(profile: Profile): boolean {
  return Boolean(profile.startTemplate && profile.resumeTemplate);
}

export function newConversationId(): string {
  return crypto.randomUUID();
}

/** Comando para abrir una conversación nueva con un id ya reservado. */
export function startCommandFor(profile: Profile, conversationId: string | null): string {
  if (profile.startTemplate && conversationId) {
    return profile.startTemplate.replace("{id}", conversationId);
  }
  return profile.command;
}

/**
 * ¿El usuario escribió su propio comando para esta sesión?
 *
 * Lo guardado se compara con el perfil en vez de almacenarse como una bandera
 * aparte, y el binario suelto cuenta como «no personalizado»: así una sesión
 * guardada por una versión anterior adopta los cambios que se hagan luego al
 * comando del perfil, en lugar de quedarse congelada en el texto antiguo.
 */
export function isCustomCommand(profile: Profile, savedCommand: string): boolean {
  const command = savedCommand.trim();
  if (!command) return false;
  if (command === profile.command) return false;
  return command !== profile.binary;
}

/**
 * Comando efectivo de una sesión. Sin comando propio manda el del perfil: si
 * elegiste «Claude Code», la pestaña abre Claude Code. Para una terminal sin
 * agente está el perfil «Shell».
 */
export function effectiveCommand(profile: Profile, savedCommand: string): string {
  return isCustomCommand(profile, savedCommand) ? savedCommand.trim() : profile.command;
}

/** Lo que hay que persistir: cadena vacía si no es un comando propio. */
export function commandToStore(profile: Profile, typed: string): string {
  return isCustomCommand(profile, typed) ? typed.trim() : "";
}

/**
 * Comando con el que arrancar una sesión restaurada. Prioridad: un comando
 * escrito a mano por el usuario, luego el id exacto de la conversación y, si
 * el agente no lo soporta, su reanudación genérica.
 */
export function resumeCommandFor(
  profileId: string,
  savedCommand: string,
  conversationId: string | null,
): string {
  const profile = profileById(profileId);
  if (!profile) return savedCommand;
  if (isCustomCommand(profile, savedCommand)) return savedCommand.trim();
  if (profile.resumeTemplate && conversationId) {
    return profile.resumeTemplate.replace("{id}", conversationId);
  }
  return profile.resumeCommand ?? profile.command;
}

/** True si el agente sabe retomar una conversación concreta por su id. */
export function resumesById(profile: Profile): boolean {
  return Boolean(profile.resumeTemplate);
}

/**
 * Conversaciones que ese agente tiene registradas en esa carpeta, de la más
 * reciente a la más antigua. Permite reanudar también las que se lanzaron a
 * mano desde la terminal, que la aplicación nunca llegó a anotar.
 */
export async function conversationsFor(profileId: string, cwd: string): Promise<string[]> {
  const profile = profileById(profileId);
  if (!profile || !resumesById(profile) || !cwd) return [];
  try {
    return await invoke<string[]>("conversations_for", { profileId, cwd });
  } catch {
    return [];
  }
}

/** Perfiles cuyo binario existe realmente en este equipo. */
export async function detectAvailable(): Promise<Set<string>> {
  const found = new Set<string>();
  await Promise.all(
    PROFILES.map(async (profile) => {
      if (!profile.binary) {
        found.add(profile.id);
        return;
      }
      const path = await invoke<string | null>("which", { program: profile.binary });
      if (path) found.add(profile.id);
    }),
  );
  return found;
}
