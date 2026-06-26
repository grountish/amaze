import { writable } from "svelte/store";
import type { LocalGameState } from "$lib/game/types";

export const localGame = writable<LocalGameState | null>(null);
export const debugMode = writable<boolean>(false);
