import type { Maze } from "$lib/game/types";

export const defaultMaze: Maze = {
  id: "default",
  width: 800,
  height: 600,
  startPosition: { x: 60, y: 540 },
  hole: { x: 740, y: 60, radius: 24 },
  checkpoints: [],
  shortcut: {
    zone: { x: 340, y: 340, width: 120, height: 60 },
    gapWall: { x: 350, y: 360, width: 100, height: 20 },
  },
  walls: [
    { x: 0, y: 0, width: 800, height: 20 },
    { x: 0, y: 580, width: 800, height: 20 },
    { x: 0, y: 0, width: 20, height: 600 },
    { x: 780, y: 0, width: 20, height: 600 },
    { x: 120, y: 120, width: 520, height: 20 },
    { x: 160, y: 240, width: 520, height: 20 },
    { x: 120, y: 360, width: 230, height: 20 },
    { x: 450, y: 360, width: 190, height: 20 },
    { x: 160, y: 480, width: 520, height: 20 },
  ],
};
