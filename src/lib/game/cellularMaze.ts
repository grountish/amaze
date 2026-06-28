import type { Maze, Wall, Vector2 } from './types';

export const GRID_COLS = 60;
export const GRID_ROWS = 45;
export const CELL_SIZE = 20; // world = 1200×900 (¾ of the 80×60 trial)
export const EVOLUTION_INTERVAL = 1500; // ms between evolution ticks

// ── Reaction–diffusion (Gray-Scott) — Turing patterns ──────────────
// Two virtual chemicals U (substrate) and V (activator) diffuse and react.
// In the "coral/labyrinth" regime V self-organises into branching ridges — a
// Turing pattern. The maze evolution then grows walls along V ridges and carves
// corridors where V thins out, so the maze drifts toward organic labyrinths.
// Player traffic locally consumes V, so corridors open where people actually go
// (reaction-diffusion coupled to stigmergy). Runs host-side inside evolveGrid;
// the resulting walls are broadcast, so every client sees the same pattern.
const RD_DU = 0.16; // U diffuses fast
const RD_DV = 0.08; // V diffuses slow → stable stripes, not blobs
const RD_FEED = 0.0545; // feed rate  (coral/labyrinth preset)
const RD_KILL = 0.062; // kill rate
const RD_STEPS = 6; // reaction substeps per evolution tick (gentler drift)
const RD_RIDGE = 0.25; // V above this = Turing ridge → wall may grow
const RD_GAP = 0.06; // V below this = clear gap → wall may erode
const RD_GROW_CHANCE = 0.5; // only some ridge cells grow per tick → calmer
// The reaction starts as a seed in the CENTRE and spreads outward. A cell only
// follows the Turing field once the reaction front has reached it — detected by
// the substrate U being drawn down below this level. Untouched maze far from the
// seed is left alone, so the labyrinth grows from the middle instead of erupting
// everywhere at once (which was impossible to play).
const RD_ACTIVE_U = 0.8;
const RD_SEED_RADIUS = 4; // cells — size of the initial central V blob

export type CellGrid = {
  walls: Uint8Array;       // 1=wall 0=open
  pheromone: Float32Array; // 0-1, local only
  hardness: Uint8Array;    // ticks needed to erode (255=indestructible)
  evolved: Int8Array;      // +1=just opened, -1=just closed, 0=stable
  armored: Uint8Array;     // 1=armored wall: shot→permanent red, immune to evolution
  terrain: Uint8Array;     // biome overlay on OPEN cells (see TERRAIN); 0=plain floor
  u: Float32Array;         // Gray-Scott substrate (0-1, local only)
  v: Float32Array;         // Gray-Scott activator — high V = Turing ridge
};

// Biome terrain painted onto open floor cells. Walls always win over terrain.
export const TERRAIN = { NONE: 0, SAND: 1, WATER: 2, FOREST: 3 } as const;

export type Theme = {
  name: string;
  bg: string;            // maze-layer background
  wall: string;         // stable wall
  wallOpen: string;     // just-opened (evolved +1)
  wallClosed: string;   // just-closed (evolved -1)
  terrains: number[];   // which TERRAIN ids appear (weighted by repetition)
};

// One theme per maze, chosen deterministically from the seed. Only themes whose
// terrains are implemented (sand/water/forest) ship in v1. "Wastes" is the
// classic look with no terrain — keeps some mazes plain.
export const THEMES: Theme[] = [
  { name: "Tundra", bg: "#0a0f18", wall: "#3a4a66", wallOpen: "#4a7ab0", wallClosed: "#6a8aaa", terrains: [TERRAIN.WATER, TERRAIN.FOREST, TERRAIN.SAND] },
  { name: "Desert", bg: "#181206", wall: "#7a5a2e", wallOpen: "#b07a3a", wallClosed: "#8a3b1e", terrains: [TERRAIN.SAND, TERRAIN.SAND, TERRAIN.SAND, TERRAIN.WATER] },
  { name: "Swamp",  bg: "#0a140e", wall: "#2e4a36", wallOpen: "#3a6a4a", wallClosed: "#5a6a22", terrains: [TERRAIN.WATER, TERRAIN.WATER, TERRAIN.FOREST] },
  { name: "Forest", bg: "#08130a", wall: "#2c4a2c", wallOpen: "#3f7a3f", wallClosed: "#6a5a22", terrains: [TERRAIN.FOREST, TERRAIN.FOREST, TERRAIN.WATER] },
];

export function pickTheme(seed: number): Theme {
  let h = (seed * 2654435761) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return THEMES[h % THEMES.length];
}

export type NutrientData = {
  col: number;
  row: number;
  value: number;   // 1-3, controls boost magnitude
  expiresAt: number;
  kind?: "bomb" | "raft"; // undefined=speed (orange); bomb=+3 mines (purple); raft=+2 (cyan)
};

export function createCellGrid(): CellGrid {
  const n = GRID_COLS * GRID_ROWS;
  const u = new Float32Array(n);
  u.fill(1); // substrate starts full
  return {
    walls: new Uint8Array(n),
    pheromone: new Float32Array(n),
    hardness: new Uint8Array(n),
    evolved: new Int8Array(n),
    armored: new Uint8Array(n),
    terrain: new Uint8Array(n),
    u,
    v: new Float32Array(n),
  };
}

// Paint biome terrain blobs onto OPEN cells, deterministically from the seed so
// every client agrees (collision/drown must match). Circular blobs centred on
// hashed cells; bases (start/hole) are kept plain so you never spawn in water.
// Must run AFTER initGridFromMaze. Cheap: O(cells × blobs), once per maze.
export function paintTerrain(grid: CellGrid, seed: number, theme: Theme, maze: Maze): void {
  grid.terrain.fill(0);
  if (theme.terrains.length === 0) return;

  // Seeded xorshift (no Math.random → identical on every client).
  let h = (seed * 374761393 + 1) >>> 0;
  const rnd = () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };

  const BLOBS = 14;
  const blobs: { c: number; r: number; rad: number; t: number }[] = [];
  for (let k = 0; k < BLOBS; k++) {
    const t = theme.terrains[Math.floor(rnd() * theme.terrains.length)];
    blobs.push({
      c: 2 + Math.floor(rnd() * (GRID_COLS - 4)),
      r: 2 + Math.floor(rnd() * (GRID_ROWS - 4)),
      rad: 4 + rnd() * 6,
      t,
    });
  }

  for (let r = 1; r < GRID_ROWS - 1; r++) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      const i = cellIdx(c, r);
      if (grid.walls[i]) continue; // terrain only on floor
      for (const b of blobs) {
        const dc = c - b.c, dr = r - b.r;
        if (dc * dc + dr * dr <= b.rad * b.rad) { grid.terrain[i] = b.t; break; }
      }
    }
  }

  // Keep a safe plain ring around both bases so nobody spawns into a hazard.
  clearTerrainAround(grid, maze.startPosition.x, maze.startPosition.y, 3);
  clearTerrainAround(grid, maze.hole.x, maze.hole.y, 2);
}

function clearTerrainAround(grid: CellGrid, x: number, y: number, rad: number): void {
  const cc = Math.floor(x / CELL_SIZE), cr = Math.floor(y / CELL_SIZE);
  for (let r = cr - rad; r <= cr + rad; r++) {
    for (let c = cc - rad; c <= cc + rad; c++) {
      if (c < 0 || r < 0 || c >= GRID_COLS || r >= GRID_ROWS) continue;
      grid.terrain[cellIdx(c, r)] = 0;
    }
  }
}

// Deterministically flag a fraction of interior wall cells as "armored". They
// look like normal walls until shot, then turn red and become permanent. Seeded
// by the maze seed + cell index (no Math.random) so every client agrees and the
// set varies per maze. Must run AFTER initGridFromMaze (needs final walls).
export function markArmoredWalls(grid: CellGrid, seed: number, fraction = 0.2): void {
  grid.armored.fill(0);
  const picks: { i: number; h: number }[] = [];
  for (let r = 1; r < GRID_ROWS - 1; r++) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      const i = cellIdx(c, r);
      if (!grid.walls[i] || grid.hardness[i] === 255) continue; // real interior walls only
      let h = (seed ^ (i * 2654435761)) >>> 0; // hash → deterministic scatter
      h = (h ^ (h >>> 15)) >>> 0;
      picks.push({ i, h });
    }
  }
  picks.sort((a, b) => b.h - a.h);
  const count = Math.round(picks.length * fraction); // ~1/5 of real interior walls
  for (let k = 0; k < Math.min(count, picks.length); k++) grid.armored[picks[k].i] = 1;
}

export function cellIdx(col: number, row: number): number {
  return row * GRID_COLS + col;
}

export function posToCell(x: number, y: number): { col: number; row: number } {
  return {
    col: Math.max(0, Math.min(GRID_COLS - 1, Math.floor(x / CELL_SIZE))),
    row: Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(y / CELL_SIZE))),
  };
}

export function initGridFromMaze(grid: CellGrid, maze: Maze): void {
  grid.walls.fill(0);
  grid.hardness.fill(0);

  // Indestructible borders
  for (let c = 0; c < GRID_COLS; c++) {
    grid.walls[cellIdx(c, 0)] = 1;
    grid.walls[cellIdx(c, GRID_ROWS - 1)] = 1;
    grid.hardness[cellIdx(c, 0)] = 255;
    grid.hardness[cellIdx(c, GRID_ROWS - 1)] = 255;
  }
  for (let r = 0; r < GRID_ROWS; r++) {
    grid.walls[cellIdx(0, r)] = 1;
    grid.walls[cellIdx(GRID_COLS - 1, r)] = 1;
    grid.hardness[cellIdx(0, r)] = 255;
    grid.hardness[cellIdx(GRID_COLS - 1, r)] = 255;
  }

  // Paint maze walls into grid cells (skip border cells — they keep hardness 255)
  for (const wall of maze.walls) {
    const c0 = Math.floor(wall.x / CELL_SIZE);
    const r0 = Math.floor(wall.y / CELL_SIZE);
    const c1 = Math.ceil((wall.x + wall.width) / CELL_SIZE);
    const r1 = Math.ceil((wall.y + wall.height) / CELL_SIZE);
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        if (c < 0 || c >= GRID_COLS || r < 0 || r >= GRID_ROWS) continue;
        const i = cellIdx(c, r);
        if (grid.hardness[i] === 255) continue; // border cells: never touch
        grid.walls[i] = 1;
        grid.hardness[i] = 2; // tougher — needs sustained traffic to erode open
      }
    }
  }

  // Clear start + hole zones — always passable
  clearZone(grid, maze.startPosition, 30);
  clearZone(grid, { x: maze.hole.x, y: maze.hole.y }, maze.hole.radius + 10);

  // Seed the Turing field as a single blob in the CENTRE of the maze. U is the
  // full substrate everywhere; V exists only at the centre. Gray-Scott then
  // grows the labyrinth outward from there, so the pattern starts contained and
  // spreads — rather than filling the whole maze instantly (unplayable).
  grid.u.fill(1);
  grid.v.fill(0);
  const ccx = Math.floor(GRID_COLS / 2);
  const ccy = Math.floor(GRID_ROWS / 2);
  for (let dr = -RD_SEED_RADIUS; dr <= RD_SEED_RADIUS; dr++) {
    for (let dc = -RD_SEED_RADIUS; dc <= RD_SEED_RADIUS; dc++) {
      if (dc * dc + dr * dr > RD_SEED_RADIUS * RD_SEED_RADIUS) continue;
      const c = ccx + dc, r = ccy + dr;
      if (c < 1 || c >= GRID_COLS - 1 || r < 1 || r >= GRID_ROWS - 1) continue;
      grid.v[cellIdx(c, r)] = 0.6 + Math.random() * 0.2;
    }
  }
}

function clearZone(grid: CellGrid, center: Vector2, radius: number): void {
  const c0 = Math.floor((center.x - radius) / CELL_SIZE);
  const r0 = Math.floor((center.y - radius) / CELL_SIZE);
  const c1 = Math.ceil((center.x + radius) / CELL_SIZE);
  const r1 = Math.ceil((center.y + radius) / CELL_SIZE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (c < 0 || c >= GRID_COLS || r < 0 || r >= GRID_ROWS) continue;
      // Never open the outer border — a start/hole near an edge would punch a
      // gap and let the ball escape off-screen.
      if (c === 0 || c === GRID_COLS - 1 || r === 0 || r === GRID_ROWS - 1) continue;
      grid.walls[cellIdx(c, r)] = 0;
      grid.hardness[cellIdx(c, r)] = 0;
    }
  }
}

// Mark a zone as indestructible (used for shortcut zone)
export function protectZone(
  grid: CellGrid,
  zone: { x: number; y: number; width: number; height: number },
): void {
  const c0 = Math.floor(zone.x / CELL_SIZE);
  const r0 = Math.floor(zone.y / CELL_SIZE);
  const c1 = Math.ceil((zone.x + zone.width) / CELL_SIZE);
  const r1 = Math.ceil((zone.y + zone.height) / CELL_SIZE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (c < 0 || c >= GRID_COLS || r < 0 || r >= GRID_ROWS) continue;
      grid.hardness[cellIdx(c, r)] = 255;
    }
  }
}

export function depositPheromone(
  grid: CellGrid,
  x: number,
  y: number,
  amount = 0.2,
): void {
  const { col, row } = posToCell(x, y);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const c = col + dc, r = row + dr;
      if (c < 0 || c >= GRID_COLS || r < 0 || r >= GRID_ROWS) continue;
      const w = dc === 0 && dr === 0 ? 1.0 : 0.4;
      const i = cellIdx(c, r);
      grid.pheromone[i] = Math.min(1, grid.pheromone[i] + amount * w);
    }
  }
}

export function decayPheromone(grid: CellGrid, dt: number): void {
  // Half-life ~11s — trails linger long enough to accumulate past the
  // erosion threshold, so corridors actually wear open as players travel.
  const factor = Math.pow(0.94, dt);
  for (let i = 0; i < grid.pheromone.length; i++) {
    grid.pheromone[i] *= factor;
  }
}

function isProtected(c: number, r: number, maze: Maze): boolean {
  // Start zone
  const sc = Math.floor(maze.startPosition.x / CELL_SIZE);
  const sr = Math.floor(maze.startPosition.y / CELL_SIZE);
  if (Math.abs(c - sc) <= 2 && Math.abs(r - sr) <= 2) return true;
  // Hole zone
  const hc = Math.floor(maze.hole.x / CELL_SIZE);
  const hr = Math.floor(maze.hole.y / CELL_SIZE);
  if (Math.abs(c - hc) <= 2 && Math.abs(r - hr) <= 2) return true;
  return false;
}

function countOpenNeighbors(walls: Uint8Array, c: number, r: number): number {
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;
      if (!walls[cellIdx(nc, nr)]) n++;
    }
  }
  return n;
}

// Returns true if the cell is reachable from start (simple flood fill)
function isReachableFromStart(walls: Uint8Array, maze: Maze): boolean {
  const sc = Math.floor(maze.startPosition.x / CELL_SIZE);
  const sr = Math.floor(maze.startPosition.y / CELL_SIZE);
  const hc = Math.floor(maze.hole.x / CELL_SIZE);
  const hr = Math.floor(maze.hole.y / CELL_SIZE);

  const visited = new Uint8Array(GRID_COLS * GRID_ROWS);
  const queue: [number, number][] = [[sc, sr]];
  visited[cellIdx(sc, sr)] = 1;

  while (queue.length) {
    const [c, r] = queue.shift()!;
    if (c === hc && r === hr) return true;
    for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;
      const i = cellIdx(nc, nr);
      if (!visited[i] && !walls[i]) {
        visited[i] = 1;
        queue.push([nc, nr]);
      }
    }
  }
  return false;
}

// 9-point discrete Laplacian (Gray-Scott standard kernel). Caller guarantees
// (c,r) is interior, so all eight neighbours exist.
function laplacian(f: Float32Array, c: number, r: number): number {
  const i = r * GRID_COLS + c;
  return (
    f[i] * -1 +
    (f[i - 1] + f[i + 1] + f[i - GRID_COLS] + f[i + GRID_COLS]) * 0.2 +
    (f[i - GRID_COLS - 1] + f[i - GRID_COLS + 1] + f[i + GRID_COLS - 1] + f[i + GRID_COLS + 1]) * 0.05
  );
}

// Advance the Gray-Scott reaction–diffusion field a few substeps. V grows into
// Turing ridges; player pheromone consumes V so trafficked cells thin toward
// gaps. Borders are left untouched (they stay solid wall regardless).
// Persistent scratch buffers so reactionDiffuse doesn't allocate two
// Float32Array(GRID_COLS*GRID_ROWS) on every call (4× bigger since the maze
// doubled — that was a GC spike every evolution tick).
let _rdU2: Float32Array | null = null;
let _rdV2: Float32Array | null = null;

export function reactionDiffuse(grid: CellGrid): void {
  const { u, v, pheromone } = grid;
  const n = GRID_COLS * GRID_ROWS;
  if (!_rdU2 || _rdU2.length !== n) {
    _rdU2 = new Float32Array(n);
    _rdV2 = new Float32Array(n);
  }
  const u2 = _rdU2!, v2 = _rdV2!;
  u2.set(u); // seed borders + current state (interior gets overwritten below)
  v2.set(v);
  for (let s = 0; s < RD_STEPS; s++) {
    for (let r = 1; r < GRID_ROWS - 1; r++) {
      for (let c = 1; c < GRID_COLS - 1; c++) {
        const i = cellIdx(c, r);
        const uvv = u[i] * v[i] * v[i];
        let nu = u[i] + (RD_DU * laplacian(u, c, r) - uvv + RD_FEED * (1 - u[i]));
        // Traffic eats the activator → ridges dissolve into corridors where
        // players travel (reaction-diffusion meets stigmergy).
        let nv = v[i] + (RD_DV * laplacian(v, c, r) + uvv - (RD_FEED + RD_KILL) * v[i]) - pheromone[i] * 0.05;
        u2[i] = nu < 0 ? 0 : nu > 1 ? 1 : nu;
        v2[i] = nv < 0 ? 0 : nv > 1 ? 1 : nv;
      }
    }
    u.set(u2);
    v.set(v2);
  }
}

export function evolveGrid(grid: CellGrid, maze: Maze): void {
  reactionDiffuse(grid); // advance the Turing field first (host-only: only the
  // host calls evolveGrid, and the field is no longer rendered, so no need to
  // run it on every client anymore).
  const newWalls = new Uint8Array(grid.walls);
  grid.evolved.fill(0);

  for (let r = 1; r < GRID_ROWS - 1; r++) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      const i = cellIdx(c, r);
      const hard = grid.hardness[i];

      // Indestructible cells never change
      if (hard === 255) continue;
      if (grid.armored[i]) continue; // armored walls are immune to evolution
      if (isProtected(c, r, maze)) { newWalls[i] = 0; grid.hardness[i] = 0; continue; }

      const ph = grid.pheromone[i];
      const vv = grid.v[i];
      // "Active" = the reaction front has reached this cell (substrate drawn
      // down). Only inside this expanding central region does the Turing field
      // reshape the maze; everywhere else the original maze is left intact.
      const active = grid.u[i] < RD_ACTIVE_U;
      const isWall = grid.walls[i] === 1;

      if (isWall) {
        // Erosion: walls wear open under heavy traffic anywhere, OR in a Turing
        // gap but only inside the active region. Hardness still gates so the
        // maze doesn't dissolve instantly.
        if (ph > 0.22 || (active && vv < RD_GAP)) {
          if (hard > 0) {
            grid.hardness[i] = hard - 1;
          } else {
            newWalls[i] = 0;
            grid.evolved[i] = 1;
          }
        }
      } else {
        // Inside the active region, walls regrow along Turing ridges (V crests),
        // branching into labyrinth stripes. Outside it, keep a gentle
        // pheromone-only overgrowth so abandoned space still slowly closes. The
        // start→hole reachability check below reverts any path-blocking regrowth.
        if (active && vv > RD_RIDGE && ph < 0.12 && Math.random() < RD_GROW_CHANCE) {
          newWalls[i] = 1;
          grid.hardness[i] = 1;
          grid.evolved[i] = -1;
        } else if (!active && ph < 0.06) {
          const openN = countOpenNeighbors(grid.walls, c, r);
          if (openN >= 5 && Math.random() < 0.12) {
            newWalls[i] = 1;
            grid.hardness[i] = 1;
            grid.evolved[i] = -1;
          }
        }
      }
    }
  }

  // Safety: if evolution blocked start→hole path, revert the last-closed cells
  if (!isReachableFromStart(newWalls, maze)) {
    for (let i = 0; i < grid.evolved.length; i++) {
      if (grid.evolved[i] === -1) newWalls[i] = 0;
    }
    grid.evolved.fill(0);
  }

  grid.walls = newWalls;
}

export function serializeWalls(walls: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(walls.length / 8));
  for (let i = 0; i < walls.length; i++) {
    if (walls[i]) bytes[Math.floor(i / 8)] |= 1 << (i % 8);
  }
  return btoa(String.fromCharCode(...bytes));
}

export function deserializeWalls(b64: string): Uint8Array {
  const chars = atob(b64);
  const walls = new Uint8Array(GRID_COLS * GRID_ROWS);
  for (let i = 0; i < walls.length; i++) {
    walls[i] = (chars.charCodeAt(Math.floor(i / 8)) >> (i % 8)) & 1;
  }
  return walls;
}

// Returns wall rects near the ball for collision (O(49) instead of O(1200))
export function getLocalWalls(grid: CellGrid, ballX: number, ballY: number): Wall[] {
  const col = Math.floor(ballX / CELL_SIZE);
  const row = Math.floor(ballY / CELL_SIZE);
  const walls: Wall[] = [];
  for (let dr = -3; dr <= 3; dr++) {
    for (let dc = -3; dc <= 3; dc++) {
      const c = col + dc, r = row + dr;
      if (c < 0 || c >= GRID_COLS || r < 0 || r >= GRID_ROWS) continue;
      if (grid.walls[cellIdx(c, r)]) {
        walls.push({
          x: c * CELL_SIZE,
          y: r * CELL_SIZE,
          width: CELL_SIZE,
          height: CELL_SIZE,
        });
      }
    }
  }
  return walls;
}

// Pick a cell suitable for a trap: high pheromone, open, not protected, not too close to others
// Min cells between a new trap and any live player. A trap must never spawn
// on top of (or right next to) a racer — that's an unfair, invisible death.
// It has to appear far enough away to be seen and avoided.
const TRAP_PLAYER_CLEARANCE = 5;

export function pickTrapCell(
  grid: CellGrid,
  maze: Maze,
  avoidCells: { col: number; row: number }[],
  playerCells: { col: number; row: number }[] = [],
): { col: number; row: number } | null {
  const sc = Math.floor(maze.startPosition.x / CELL_SIZE);
  const sr = Math.floor(maze.startPosition.y / CELL_SIZE);
  const hc = Math.floor(maze.hole.x / CELL_SIZE);
  const hr = Math.floor(maze.hole.y / CELL_SIZE);

  type Candidate = { col: number; row: number; ph: number };
  const candidates: Candidate[] = [];

  for (let r = 2; r < GRID_ROWS - 2; r++) {
    for (let c = 2; c < GRID_COLS - 2; c++) {
      const i = cellIdx(c, r);
      if (grid.walls[i]) continue;
      // Keep clear of start and hole
      if (Math.abs(c - sc) <= 3 && Math.abs(r - sr) <= 3) continue;
      if (Math.abs(c - hc) <= 3 && Math.abs(r - hr) <= 3) continue;
      // Keep well clear of any live player — no spawning under someone.
      const nearPlayer = playerCells.some(
        (p) =>
          Math.abs(p.col - c) <= TRAP_PLAYER_CLEARANCE &&
          Math.abs(p.row - r) <= TRAP_PLAYER_CLEARANCE,
      );
      if (nearPlayer) continue;
      const ph = grid.pheromone[i];
      if (ph < 0.1) continue;
      candidates.push({ col: c, row: r, ph });
    }
  }

  candidates.sort((a, b) => b.ph - a.ph);

  for (const cand of candidates) {
    const tooClose = avoidCells.some(
      (a) => Math.abs(a.col - cand.col) < 3 && Math.abs(a.row - cand.row) < 3,
    );
    if (!tooClose) return { col: cand.col, row: cand.row };
  }

  return null;
}

// Find open cells with highest pheromone — where nutrients should spawn
export function findNutrientPositions(grid: CellGrid, count: number): NutrientData[] {
  type Candidate = { col: number; row: number; ph: number };
  const candidates: Candidate[] = [];

  for (let r = 2; r < GRID_ROWS - 2; r++) {
    for (let c = 2; c < GRID_COLS - 2; c++) {
      const i = cellIdx(c, r);
      if (grid.walls[i]) continue;
      const ph = grid.pheromone[i];
      if (ph > 0.25) candidates.push({ col: c, row: r, ph });
    }
  }

  candidates.sort((a, b) => b.ph - a.ph);

  // Spread nutrients out — skip candidates too close to already chosen ones
  const chosen: NutrientData[] = [];
  for (const cand of candidates) {
    if (chosen.length >= count) break;
    const tooClose = chosen.some(
      (n) => Math.abs(n.col - cand.col) < 4 && Math.abs(n.row - cand.row) < 4,
    );
    if (!tooClose) {
      chosen.push({
        col: cand.col,
        row: cand.row,
        value: Math.min(3, Math.ceil(cand.ph * 3)),
        expiresAt: 0, // set by caller
      });
    }
  }

  return chosen;
}
