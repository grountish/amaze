import type { Maze, Wall } from './types';
import { GRID_COLS, GRID_ROWS, CELL_SIZE } from './cellularMaze';

// ── Procedural maze generation ─────────────────────────────────
// Produces a complex but ALWAYS-solvable maze on the 40×30 / 20px grid.
//
// Technique: thick-wall perfect maze via iterative recursive-backtracker
// (randomized DFS spanning tree). A spanning tree connects every cell, so
// there is exactly one path between any two cells — start→hole is always
// reachable. Light braiding then removes some dead ends to add alternate
// routes (loops), making the maze feel like an arena rather than a single
// forced corridor, without ever disconnecting it.
//
// Output is a Maze whose `walls` are merged rectangles. initGridFromMaze()
// paints them into the cell grid and carves the start/hole zones, so the
// generated maze plugs into the existing collision / evolution pipeline
// unchanged.

// Logical maze cells live on odd grid coordinates; even coordinates are the
// walls between them. Border ring (col 0/39, row 0/29) stays solid wall.
const COLS = Math.floor((GRID_COLS - 1) / 2); // 19 logical columns
const ROWS = Math.floor((GRID_ROWS - 1) / 2); // 14 logical rows

// Fixed start (bottom-left) and hole (top-right) cells. Seed-invariant so
// every downstream reference to startPosition / hole stays stable.
const START_CELL = { i: 1, j: ROWS - 1 };
const HOLE_CELL = { i: COLS - 1, j: 0 };

export const DEFAULT_SEED = 1;

// Deterministic PRNG (mulberry32) so every client generates an identical
// maze from the same seed — the maze can be shared as just a number.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed(): number {
  return ((Math.random() * 0xffffffff) >>> 0) || 1;
}

// Deterministic next seed from the current one (LCG). Used to advance the
// maze each lap without Math.random, so a transaction retry is stable.
export function nextSeed(seed: number): number {
  return (((seed >>> 0) * 1664525 + 1013904223) >>> 0) || 1;
}

// grid coords of a logical cell
function cellGrid(i: number, j: number): { gx: number; gy: number } {
  return { gx: 2 * i + 1, gy: 2 * j + 1 };
}

function gIdx(gx: number, gy: number): number {
  return gy * GRID_COLS + gx;
}

// Build the raw open/wall grid (1=wall, 0=open) for a seed.
export function generateMazeGrid(seed: number): Uint8Array {
  const rng = mulberry32(seed);
  const n = GRID_COLS * GRID_ROWS;
  const walls = new Uint8Array(n).fill(1); // everything wall, then carve

  const visited = new Uint8Array(COLS * ROWS);
  const lIdx = (i: number, j: number) => j * COLS + i;

  // Iterative randomized DFS from the start cell.
  const stack: { i: number; j: number }[] = [{ i: START_CELL.i, j: START_CELL.j }];
  visited[lIdx(START_CELL.i, START_CELL.j)] = 1;
  {
    const { gx, gy } = cellGrid(START_CELL.i, START_CELL.j);
    walls[gIdx(gx, gy)] = 0;
  }

  const DIRS = [
    { di: 0, dj: -1 },
    { di: 0, dj: 1 },
    { di: -1, dj: 0 },
    { di: 1, dj: 0 },
  ];

  while (stack.length > 0) {
    const cur = stack[stack.length - 1];
    // Collect unvisited neighbours
    const opts: { i: number; j: number; wx: number; wy: number }[] = [];
    for (const d of DIRS) {
      const ni = cur.i + d.di;
      const nj = cur.j + d.dj;
      if (ni < 0 || ni >= COLS || nj < 0 || nj >= ROWS) continue;
      if (visited[lIdx(ni, nj)]) continue;
      const cg = cellGrid(cur.i, cur.j);
      const ng = cellGrid(ni, nj);
      opts.push({ i: ni, j: nj, wx: (cg.gx + ng.gx) / 2, wy: (cg.gy + ng.gy) / 2 });
    }
    if (opts.length === 0) {
      stack.pop();
      continue;
    }
    const pick = opts[Math.floor(rng() * opts.length)];
    // Knock down the wall between cur and pick, open the picked cell.
    walls[gIdx(pick.wx, pick.wy)] = 0;
    const pg = cellGrid(pick.i, pick.j);
    walls[gIdx(pg.gx, pg.gy)] = 0;
    visited[lIdx(pick.i, pick.j)] = 1;
    stack.push({ i: pick.i, j: pick.j });
  }

  // Braiding: remove ~18% of dead ends by opening one extra random wall,
  // creating loops / alternate routes. Never disconnects (only opens cells).
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      if (rng() > 0.18) continue;
      const { gx, gy } = cellGrid(i, j);
      // Count open orthogonal neighbours (through wall cells)
      const around = [
        { wx: gx, wy: gy - 1, ni: i, nj: j - 1 },
        { wx: gx, wy: gy + 1, ni: i, nj: j + 1 },
        { wx: gx - 1, wy: gy, ni: i - 1, nj: j },
        { wx: gx + 1, wy: gy, ni: i + 1, nj: j },
      ];
      let openCount = 0;
      const closed: typeof around = [];
      for (const a of around) {
        if (a.ni < 0 || a.ni >= COLS || a.nj < 0 || a.nj >= ROWS) continue;
        if (walls[gIdx(a.wx, a.wy)] === 0) openCount++;
        else closed.push(a);
      }
      // Dead end = exactly one opening. Open one more wall to a neighbour cell.
      if (openCount === 1 && closed.length > 0) {
        const a = closed[Math.floor(rng() * closed.length)];
        walls[gIdx(a.wx, a.wy)] = 0;
      }
    }
  }

  return walls;
}

// Merge a wall grid into horizontal run rectangles (fewer rects to store/draw).
function gridToWalls(walls: Uint8Array): Wall[] {
  const rects: Wall[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    let runStart = -1;
    for (let c = 0; c <= GRID_COLS; c++) {
      const isWall = c < GRID_COLS && walls[r * GRID_COLS + c] === 1;
      if (isWall && runStart === -1) {
        runStart = c;
      } else if (!isWall && runStart !== -1) {
        rects.push({
          x: runStart * CELL_SIZE,
          y: r * CELL_SIZE,
          width: (c - runStart) * CELL_SIZE,
          height: CELL_SIZE,
        });
        runStart = -1;
      }
    }
  }
  return rects;
}

// Full Maze object for a seed. start/hole are fixed corners (carved open by
// the generator and further cleared by initGridFromMaze's start/hole zones).
export function generateMaze(seed: number): Maze {
  const grid = generateMazeGrid(seed);
  const start = cellGrid(START_CELL.i, START_CELL.j);
  const hole = cellGrid(HOLE_CELL.i, HOLE_CELL.j);
  return {
    id: `gen-${seed >>> 0}`,
    width: GRID_COLS * CELL_SIZE,
    height: GRID_ROWS * CELL_SIZE,
    startPosition: {
      x: start.gx * CELL_SIZE + CELL_SIZE / 2,
      y: start.gy * CELL_SIZE + CELL_SIZE / 2,
    },
    hole: {
      x: hole.gx * CELL_SIZE + CELL_SIZE / 2,
      y: hole.gy * CELL_SIZE + CELL_SIZE / 2,
      radius: 24,
    },
    walls: gridToWalls(grid),
    checkpoints: [],
  };
}

// Parse a room's mazeId into a numeric seed (handles legacy "default").
export function seedFromMazeId(mazeId: string | undefined | null): number {
  if (!mazeId) return DEFAULT_SEED;
  const n = parseInt(mazeId, 10);
  return Number.isFinite(n) && n > 0 ? n >>> 0 : DEFAULT_SEED;
}
