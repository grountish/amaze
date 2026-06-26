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
    // Borders
    { x: 0, y: 0, width: 800, height: 20 },
    { x: 0, y: 580, width: 800, height: 20 },
    { x: 0, y: 0, width: 20, height: 600 },
    { x: 780, y: 0, width: 20, height: 600 },

    // Barrier 1 y=460 — gap cols 13-17 (x=260-340)
    { x: 20, y: 460, width: 240, height: 20 },
    { x: 340, y: 460, width: 440, height: 20 },

    // Barrier 2 y=380 — gap cols 6-10 (x=120-200)
    { x: 20, y: 380, width: 100, height: 20 },
    { x: 200, y: 380, width: 580, height: 20 },

    // Barrier 3 y=300 — gap cols 25-29 (x=500-580)
    { x: 20, y: 300, width: 480, height: 20 },
    { x: 580, y: 300, width: 200, height: 20 },

    // Barrier 4 y=220 — gap cols 11-15 (x=220-300)
    { x: 20, y: 220, width: 200, height: 20 },
    { x: 300, y: 220, width: 480, height: 20 },

    // Barrier 5 y=140 — gap cols 23-27 (x=460-540)
    { x: 20, y: 140, width: 440, height: 20 },
    { x: 540, y: 140, width: 240, height: 20 },

    // ── Bottom band (y 460-580) ──────────────────────────────────
    { x: 120, y: 460, width: 20, height: 60 },
    { x: 140, y: 500, width: 80, height: 20 },
    { x: 400, y: 480, width: 20, height: 100 },
    { x: 500, y: 460, width: 20, height: 80 },
    { x: 600, y: 480, width: 20, height: 80 },
    { x: 700, y: 460, width: 20, height: 120 },
    { x: 420, y: 520, width: 80, height: 20 },
    { x: 620, y: 500, width: 80, height: 20 },
    { x: 540, y: 540, width: 100, height: 20 },

    // ── Band 2 (y 380-460) ───────────────────────────────────────
    { x: 280, y: 420, width: 20, height: 40 },
    { x: 360, y: 380, width: 20, height: 60 },
    { x: 440, y: 400, width: 20, height: 60 },
    { x: 560, y: 380, width: 20, height: 80 },
    { x: 680, y: 400, width: 20, height: 60 },
    { x: 740, y: 380, width: 20, height: 80 },
    { x: 380, y: 420, width: 80, height: 20 },
    { x: 480, y: 400, width: 80, height: 20 },
    { x: 640, y: 420, width: 40, height: 20 },

    // ── Band 3 (y 300-380) ───────────────────────────────────────
    { x: 40, y: 300, width: 20, height: 80 },
    { x: 80, y: 320, width: 20, height: 60 },
    { x: 200, y: 300, width: 20, height: 40 },
    { x: 620, y: 300, width: 20, height: 80 },
    { x: 700, y: 300, width: 20, height: 80 },
    { x: 40, y: 340, width: 60, height: 20 },
    { x: 640, y: 340, width: 60, height: 20 },
    { x: 720, y: 340, width: 20, height: 60 },

    // ── Band 4 (y 220-300) ───────────────────────────────────────
    { x: 40, y: 240, width: 20, height: 60 },
    { x: 80, y: 220, width: 20, height: 80 },
    { x: 160, y: 240, width: 60, height: 20 },
    { x: 380, y: 260, width: 20, height: 40 },
    { x: 560, y: 220, width: 20, height: 80 },
    { x: 640, y: 240, width: 20, height: 60 },
    { x: 720, y: 220, width: 20, height: 80 },
    { x: 580, y: 260, width: 100, height: 20 },

    // ── Band 5 (y 140-220) ───────────────────────────────────────
    { x: 40, y: 160, width: 20, height: 60 },
    { x: 80, y: 140, width: 20, height: 80 },
    { x: 180, y: 160, width: 20, height: 60 },
    { x: 300, y: 180, width: 20, height: 40 },
    { x: 560, y: 140, width: 20, height: 80 },
    { x: 640, y: 160, width: 20, height: 60 },
    { x: 700, y: 140, width: 20, height: 80 },
    { x: 40, y: 180, width: 80, height: 20 },
    { x: 580, y: 180, width: 80, height: 20 },

    // ── Top band (y 20-140) ──────────────────────────────────────
    { x: 40, y: 20, width: 20, height: 120 },
    { x: 100, y: 40, width: 20, height: 100 },
    { x: 180, y: 20, width: 20, height: 80 },
    { x: 260, y: 40, width: 20, height: 100 },
    { x: 360, y: 20, width: 20, height: 100 },
    { x: 440, y: 40, width: 20, height: 80 },
    { x: 60, y: 60, width: 60, height: 20 },
    { x: 140, y: 80, width: 120, height: 20 },
    { x: 300, y: 60, width: 60, height: 20 },
    { x: 200, y: 100, width: 80, height: 20 },
  ],
};
