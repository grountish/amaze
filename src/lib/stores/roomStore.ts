import { writable } from "svelte/store";
import type { Room } from "$lib/firebase/types";

export const room = writable<Room | null>(null);
