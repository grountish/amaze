import type { Maze, Wall, Vector2 } from './types';

export const GRID_COLS = 40;
export const GRID_ROWS = 30;
export const CELL_SIZE = 20;
export const EVOLUTION_INTERVAL = 4000; // ms between evolution ticks

export type CellGrid = {
  walls: Uint8Array;       // 1=wall 0=open
  pheromone: Float32Array; // 0-1, local only
  hardness: Uint8Array;    // ticks needed to erode (255=indestructible)
  evolved: Int8Array;      // +1=just opened, -1=just closed, 0=stable
};

export type NutrientData = {
  col: number;
  row: number;
  value: number;   // 1-3, controls boost magnitude
  expiresAt: number;
};

export function createCellGrid(): CellGrid {
  const n = GRID_COLS * GRID_ROWS;
  return {
    walls: new Uint8Array(n),
    pheromone: new Float32Array(n),
    hardness: new Uint8Array(n),
    evolved: new Int8Array(n),
  };
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

  // Paint maze walls into grid cells
  for (const wall of maze.walls) {
    const c0 = Math.floor(wall.x / CELL_SIZE);
    const r0 = Math.floor(wall.y / CELL_SIZE);
    const c1 = Math.ceil((wall.x + wall.width) / CELL_SIZE);
    const r1 = Math.ceil((wall.y + wall.height) / CELL_SIZE);
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        if (c <= 0 || c >= GRID_COLS - 1 || r <= 0 || r >= GRID_ROWS - 1) continue;
        grid.walls[cellIdx(c, r)] = 1;
        grid.hardness[cellIdx(c, r)] = 2;
      }
    }
  }

  // Clear start + hole zones — always passable
  clearZone(grid, maze.startPosition, 30);
  clearZone(grid, { x: maze.hole.x, y: maze.hole.y }, maze.hole.radius + 10);
}

function clearZone(grid: CellGrid, center: Vector2, radius: number): void {
  const c0 = Math.floor((center.x - radius) / CELL_SIZE);
  const r0 = Math.floor((center.y - radius) / CELL_SIZE);
  const c1 = Math.ceil((center.x + radius) / CELL_SIZE);
  const r1 = Math.ceil((center.y + radius) / CELL_SIZE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (c < 0 || c >= GRID_COLS || r < 0 || r >= GRID_ROWS) continue;
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
  amount = 0.07,
): void {
  const { col, row } = posToCell(x, y);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const c = col + dc, r = row + dr;
      if (c < 0 || c >= GRID_COLS || r < 0 || r >= GRID_ROWS) continue;
      const w = dc === 0 && dr === 0 ? 1.0 : 0.25;
      const i = cellIdx(c, r);
      grid.pheromone[i] = Math.min(1, grid.pheromone[i] + amount * w);
    }
  }
}

export function decayPheromone(grid: CellGrid, dt: number): void {
  // Half-life ~6s
  const factor = Math.pow(0.89, dt);
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

export function evolveGrid(grid: CellGrid, maze: Maze): void {
  const newWalls = new Uint8Array(grid.walls);
  grid.evolved.fill(0);

  for (let r = 1; r < GRID_ROWS - 1; r++) {
    for (let c = 1; c < GRID_COLS - 1; c++) {
      const i = cellIdx(c, r);
      const hard = grid.hardness[i];

      // Indestructible cells never change
      if (hard === 255) continue;
      if (isProtected(c, r, maze)) { newWalls[i] = 0; grid.hardness[i] = 0; continue; }

      const ph = grid.pheromone[i];
      const isWall = grid.walls[i] === 1;

      if (isWall) {
        // Erosion: heavy traffic wears down hardness then opens the cell
        if (ph > 0.35) {
          if (hard > 0) {
            grid.hardness[i] = hard - 1;
          } else {
            newWalls[i] = 0;
            grid.evolved[i] = 1;
          }
        }
      } else {
        // Overgrowth: neglected open cells regrow as walls
        if (ph < 0.015) {
          const openN = countOpenNeighbors(grid.walls, c, r);
          // Only grow if surrounded by enough open space (avoids sealing tunnels)
          if (openN >= 5 && Math.random() < 0.1) {
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
