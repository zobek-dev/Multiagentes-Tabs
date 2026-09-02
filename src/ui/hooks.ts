import { useEffect, useReducer } from "preact/hooks";
import type { AppState } from "../state";

/** Vuelve a dibujar el componente cada vez que el estado avisa de un cambio. */
export function useAppState(state: AppState): AppState {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => state.subscribe(() => force(undefined)), [state]);
  return state;
}
