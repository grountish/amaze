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
  // mutate() is only called on death, so the current route failed.
  // Treat low absolute progress (or a big regression from best) as
  // "explore more"; otherwise the first deaths (bestProgress 0) would
  // wrongly make the bot hug the deadly path even harder.
  const stuck = deathProgress < Math.max(40, genome.bestProgress * 0.6);

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

// ── Hazard memory (learned death map) ──────────────────────────
// Per-bot spatial memory of where it died. Pathfinding adds this as a
// routing cost so each generation steers around past deaths instead of
// re-running into the same trap/dead-end. This is the actual learning.

export function createHazard(): Float32Array {
  return new Float32Array(GRID_COLS * GRID_ROWS);
}

// ── Fog of war (per-bot discovered map) ────────────────────────
// Bots don't get the whole maze. They only "know" cells they've come near.
// Pathfinding treats unknown cells as passable, so a bot plans optimistically
// through fog, walks in, discovers the real walls, and replans — failing in
// dead ends early on. Knowledge persists across deaths within a maze, so each
// generation explores less and routes better (the actual learning curve).

export function createKnown(): Uint8Array {
  return new Uint8Array(GRID_COLS * GRID_ROWS);
}

// Reveal cells within `vision` of the bot's current cell.
export function revealAround(known: Uint8Array, x: number, y: number, vision = 2): void {
  const { col, row } = posToCell(x, y);
  for (let dr = -vision; dr <= vision; dr++) {
    for (let dc = -vision; dc <= vision; dc++) {
      const c = col + dc, r = row + dr;
      if (c < 0 || c >= GRID_COLS || r < 0 || r >= GRID_ROWS) continue;
      known[cellIdx(c, r)] = 1;
    }
  }
}

// Record a death: penalize the death cell and its neighbors. Penalty
// accumulates across attempts, so repeatedly fatal spots get avoided
// more strongly over time.
export function recordDeath(hazard: Float32Array, x: number, y: number): void {
  const { col, row } = posToCell(x, y);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const c = col + dc, r = row + dr;
      if (c < 0 || c >= GRID_COLS || r < 0 || r >= GRID_ROWS) continue;
      const center = dc === 0 && dr === 0;
      hazard[cellIdx(c, r)] += center ? 8 : 3;
    }
  }
}

// ── Pathfinding ────────────────────────────────────────────────

export type GridPath = { col: number; row: number }[];

// Uniform-cost (Dijkstra) search. Entering a cell costs 1 + its hazard
// penalty, so the planner routes around remembered death cells. With a
// null/zero hazard map this degrades to plain shortest-path BFS.
export function bfsPath(
  grid: CellGrid,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  hazard: Float32Array | null = null,
  known: Uint8Array | null = null,
): GridPath | null {
  const { col: sc, row: sr } = posToCell(fromX, fromY);
  const { col: gc, row: gr } = posToCell(toX, toY);

  if (sc === gc && sr === gr) return [{ col: gc, row: gr }];

  const n = GRID_COLS * GRID_ROWS;
  const parent = new Int32Array(n).fill(-1);
  const dist = new Float32Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const si = cellIdx(sc, sr);
  const gi = cellIdx(gc, gr);
  dist[si] = 0;

  // Linear-scan frontier — fine for <1200 nodes, replans are infrequent
  for (let iter = 0; iter < n; iter++) {
    // Pick the unfinished node with smallest dist
    let curr = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && dist[i] < best) { best = dist[i]; curr = i; }
    }
    if (curr === -1) break;
    if (curr === gi) break;
    done[curr] = 1;

    const c = curr % GRID_COLS;
    const r = (curr / GRID_COLS) | 0;
    for (let d = 0; d < 4; d++) {
      const dc = d === 0 ? 1 : d === 1 ? -1 : 0;
      const dr = d === 2 ? 1 : d === 3 ? -1 : 0;
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;
      const ni = cellIdx(nc, nr);
      if (done[ni]) continue;
      // Fog of war: unseen cells are assumed open (so the bot will explore
      // into them); only cells it has discovered block on their real wall.
      const blocked = known && !known[ni] ? false : !!grid.walls[ni];
      if (blocked) continue;
      // Nudge the planner to prefer confirmed-open cells over guessing through
      // fog, without refusing to explore when that's the only way forward.
      const fogCost = known && !known[ni] ? 0.5 : 0;
      const stepCost = 1 + fogCost + (hazard ? hazard[ni] : 0);
      const nd = dist[curr] + stepCost;
      if (nd < dist[ni]) {
        dist[ni] = nd;
        parent[ni] = curr;
      }
    }
  }

  if (dist[gi] === Infinity) return null; // no path

  // Reconstruct path
  const full: GridPath = [];
  let idx = gi;
  while (idx !== -1) {
    full.unshift({ col: idx % GRID_COLS, row: (idx / GRID_COLS) | 0 });
    idx = parent[idx];
  }
  // Return every 2nd waypoint for smoother following
  return full.filter((_, i) => i % 2 === 0 || i === full.length - 1);
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
  const radius = 9; // match ball radius (engine.ts) so bots fit same corridors

  // Substep at the human ball's ~60Hz cadence. The bot driver ticks every
  // 50ms; integrating that as ONE step let friction (applied per step) damp
  // only 20×/s instead of 60×/s, so velocity reached ~1250px/s and the bot
  // moved ~62px per step — past the 9px radius and the 20px wall cell. The
  // collision check only sees the final position, so bots tunnelled straight
  // through walls. Substepping keeps per-step travel under the radius and
  // matches the player's terminal speed, so bots collide identically.
  const STEP = 1 / 60;
  const steps = Math.max(1, Math.round(dt / STEP));
  const h = dt / steps;

  let { x, y, vx, vy } = state;

  for (let s = 0; s < steps; s++) {
    vx = (vx + inputX * sensitivity * h) * friction;
    vy = (vy + inputY * sensitivity * h) * friction;
    x += vx * h;
    y += vy * h;

    // Collide with local grid walls (re-fetched each substep as x/y move)
    const walls = getLocalWalls(grid, x, y);
    for (const wall of walls) {
      const cx = Math.max(wall.x, Math.min(x, wall.x + wall.width));
      const cy = Math.max(wall.y, Math.min(y, wall.y + wall.height));
      const ddx = x - cx, ddy = y - cy;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dist < radius && dist > 0) {
        const nx = ddx / dist, ny = ddy / dist;
        const overlap = radius - dist;
        x += nx * overlap;
        y += ny * overlap;
        // Slide along walls (remove only the into-wall component), matching engine.ts
        const vn = vx * nx + vy * ny;
        if (vn < 0) {
          vx -= vn * nx;
          vy -= vn * ny;
        }
      }
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
