import {
  cellIdx,
  posToCell,
  getLocalWalls,
  GRID_COLS,
  GRID_ROWS,
  CELL_SIZE,
} from './cellularMaze';
import type { CellGrid } from './cellularMaze';

// ── Genome ─────────────────────────────────────────────────────

export type BotGenome = {
  pathWeight: number;   // how much to follow BFS path (0-1)
  pheroWeight: number;  // how much to follow pheromone gradient (0-1)
  exploreRate: number;  // probability of random deviation (0-0.5)
  generation: number;
  deaths: number;
  bestProgress: number;
};

export function defaultGenome(): BotGenome {
  return {
    pathWeight: 0.85,
    pheroWeight: 0.1,
    exploreRate: 0.05,
    generation: 1,
    deaths: 0,
    bestProgress: 0,
  };
}

export function mutate(genome: BotGenome, deathProgress: number): BotGenome {
  const deaths = genome.deaths + 1;
  const bestProgress = Math.max(genome.bestProgress, deathProgress);
  const stuck = deathProgress < genome.bestProgress * 0.5;

  // Jitter so mutations aren't always the same direction
  const jitter = () => (Math.random() - 0.5) * 0.04;

  return {
    generation: genome.generation + 1,
    deaths,
    bestProgress,
    // If dying early/stuck: explore more, follow path less
    pathWeight: stuck
      ? Math.max(0.25, genome.pathWeight - 0.1 + jitter())
      : Math.min(0.95, genome.pathWeight + 0.04 + jitter()),
    pheroWeight: stuck
      ? Math.min(0.55, genome.pheroWeight + 0.08 + jitter())
      : Math.max(0.0, genome.pheroWeight - 0.02 + jitter()),
    exploreRate: stuck
      ? Math.min(0.4, genome.exploreRate + 0.06 + jitter())
      : Math.max(0.01, genome.exploreRate - 0.015 + jitter()),
  };
}

// ── Pathfinding ────────────────────────────────────────────────

export type GridPath = { col: number; row: number }[];

export function bfsPath(
  grid: CellGrid,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): GridPath | null {
  const { col: sc, row: sr } = posToCell(fromX, fromY);
  const { col: gc, row: gr } = posToCell(toX, toY);

  if (sc === gc && sr === gr) return [{ col: gc, row: gr }];

  const n = GRID_COLS * GRID_ROWS;
  const parent = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  const si = cellIdx(sc, sr);
  visited[si] = 1;

  // BFS queue — array-as-queue is fine for <1200 nodes
  const queue: number[] = [si];
  let head = 0;

  while (head < queue.length) {
    const curr = queue[head++];
    const c = curr % GRID_COLS;
    const r = (curr / GRID_COLS) | 0;

    if (c === gc && r === gr) {
      // Reconstruct path
      const full: GridPath = [];
      let idx = curr;
      while (idx !== -1) {
        full.unshift({ col: idx % GRID_COLS, row: (idx / GRID_COLS) | 0 });
        idx = parent[idx];
      }
      // Return every 2nd waypoint for smoother following
      return full.filter((_, i) => i % 2 === 0 || i === full.length - 1);
    }

    for (let d = 0; d < 4; d++) {
      const dc = d === 0 ? 1 : d === 1 ? -1 : 0;
      const dr = d === 2 ? 1 : d === 3 ? -1 : 0;
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;
      const ni = cellIdx(nc, nr);
      if (visited[ni] || grid.walls[ni]) continue;
      visited[ni] = 1;
      parent[ni] = curr;
      queue.push(ni);
    }
  }

  return null; // no path
}

// ── Movement input ─────────────────────────────────────────────

export function computeBotInput(
  genome: BotGenome,
  path: GridPath | null,
  waypointIdx: number,
  currentX: number,
  currentY: number,
  grid: CellGrid,
): { input: { x: number; y: number }; nextWaypointIdx: number } {
  let dx = 0, dy = 0;
  let nextWp = waypointIdx;

  // ① Path following
  if (path && path.length > 0) {
    const wi = Math.min(nextWp, path.length - 1);
    const wp = path[wi];
    const wpX = (wp.col + 0.5) * CELL_SIZE;
    const wpY = (wp.row + 0.5) * CELL_SIZE;
    const ddx = wpX - currentX;
    const ddy = wpY - currentY;
    const dist = Math.sqrt(ddx * ddx + ddy * ddy);
    if (dist < CELL_SIZE * 1.4 && wi < path.length - 1) nextWp = wi + 1;
    if (dist > 1) {
      dx += genome.pathWeight * (ddx / dist);
      dy += genome.pathWeight * (ddy / dist);
    }
  }

  // ② Pheromone gradient (find hottest open neighbor)
  if (genome.pheroWeight > 0.01) {
    const { col, row } = posToCell(currentX, currentY);
    let bestPh = 0.08; // threshold — only follow if meaningful signal
    let bdc = 0, bdr = 0;
    for (let d = 0; d < 4; d++) {
      const dc = d === 0 ? 1 : d === 1 ? -1 : 0;
      const dr = d === 2 ? 1 : d === 3 ? -1 : 0;
      const nc = col + dc, nr = row + dr;
      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;
      if (grid.walls[cellIdx(nc, nr)]) continue;
      const ph = grid.pheromone[cellIdx(nc, nr)];
      if (ph > bestPh) { bestPh = ph; bdc = dc; bdr = dr; }
    }
    if (bdc !== 0 || bdr !== 0) {
      dx += genome.pheroWeight * bdc;
      dy += genome.pheroWeight * bdr;
    }
  }

  // ③ Random exploration
  if (Math.random() < genome.exploreRate) {
    dx += (Math.random() - 0.5) * 1.4;
    dy += (Math.random() - 0.5) * 1.4;
  }

  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 0.01) { dx /= len; dy /= len; }

  return { input: { x: dx, y: dy }, nextWaypointIdx: nextWp };
}

// ── Bot physics step (mirrors engine.ts) ──────────────────────

export type BotPhysicsState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
};

export function stepBotPhysics(
  state: BotPhysicsState,
  inputX: number,
  inputY: number,
  grid: CellGrid,
  dt: number,
): BotPhysicsState {
  const sensitivity = 380;
  const friction = 0.985;
  const radius = 12;

  let vx = (state.vx + inputX * sensitivity * dt) * friction;
  let vy = (state.vy + inputY * sensitivity * dt) * friction;
  let x = state.x + vx * dt;
  let y = state.y + vy * dt;

  // Collide with local grid walls
  const walls = getLocalWalls(grid, x, y);
  for (const wall of walls) {
    const cx = Math.max(wall.x, Math.min(x, wall.x + wall.width));
    const cy = Math.max(wall.y, Math.min(y, wall.y + wall.height));
    const ddx = x - cx, ddy = y - cy;
    const dist = Math.sqrt(ddx * ddx + ddy * ddy);
    if (dist < radius && dist > 0) {
      const overlap = radius - dist;
      x += (ddx / dist) * overlap;
      y += (ddy / dist) * overlap;
      vx *= -0.3;
      vy *= -0.3;
    }
  }

  return { x, y, vx, vy };
}

// ── Stuck detection ────────────────────────────────────────────

// Returns true if the bot should be considered stuck
export function isStuck(
  currentProgress: number,
  lastProgressTime: number,
  genome: BotGenome,
  nowMs: number,
): boolean {
  const noProgressTimeout = genome.deaths < 3 ? 12000 : 8000;
  return nowMs - lastProgressTime > noProgressTimeout && currentProgress < 95;
}
