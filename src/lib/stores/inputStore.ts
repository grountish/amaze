import { writable } from "svelte/store";
import type { GameInput } from "$lib/game/types";

export const input = writable<GameInput>({ x: 0, y: 0 });
