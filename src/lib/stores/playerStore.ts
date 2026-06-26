import { writable } from "svelte/store";
import type { Player } from "$lib/firebase/types";

export const players = writable<Player[]>([]);
export const currentPlayerId = writable<string | null>(null);
