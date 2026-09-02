import { useEffect, useRef } from "preact/hooks";
import { open } from "@tauri-apps/plugin-dialog";
import { PROFILES } from "../profiles";
import type { AppState } from "../state";

export function Launcher({ state }: { state: AppState }) {
  const draft = state.launcher;
  const commandRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    commandRef.current?.focus();
  }, []);

  if (!draft) return null;

  const submit = (): void => void state.submitLauncher();

  return (
    <div
      class="launcher"
      onClick={(event) => {
        if (event.target === event.currentTarget) state.closeLauncher();
      }}
    >
      <div class="launcher-card">
        <h2>Nueva sesión</h2>

        <label class="field">
          <span>Agente</span>
          <div class="profile-grid">
            {PROFILES.map((profile) => {
              const instalado = state.available.has(profile.id);
              const clases = ["profile-btn"];
              if (profile.id === draft.profile.id) clases.push("selected");
              if (!instalado) clases.push("missing");
              return (
                <button
                  key={profile.id}
                  type="button"
                  class={clases.join(" ")}
                  onClick={() => state.updateLauncher({ profile })}
                >
                  <span class="profile-head">
                    <span class="agent-badge" style={{ "--agent": profile.color }}>
                      <span class="agent-mark">{profile.mark}</span>
                    </span>
                    {profile.label}
                  </span>
                  <small>{instalado ? profile.hint : "no instalado"}</small>
                </button>
              );
            })}
          </div>
        </label>

        <label class="field">
          <span>Directorio de trabajo</span>
          <div class="cwd-row">
            <input
              type="text"
              spellcheck={false}
              placeholder="~"
              value={draft.cwd}
              onInput={(event) => state.updateLauncher({ cwd: event.currentTarget.value })}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") submit();
              }}
            />
            <button
              type="button"
              class="ghost"
              onClick={async () => {
                const elegido = await open({
                  directory: true,
                  multiple: false,
                  defaultPath: draft.cwd || undefined,
                });
                if (typeof elegido === "string") state.updateLauncher({ cwd: elegido });
              }}
            >
              Elegir…
            </button>
          </div>
        </label>

        <label class="field">
          <span>Comando inicial</span>
          <input
            ref={commandRef}
            type="text"
            spellcheck={false}
            value={draft.command}
            onInput={(event) => state.updateLauncher({ command: event.currentTarget.value })}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") submit();
            }}
          />
        </label>

        <div class="launcher-actions">
          <button type="button" class="ghost" onClick={() => state.closeLauncher()}>
            Cancelar
          </button>
          <button type="button" class="primary" onClick={submit}>
            Lanzar
          </button>
        </div>
      </div>
    </div>
  );
}
