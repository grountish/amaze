import type { Maze } from "$lib/game/types";
import { generateMaze, DEFAULT_SEED } from "$lib/game/mazeGen";

// Base maze is now procedurally generated (see mazeGen.ts). Kept as a named
// export so existing imports keep working; rooms seed their own maze.
export const defaultMaze: Maze = generateMaze(DEFAULT_SEED);
