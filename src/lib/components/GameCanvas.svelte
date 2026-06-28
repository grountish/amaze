<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { input } from '$lib/stores/inputStore';
  import { localGame, debugMode } from '$lib/stores/gameStore';
  import { players, currentPlayerId } from '$lib/stores/playerStore';
  import { defaultMaze } from '$lib/game/maze';
  import { generateMaze, seedFromMazeId, DEFAULT_SEED } from '$lib/game/mazeGen';
  import { createInitialGameState, updateGame } from '$lib/game/engine';
  import { startKeyboardInput } from '$lib/input/keyboardInput';
  import { startMotionInput } from '$lib/input/motionInput';
  import JoystickOverlay from '$lib/components/JoystickOverlay.svelte';
  import { updatePlayerPosition, updateBotPositions, scoreLap, advanceMaze, subscribeToRoom, subscribeToPlayers, enterShortcut, exitShortcut, subscribeToShortcut, updateMazeGrid, subscribeToMazeGrid, syncNutrients, collectNutrient, subscribeToNutrients, addTrap, triggerTrap, subscribeToTraps, fireShot, subscribeToShots, pruneShots, damagePlayer, setPlayerHp } from '$lib/firebase/rooms';
  import { setupPresence } from '$lib/firebase/presence';
  import type { LocalGameState, GameInput, Maze } from '$lib/game/types';
  import type { InputSource, ShortcutState, TrapData, ShotData } from '$lib/firebase/types';
  import { createCellGrid, initGridFromMaze, protectZone, depositPheromone, decayPheromone, evolveGrid, serializeWalls, deserializeWalls, getLocalWalls, findNutrientPositions, pickTrapCell, GRID_COLS, GRID_ROWS, CELL_SIZE, EVOLUTION_INTERVAL } from '$lib/game/cellularMaze';
  import type { CellGrid, NutrientData } from '$lib/game/cellularMaze';
  import { defaultGenome, mutate, bfsPath, computeBotInput, stepBotPhysics, isStuck, createHazard, recordDeath, createKnown, revealAround, hasLineOfSight } from '$lib/game/botAI';
  import type { BotGenome, BotPhysicsState, GridPath } from '$lib/game/botAI';

  export let roomId: string;
  export let playerId: string;
  export let inputSource: InputSource;
  export let debug: boolean = false;

  $: debugMode.set(debug);

  // Full world (the whole maze) vs the viewport we actually render into.
  const WORLD_WIDTH = GRID_COLS * CELL_SIZE;
  const WORLD_HEIGHT = GRID_ROWS * CELL_SIZE;
  // Canvas backbuffer = the full world, rendered 1:1 (crisp). CSS then scales the
  // whole thing up to fill the screen, so we zoom in WITHOUT cropping.
  const CANVAS_WIDTH = WORLD_WIDTH;
  const CANVAS_HEIGHT = WORLD_HEIGHT;
  // Auto-fit: scale so the WHOLE world fits the viewport (whichever axis is
  // tighter), so the entire maze is always visible with no crop. The
  // follow-camera clamp below then pins to (0,0) on its own.
  const ZOOM = Math.min(CANVAS_WIDTH / WORLD_WIDTH, CANVAS_HEIGHT / WORLD_HEIGHT);
  // How long a trap telegraphs (warning ring) before it becomes lethal.
  const TRAP_ARM_MS = 1500;
  // Shooting. Projectiles are time-derived (pos = origin + dir·speed·age), so
  // they cost zero per-frame network. Each shot is processed by its owner only.
  const SHOT_SPEED = 520; // px/s
  const SHOT_TTL = 1400; // ms before a shot expires
  const SHOT_RADIUS = 4;
  const FIRE_COOLDOWN = 380; // ms between shots
  const MAX_HP = 3; // hits to die
  const POSITION_SYNC_THROTTLE = 50;

  const PLAYER_COLORS = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#ffeaa7', '#dda0dd'];

  let canvas: HTMLCanvasElement;
  let gameState: LocalGameState;
  // Active procedural maze (changes each lap in endless morph)
  let activeMaze: Maze = defaultMaze;
  let currentSeed = DEFAULT_SEED;
  let myLaps = 0; // this player's completed personal laps (for the banner)
  let lapWinSent = false; // guard: one maze-advance per lap (whoever finishes first)
  let lapFlash = ''; // transient winner banner
  let lapFlashTimer: ReturnType<typeof setTimeout> | null = null;
  let animFrameId: number;
  let cleanupFns: Array<() => void> = [];
  let lastProgressSync: number = 0;
  let gameStartTime: number = 0;
  let lastSyncedPos = { x: -9999, y: -9999 };

  // Lerped display positions for opponents (smooths network lag)
  const opponentDisplayPos = new Map<string, { x: number; y: number }>();

  // Shortcut gate state
  let shortcutState: ShortcutState | null = null;
  let inShortcut = false;

  // Evolving maze grid
  let cellGrid: CellGrid | null = null;
  let lastEvolutionTick = 0;
  let lastPheromoneDecay = 0;

  // Nutrients & speed boosts
  let nutrients: Record<string, NutrientData> = {};
  let collectedNutrients = new Set<string>();
  type SpeedBoost = { expires: number; factor: number };
  let speedBoosts: SpeedBoost[] = [];

  // Traps
  let traps: Record<string, TrapData> = {};
  let triggeredTraps = new Set<string>();

  // Shooting
  let shots: Record<string, ShotData> = {};
  let consumedShots = new Set<string>(); // ids we've already resolved locally
  let lastShotAt = 0;
  let lastHeading = { x: 1, y: 0 }; // aim fallback when standing still
  const WALL_HP = 3; // shots to break a wall cell
  let wallHits = new Map<number, number>(); // cellIndex → my hits so far (local)

  // Player death / respawn
  let deathFlashUntil = 0;

  // Bot AI state (per opponent bot id)
  type BotAIState = {
    genome: BotGenome;
    physics: BotPhysicsState;
    path: GridPath | null;
    waypointIdx: number;
    lastProgress: number;
    lastProgressTime: number;
    hazard: Float32Array; // learned death map, carried across resets
    known: Uint8Array;    // fog-of-war discovered cells, carried across resets
    replanAt: number;     // next time this bot may recompute its path
  };
  const botAIStates = new Map<string, BotAIState>();

  // Zombies don't wander: pure path-follow, no pheromone drift, no random
  // deviation — a relentless beeline toward the prey.
  const ZOMBIE_GENOME: BotGenome = {
    pathWeight: 1, pheroWeight: 0, exploreRate: 0,
    generation: 1, deaths: 0, bestProgress: 0,
  };
  // Last-seen human positions + smoothed velocity (id → …) so zombies can lead
  // the target instead of chasing where it already left.
  const humanTrack = new Map<string, { x: number; y: number; t: number; vx: number; vy: number }>();
  let lastKnownProgress = 0;
  let lastFrameTime: number = 0;

  function getPlayerColor(pid: string): string {
    if (!pid) return PLAYER_COLORS[0];
    let hash = 0;
    for (let i = 0; i < pid.length; i++) {
      hash = (hash * 31 + pid.charCodeAt(i)) & 0xffffffff;
    }
    return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
  }

  // Battle roles: ~half the bots are "zombies" that hunt the human instead of
  // racing. Derived purely from the bot id (hash parity) so the host AI and
  // every client agree with zero extra network — no stored role field.
  function isZombie(id: string): boolean {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
    return (Math.abs(hash) & 1) === 0;
  }

  // Current position of a shot, derived purely from how long it's been alive.
  function shotXY(s: ShotData, nowMs: number): { x: number; y: number; age: number } {
    const age = (nowMs - s.firedAt) / 1000;
    return { x: s.x + s.dx * SHOT_SPEED * age, y: s.y + s.dy * SHOT_SPEED * age, age };
  }

  // Fire a shot in the ball's heading (last movement direction). Rate-limited.
  function fire() {
    if (inputSource === 'bot' || !gameState || gameState.status !== 'playing') return;
    const nowMs = Date.now();
    if (nowMs - lastShotAt < FIRE_COOLDOWN) return;
    lastShotAt = nowMs;
    let dx = gameState.ball.velocity.x, dy = gameState.ball.velocity.y;
    const mag = Math.hypot(dx, dy);
    if (mag < 1) { dx = lastHeading.x; dy = lastHeading.y; }
    else { dx /= mag; dy /= mag; lastHeading = { x: dx, y: dy }; }
    fireShot(roomId, {
      owner: playerId,
      // Spawn just ahead of the ball so it doesn't clip our own cell.
      x: gameState.ball.position.x + dx * (gameState.ball.radius + SHOT_RADIUS + 1),
      y: gameState.ball.position.y + dy * (gameState.ball.radius + SHOT_RADIUS + 1),
      dx, dy, firedAt: nowMs,
    }).catch(console.error);
  }

  // The maze walls + Turing tint only change on the 1.5s evolution tick, not
  // per frame. Rasterise them once into this offscreen layer and blit it each
  // frame — avoids re-scanning all GRID_COLS×GRID_ROWS cells (and allocating an
  // rgba string per cell) 60×/s, which is what made the doubled maze lag.
  let mazeLayer: HTMLCanvasElement | null = null;
  let mazeLayerDirty = true;

  function renderMazeLayer() {
    if (!mazeLayer) {
      mazeLayer = document.createElement('canvas');
      mazeLayer.width = WORLD_WIDTH; // the full maze, not the viewport
      mazeLayer.height = WORLD_HEIGHT;
    }
    const mctx = mazeLayer.getContext('2d');
    if (!mctx) return;

    mctx.fillStyle = '#06060f';
    mctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    if (cellGrid) {
      // Wall cells
      for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
          const i = r * GRID_COLS + c;
          if (!cellGrid.walls[i]) continue;
          const ev = cellGrid.evolved[i];
          mctx.fillStyle = ev === -1 ? '#882222' : ev === 1 ? '#224488' : '#2e2e50';
          mctx.fillRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
      }
    } else {
      // Fallback: static walls while grid initialises
      mctx.fillStyle = '#2e2e50';
      for (const wall of activeMaze.walls) {
        mctx.fillRect(wall.x, wall.y, wall.width, wall.height);
      }
    }
  }

  function draw(deltaTime: number) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const maze = activeMaze;

    const drawNow = Date.now();

    // ── Camera: zoom in and follow the local ball, clamped to the world so we
    // never show past the edges. World-space drawing happens under this
    // transform; the HUD/overlays reset to screen space below.
    const camBallX = gameState ? gameState.ball.position.x : WORLD_WIDTH / 2;
    const camBallY = gameState ? gameState.ball.position.y : WORLD_HEIGHT / 2;
    const viewW = CANVAS_WIDTH / ZOOM;
    const viewH = CANVAS_HEIGHT / ZOOM;
    const camX = Math.max(0, Math.min(WORLD_WIDTH - viewW, camBallX - viewW / 2));
    const camY = Math.max(0, Math.min(WORLD_HEIGHT - viewH, camBallY - viewH / 2));
    ctx.setTransform(ZOOM, 0, 0, ZOOM, -camX * ZOOM, -camY * ZOOM);

    // Blit the cached maze layer (opaque bg → also clears the previous frame).
    if (mazeLayerDirty) { renderMazeLayer(); mazeLayerDirty = false; }
    if (mazeLayer) ctx.drawImage(mazeLayer, 0, 0);

    // ── Cracks on walls I've damaged (local) — builds toward breaking ──
    if (cellGrid && wallHits.size) {
      ctx.strokeStyle = '#ffcaa0';
      ctx.lineWidth = 1.5;
      for (const [ci, hits] of wallHits) {
        if (!cellGrid.walls[ci]) { wallHits.delete(ci); continue; }
        const cx = (ci % GRID_COLS) * CELL_SIZE;
        const cy = Math.floor(ci / GRID_COLS) * CELL_SIZE;
        ctx.beginPath();
        // one slash per hit landed so far
        for (let h = 0; h < hits; h++) {
          const off = 4 + h * 6;
          ctx.moveTo(cx + off, cy + 3);
          ctx.lineTo(cx + off - 4, cy + CELL_SIZE - 3);
        }
        ctx.stroke();
      }
    }

    {
      // ── Nutrients ──────────────────────────────────────────
      for (const [, n] of Object.entries(nutrients)) {
        if (n.expiresAt < drawNow) continue;
        const nx = n.col * CELL_SIZE + CELL_SIZE / 2;
        const ny = n.row * CELL_SIZE + CELL_SIZE / 2;
        const pulse = 0.6 + 0.4 * Math.sin(drawNow / 300 + n.col);
        ctx.save();
        ctx.beginPath();
        ctx.arc(nx, ny, 5 * pulse, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,${160 + n.value * 25},0,${0.7 + 0.3 * pulse})`;
        ctx.fill();
        ctx.restore();
      }

      // ── Traps ─────────────────────────────────────────────────
      for (const [, trap] of Object.entries(traps)) {
        const tx = trap.col * CELL_SIZE + CELL_SIZE / 2;
        const ty = trap.row * CELL_SIZE + CELL_SIZE / 2;
        const arming = trap.armAt != null && drawNow < trap.armAt;
        if (arming) {
          // Telegraph: an amber ring closes in as the trap arms, so the danger
          // is visible from a distance well before it can kill you.
          const progress = Math.max(0, Math.min(1, 1 - (trap.armAt! - drawNow) / TRAP_ARM_MS));
          const ringR = 26 - 14 * progress; // shrinks toward the cell
          const blink = 0.5 + 0.5 * Math.sin(drawNow / 90);
          ctx.save();
          ctx.strokeStyle = `rgba(255,190,40,${0.45 + 0.45 * blink})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(tx, ty, ringR, 0, Math.PI * 2);
          ctx.stroke();
          // Center dot growing toward "live"
          ctx.fillStyle = `rgba(255,120,30,${0.3 + 0.5 * progress})`;
          ctx.beginPath();
          ctx.arc(tx, ty, 2 + 3 * progress, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else {
          const pulse = 0.7 + 0.3 * Math.sin(drawNow / 200 + trap.col + trap.row);
          const sz = 5 * pulse;
          ctx.save();
          ctx.strokeStyle = `rgba(255,30,30,${0.8 + 0.2 * pulse})`;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(tx - sz, ty - sz); ctx.lineTo(tx + sz, ty + sz);
          ctx.moveTo(tx + sz, ty - sz); ctx.lineTo(tx - sz, ty + sz);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // ── Shortcut gate ──────────────────────────────────────────
    if (maze.shortcut) {
      const { zone, gapWall } = maze.shortcut;
      const now = Date.now();
      const collapsed = shortcutState?.collapseUntil != null && shortcutState.collapseUntil > now;
      const cx = gapWall.x + gapWall.width / 2;
      const cy = gapWall.y + gapWall.height / 2;

      if (collapsed) {
        // Red pulsing wall + countdown
        const pulse = 0.6 + 0.4 * Math.sin(now / 120);
        ctx.save();
        ctx.fillStyle = `rgba(200, 40, 40, ${pulse})`;
        ctx.fillRect(gapWall.x, gapWall.y, gapWall.width, gapWall.height);
        ctx.restore();
        const secsLeft = Math.ceil((shortcutState!.collapseUntil! - now) / 1000);
        ctx.fillStyle = '#ff8888';
        ctx.font = 'bold 11px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(`${secsLeft}s`, cx, cy - 14);
      } else {
        // Green glowing open gate
        const pulse = 0.5 + 0.5 * Math.sin(now / 400);
        ctx.save();
        ctx.strokeStyle = `rgba(0, 255, 170, ${0.4 + 0.4 * pulse})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(gapWall.x, gapWall.y + gapWall.height / 2);
        ctx.lineTo(gapWall.x + gapWall.width, gapWall.y + gapWall.height / 2);
        ctx.stroke();
        ctx.restore();
        // Label
        ctx.globalAlpha = 0.5 + 0.3 * pulse;
        ctx.fillStyle = '#00ffaa';
        ctx.font = 'bold 10px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('SHORTCUT', cx, cy - 14);
        ctx.globalAlpha = 1;
      }
    }

    const allPlayers = get(players);

    // ── Opponents (lerped) ─────────────────────────────────────
    const lerpFactor = 1 - Math.exp(-12 * deltaTime);
    for (const player of allPlayers) {
      if (player.id === playerId) continue;
      let targetX: number;
      let targetY: number;
      if (player.x != null && player.y != null) {
        targetX = player.x;
        targetY = player.y;
      } else {
        const t = (player.progress ?? 0) / 100;
        targetX = maze.startPosition.x + (maze.hole.x - maze.startPosition.x) * t;
        targetY = maze.startPosition.y + (maze.hole.y - maze.startPosition.y) * t;
      }
      const prev = opponentDisplayPos.get(player.id) ?? { x: targetX, y: targetY };
      const px = prev.x + (targetX - prev.x) * lerpFactor;
      const py = prev.y + (targetY - prev.y) * lerpFactor;
      opponentDisplayPos.set(player.id, { x: px, y: py });

      // Zombie bots get a blood-red look so the player can read the threat.
      const zombie = player.inputSource === 'bot' && isZombie(player.id);
      const color = zombie ? '#e0241c' : getPlayerColor(player.id);
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.globalAlpha = zombie ? 0.9 : 0.7;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = zombie ? '#6e0a06' : color;
      ctx.lineWidth = 2;
      ctx.stroke();
      // Label human opponents only — bots are anonymous (no name/gen text)
      if (player.inputSource !== 'bot') {
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = '#fff';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(player.name, px, py - 16);
        ctx.globalAlpha = 1;
      }
    }

    // Draw hole: dark circle with gold border
    ctx.beginPath();
    ctx.arc(maze.hole.x, maze.hole.y, maze.hole.radius, 0, Math.PI * 2);
    ctx.fillStyle = '#0a0a1a';
    ctx.fill();
    ctx.strokeStyle = '#ffd700';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Draw start position marker
    ctx.beginPath();
    ctx.arc(maze.startPosition.x, maze.startPosition.y, 8, 0, Math.PI * 2);
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = '#00ff88';
    ctx.fill();
    ctx.globalAlpha = 1;

    // Draw local player marble: white with shadow
    if (gameState) {
      const { position, radius } = gameState.ball;
      ctx.save();
      ctx.beginPath();
      ctx.arc(position.x, position.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();
    }

    // ── Shots (time-derived positions) ─────────────────────────
    for (const [, s] of Object.entries(shots)) {
      const p = shotXY(s, drawNow);
      if (p.age > SHOT_TTL / 1000) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, SHOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = s.owner === playerId ? '#ffe066' : '#ff8c42';
      ctx.fill();
    }

    // ── Health pips above each racer with < full hp ────────────
    for (const pl of allPlayers) {
      const hp = pl.hp ?? MAX_HP;
      if (hp >= MAX_HP || hp < 0) continue;
      let px: number, py: number;
      if (pl.id === playerId && gameState) {
        px = gameState.ball.position.x; py = gameState.ball.position.y;
      } else {
        const dp = opponentDisplayPos.get(pl.id);
        if (!dp) continue;
        px = dp.x; py = dp.y;
      }
      for (let h = 0; h < MAX_HP; h++) {
        ctx.fillStyle = h < hp ? '#44dd66' : '#552222';
        ctx.fillRect(px - 9 + h * 7, py - 20, 5, 3);
      }
    }

    // Back to screen space for the HUD / overlays (no camera transform).
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // HUD — bottom bar
    if (gameState) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '16px monospace';
      ctx.fillText(`Progress: ${Math.round(gameState.progress)}%`, 30, CANVAS_HEIGHT - 30);

      // Speed boost indicator
      const now_hud = Date.now();
      const activeBoosts = speedBoosts.filter((b) => b.expires > now_hud);
      if (activeBoosts.length > 0) {
        const remaining = Math.max(0, Math.ceil((activeBoosts[0].expires - now_hud) / 1000));
        const factor = activeBoosts.reduce((f, b) => f * b.factor, 1.0);
        ctx.save();
        ctx.fillStyle = '#ffd700';
        ctx.font = 'bold 15px monospace';
        ctx.fillText(`⚡ ×${factor.toFixed(1)} ${remaining}s`, CANVAS_WIDTH - 140, CANVAS_HEIGHT - 30);
        ctx.restore();
      }

    }

    // Death flash overlay
    if (deathFlashUntil > 0) {
      const remaining = deathFlashUntil - Date.now();
      if (remaining > 0) {
        const alpha = remaining / 800;
        ctx.save();
        ctx.globalAlpha = alpha * 0.55;
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 32px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('YOU DIED', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
        ctx.textAlign = 'left';
        ctx.restore();
      }
    }

    // Debug: draw input vector as arrow from ball center (world space).
    if (debug && gameState) {
      ctx.setTransform(ZOOM, 0, 0, ZOOM, -camX * ZOOM, -camY * ZOOM);
      const currentInput = get(input);
      const { position } = gameState.ball;
      const arrowLen = 50;
      const tx = position.x + currentInput.x * arrowLen;
      const ty = position.y + currentInput.y * arrowLen;

      if (currentInput.x !== 0 || currentInput.y !== 0) {
        const angle = Math.atan2(ty - position.y, tx - position.x);
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(position.x, position.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();

        // Arrowhead
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(
          tx - 10 * Math.cos(angle - Math.PI / 6),
          ty - 10 * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          tx - 10 * Math.cos(angle + Math.PI / 6),
          ty - 10 * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fillStyle = '#ff4444';
        ctx.fill();
      }
    }
  }

  function gameLoop(now: number) {
    const deltaTime = Math.min((now - lastFrameTime) / 1000, 0.05);
    lastFrameTime = now;

    // Bot skips physics — progress is driven by startBotProgressLoop
    if (inputSource !== 'bot') {
      const currentInput = get(input);
      const nowMs = Date.now();

      // Speed boost from nutrients
      speedBoosts = speedBoosts.filter((b) => b.expires > nowMs);
      const speedFactor = speedBoosts.reduce((f, b) => f * b.factor, 1.0);

      // Pheromone: deposit at local ball + all opponent positions
      if (cellGrid && gameState.status === 'playing') {
        depositPheromone(cellGrid, gameState.ball.position.x, gameState.ball.position.y);
        for (const pl of get(players)) {
          if (pl.id === playerId || pl.x == null || pl.y == null) continue;
          depositPheromone(cellGrid, pl.x, pl.y, 0.08);
        }
        // Decay at ~6Hz, not per frame. Pheromone isn't rendered and only feeds
        // evolution/bot-steer/trap-pick (all ≥600ms), so 60Hz over 4800 cells was
        // pure waste. Passing the accumulated dt keeps the decay rate identical.
        if (nowMs - lastPheromoneDecay > 160) {
          decayPheromone(cellGrid, (nowMs - lastPheromoneDecay) / 1000);
          lastPheromoneDecay = nowMs;
        }

        // Evolution tick — host-driven
        if (nowMs - lastEvolutionTick > EVOLUTION_INTERVAL) {
          lastEvolutionTick = nowMs;
          // Host = first HUMAN by id. Bots must be excluded: a bot could sort
          // first and "win" host, but bots never run this loop, so evolution
          // would silently stop the moment bots joined (fired once, then never).
          const sortedOnline = get(players)
            .filter((p) => p.online && p.inputSource !== 'bot')
            .sort((a, b) => a.id.localeCompare(b.id));
          // Fallback to self if no players loaded yet (Firebase async startup)
          const amHost = sortedOnline.length === 0 || sortedOnline[0].id === playerId;
          if (amHost) {
            evolveGrid(cellGrid, activeMaze); // also advances the Turing field
            mazeLayerDirty = true; // host: walls just changed
            updateMazeGrid(roomId, serializeWalls(cellGrid.walls)).catch(console.error);
            const candidates = findNutrientPositions(cellGrid, 3);
            syncNutrients(roomId, candidates).catch(console.error);

            // Often place a trap on a hot-path cell — but never on top of a
            // live racer, and with a warning delay before it goes lethal.
            if (Math.random() < 0.6) {
              const existingTrapCells = Object.values(traps);
              // Cells currently occupied by any racer (self + opponents).
              const playerCells = [
                { col: Math.floor(gameState.ball.position.x / CELL_SIZE), row: Math.floor(gameState.ball.position.y / CELL_SIZE) },
                ...get(players)
                  .filter((p) => p.x != null && p.y != null)
                  .map((p) => ({ col: Math.floor(p.x! / CELL_SIZE), row: Math.floor(p.y! / CELL_SIZE) })),
              ];
              const trapCell = pickTrapCell(cellGrid, activeMaze, existingTrapCells, playerCells);
              if (trapCell) addTrap(roomId, trapCell.col, trapCell.row, nowMs + TRAP_ARM_MS).catch(console.error);
            }

            // Prune expired shots so the shots node can't accumulate.
            const staleShots = Object.entries(shots)
              .filter(([, s]) => nowMs - s.firedAt > SHOT_TTL)
              .map(([id]) => id);
            if (staleShots.length) pruneShots(roomId, staleShots).catch(console.error);
          }
        }

        // Nutrient collection
        for (const [id, n] of Object.entries(nutrients)) {
          if (collectedNutrients.has(id)) continue;
          if (n.expiresAt < nowMs) continue;
          const nx = (n.col + 0.5) * CELL_SIZE;
          const ny = (n.row + 0.5) * CELL_SIZE;
          const dx = gameState.ball.position.x - nx;
          const dy = gameState.ball.position.y - ny;
          if (dx * dx + dy * dy < 484) {
            collectedNutrients.add(id);
            collectNutrient(roomId, id).then((ok) => {
              if (ok) speedBoosts = [...speedBoosts, { expires: nowMs + 8000, factor: 1 + n.value * 0.2 }];
              else collectedNutrients.delete(id);
            }).catch(console.error);
          }
        }
      }

      // Trap collision for local player (always check, not just when cellGrid ready)
      if (gameState.status === 'playing') {
        for (const [id, trap] of Object.entries(traps)) {
          if (triggeredTraps.has(id)) continue;
          // Not lethal until armed — the warning ring gives you time to dodge.
          if (trap.armAt != null && nowMs < trap.armAt) continue;
          const tx = (trap.col + 0.5) * CELL_SIZE;
          const ty = (trap.row + 0.5) * CELL_SIZE;
          const ddx = gameState.ball.position.x - tx;
          const ddy = gameState.ball.position.y - ty;
          if (ddx * ddx + ddy * ddy < 400) {
            triggeredTraps.add(id);
            triggerTrap(roomId, id).catch(console.error);
            deathFlashUntil = nowMs + 800;
            gameState = {
              ...gameState,
              ball: {
                ...gameState.ball,
                position: { ...activeMaze.startPosition },
                velocity: { x: 0, y: 0 },
              },
              progress: 0,
            };
          }
        }
      }

      // ── Shots: resolve only MY OWN shots (shooter-authoritative). Hit a wall
      // → remove that cell + broadcast. Hit another racer (incl. bots) → -1 hp.
      // Other clients just render; the victim/host handles death+respawn.
      if (gameState.status === 'playing') {
        const toPrune: string[] = [];
        for (const [id, s] of Object.entries(shots)) {
          if (s.owner !== playerId || consumedShots.has(id)) continue;
          const p = shotXY(s, nowMs);
          if (p.age > SHOT_TTL / 1000) { consumedShots.add(id); toPrune.push(id); continue; }
          if (p.x < 0 || p.y < 0 || p.x > WORLD_WIDTH || p.y > WORLD_HEIGHT) {
            consumedShots.add(id); toPrune.push(id); continue;
          }
          // Wall hit → chip the cell; it opens only after WALL_HP hits.
          if (cellGrid) {
            const cc = Math.floor(p.x / CELL_SIZE), cr = Math.floor(p.y / CELL_SIZE);
            const ci = cr * GRID_COLS + cc;
            if (cellGrid.walls[ci] && cellGrid.hardness[ci] !== 255) {
              const hits = (wallHits.get(ci) ?? 0) + 1;
              if (hits >= WALL_HP) {
                wallHits.delete(ci);
                cellGrid.walls[ci] = 0;
                cellGrid.hardness[ci] = 0;
                mazeLayerDirty = true;
                updateMazeGrid(roomId, serializeWalls(cellGrid.walls)).catch(console.error);
              } else {
                wallHits.set(ci, hits); // crack overlay shows the progress
              }
              consumedShots.add(id); toPrune.push(id);
              continue;
            }
          }
          // Racer hit → damage whoever it lands on (not the shooter).
          let hit = false;
          for (const pl of get(players)) {
            if (pl.id === playerId || pl.x == null || pl.y == null) continue;
            const ddx = pl.x - p.x, ddy = pl.y - p.y;
            const rr = 9 + SHOT_RADIUS;
            if (ddx * ddx + ddy * ddy < rr * rr) {
              damagePlayer(roomId, pl.id).catch(console.error);
              consumedShots.add(id); toPrune.push(id);
              hit = true;
              break;
            }
          }
          if (hit) continue;
        }
        if (toPrune.length) pruneShots(roomId, toPrune).catch(console.error);
      }

      // Took 3 hits (hp ran out) → respawn at start with fresh hp. Driven off the
      // synced hp the shooters decremented, so it triggers no matter who shot me.
      const myRec = get(players).find((p) => p.id === playerId);
      if (gameState.status === 'playing' && myRec && myRec.hp != null && myRec.hp <= 0) {
        deathFlashUntil = nowMs + 800;
        gameState = {
          ...gameState,
          ball: { ...gameState.ball, position: { ...activeMaze.startPosition }, velocity: { x: 0, y: 0 } },
          progress: 0,
        };
        setPlayerHp(roomId, playerId, MAX_HP).catch(console.error);
      }

      // ── Zombie contact: a hunting bot that touches me is instant death.
      // Self-authoritative (uses my real ball position), so it fires for every
      // human regardless of who hosts the bot AI. Respawn at start.
      if (gameState.status === 'playing') {
        const bx = gameState.ball.position.x, by = gameState.ball.position.y;
        const reach = gameState.ball.radius + 9;
        for (const pl of get(players)) {
          if (pl.inputSource !== 'bot' || pl.x == null || pl.y == null || !isZombie(pl.id)) continue;
          const ddx = pl.x - bx, ddy = pl.y - by;
          if (ddx * ddx + ddy * ddy < reach * reach) {
            deathFlashUntil = nowMs + 800;
            gameState = {
              ...gameState,
              ball: { ...gameState.ball, position: { ...activeMaze.startPosition }, velocity: { x: 0, y: 0 } },
              progress: 0,
            };
            break;
          }
        }
      }

      // Build physics walls from grid + optional shortcut collapse
      const shortcutCollapsed =
        activeMaze.shortcut != null &&
        shortcutState?.collapseUntil != null &&
        shortcutState.collapseUntil > nowMs;
      const localWalls = cellGrid
        ? getLocalWalls(cellGrid, gameState.ball.position.x, gameState.ball.position.y)
        : activeMaze.walls;
      if (shortcutCollapsed && activeMaze.shortcut) {
        localWalls.push(activeMaze.shortcut.gapWall);
      }
      const frameMaze = { ...activeMaze, walls: localWalls };
      gameState = updateGame(gameState, frameMaze, currentInput, deltaTime, speedFactor);

      // Safety net: never let the ball leave the maze bounds / go off-screen.
      {
        const rr = gameState.ball.radius;
        const maxX = GRID_COLS * CELL_SIZE - rr, maxY = GRID_ROWS * CELL_SIZE - rr;
        const bx = Math.max(rr, Math.min(maxX, gameState.ball.position.x));
        const by = Math.max(rr, Math.min(maxY, gameState.ball.position.y));
        if (bx !== gameState.ball.position.x || by !== gameState.ball.position.y) {
          gameState = { ...gameState, ball: { ...gameState.ball, position: { x: bx, y: by } } };
        }
      }

      // Shortcut zone entry/exit detection
      if (activeMaze.shortcut) {
        const { x, y } = gameState.ball.position;
        const { zone } = activeMaze.shortcut;
        const nowInZone =
          x >= zone.x && x <= zone.x + zone.width &&
          y >= zone.y && y <= zone.y + zone.height;
        if (nowInZone && !inShortcut && !shortcutCollapsed) {
          inShortcut = true;
          enterShortcut(roomId, playerId).catch(console.error);
        } else if (!nowInZone && inShortcut) {
          inShortcut = false;
          exitShortcut(roomId, playerId).catch(console.error);
        }
      }
      localGame.set(gameState);

      // Sync position + progress to Firebase at ~20fps, skip if barely moved
      if (now - lastProgressSync > POSITION_SYNC_THROTTLE) {
        const { x, y } = gameState.ball.position;
        const dx = x - lastSyncedPos.x;
        const dy = y - lastSyncedPos.y;
        if (dx * dx + dy * dy >= 4) {
          lastProgressSync = now;
          lastKnownProgress = gameState.progress;
          lastSyncedPos = { x, y };
          updatePlayerPosition(roomId, playerId, x, y, gameState.progress).catch(console.error);
        }
      }

      // Reached the hole → ALWAYS score my own lap (even if a bot triggered
      // this round's morph first). Only the maze advance is gated to one per
      // round. Respawn locally; the seed broadcast swaps in the fresh maze.
      if (gameState.status === 'finished') {
        scoreLap(roomId, playerId).catch(console.error);
        myLaps += 1;
        lapFlash = `Lap ${myLaps} complete!`;
        if (lapFlashTimer) clearTimeout(lapFlashTimer);
        lapFlashTimer = setTimeout(() => { lapFlash = ''; }, 1600);
        if (!lapWinSent) {
          lapWinSent = true;
          advanceMaze(roomId).catch(console.error);
        }
        gameState = {
          ...gameState,
          ball: { ...gameState.ball, position: { ...activeMaze.startPosition }, velocity: { x: 0, y: 0 } },
          status: 'playing',
          progress: 0,
        };
        localGame.set(gameState);
      }
    }

    draw(deltaTime);

    animFrameId = requestAnimationFrame(gameLoop);
  }

  // Endless morph: rebuild the maze + reset everyone to start. Driven by the
  // room's shared seed so every client generates an identical new maze.
  function applyMaze(seed: number) {
    activeMaze = generateMaze(seed);
    currentSeed = seed;
    if (!cellGrid) cellGrid = createCellGrid();
    initGridFromMaze(cellGrid, activeMaze);
    if (activeMaze.shortcut) protectZone(cellGrid, activeMaze.shortcut.zone);
    cellGrid.pheromone.fill(0);
    cellGrid.evolved.fill(0);
    wallHits.clear(); // wall damage doesn't carry to a fresh maze
    mazeLayerDirty = true; // brand-new maze ⇒ re-rasterise
    // Reset local ball to start
    if (gameState) {
      gameState = {
        ...gameState,
        ball: { ...gameState.ball, position: { ...activeMaze.startPosition }, velocity: { x: 0, y: 0 } },
        status: 'playing',
      };
      localGame.set(gameState);
    }
    // Reset all bots to start; new maze ⇒ fresh hazard map (old deaths are stale)
    for (const st of botAIStates.values()) {
      st.physics = { x: activeMaze.hole.x, y: activeMaze.hole.y, vx: 0, vy: 0 }; // bots spawn at the hole

      st.path = null;
      st.waypointIdx = 0;
      st.lastProgress = 0;
      st.lastProgressTime = Date.now();
      st.hazard = createHazard();
      st.known = createKnown(); // new maze ⇒ explore from scratch
      st.replanAt = 0;
    }
    lapWinSent = false; // fresh maze ⇒ the next finisher can advance again
  }

  onMount(() => {
    const initial = createInitialGameState(activeMaze);
    gameStartTime = Date.now();
    gameState = { ...initial, status: 'playing', startedAt: gameStartTime };
    localGame.set(gameState);

    // Re-assert presence: the lobby's onDestroy set us online:false, which
    // otherwise drops us from subscribeToPlayers (and the scoreboard) for the
    // whole game — so our laps would never show. Restores online:true + heartbeat.
    if (playerId) cleanupFns.push(setupPresence(roomId, playerId));

    // Initialise evolving grid
    cellGrid = createCellGrid();
    initGridFromMaze(cellGrid, activeMaze);
    if (activeMaze.shortcut) protectZone(cellGrid, activeMaze.shortcut.zone);

    // Aim defaults toward the hole until the player starts moving.
    {
      const ahx = activeMaze.hole.x - activeMaze.startPosition.x;
      const ahy = activeMaze.hole.y - activeMaze.startPosition.y;
      const am = Math.hypot(ahx, ahy) || 1;
      lastHeading = { x: ahx / am, y: ahy / am };
    }

    // Fire with Space (any human). preventDefault stops the page scrolling.
    if (inputSource !== 'bot') {
      const onFireKey = (e: KeyboardEvent) => {
        if (e.code === 'Space') { e.preventDefault(); fire(); }
      };
      window.addEventListener('keydown', onFireKey);
      cleanupFns.push(() => window.removeEventListener('keydown', onFireKey));
    }

    if (inputSource === 'keyboard') {
      cleanupFns.push(startKeyboardInput());
    } else if (inputSource === 'motion') {
      cleanupFns.push(startMotionInput());
    } else if (inputSource === 'bot') {
      // Local player is a bot — drive input store from AI
      const localBotGenome = { ...defaultGenome() };
      let localBotPath: GridPath | null = null;
      let localBotWpIdx = 0;
      let localBotReplansAt = 0;
      let localBotKnown = createKnown();
      let localBotSeen = currentSeed;

      const localBotId = setInterval(() => {
        if (!cellGrid) return;
        const nowMs = Date.now();
        const { x, y } = gameState.ball.position;
        // Maze morphed → forget the old layout and explore the new one
        if (currentSeed !== localBotSeen) {
          localBotKnown = createKnown();
          localBotSeen = currentSeed;
          localBotPath = null;
        }
        revealAround(localBotKnown, x, y);
        // Re-plan every 2s or when path exhausted (fog: unseen cells assumed open)
        if (!localBotPath || nowMs > localBotReplansAt) {
          localBotPath = bfsPath(cellGrid, x, y, activeMaze.hole.x, activeMaze.hole.y, null, localBotKnown);
          localBotWpIdx = 0;
          localBotReplansAt = nowMs + 2000;
        }
        const { input: botInput, nextWaypointIdx } = computeBotInput(
          localBotGenome, localBotPath, localBotWpIdx, x, y, cellGrid,
        );
        localBotWpIdx = nextWaypointIdx;
        input.set(botInput);
      }, 100);
      cleanupFns.push(() => clearInterval(localBotId));
    }

    // Keep players store live during the game (lobby subscription died on unmount)
    cleanupFns.push(
      // Watch the room's maze seed — it only changes on "Restart for all",
      // which regenerates a fresh maze for everyone. Personal laps no longer
      // morph the maze, so normal play keeps the same (evolving) maze.
      subscribeToRoom(roomId, (r) => {
        if (!r) return;
        const seed = seedFromMazeId(r.mazeId);
        if (seed !== currentSeed) applyMaze(seed);
      }),

      subscribeToShortcut(roomId, (s) => { shortcutState = s; }),

      subscribeToMazeGrid(roomId, (b64) => {
        if (b64 && cellGrid) {
          cellGrid.walls = deserializeWalls(b64);
          mazeLayerDirty = true; // host pushed new walls
          for (const s of botAIStates.values()) s.path = null;
          // Delay clearing evolved markers so flash is visible for ~1s
          setTimeout(() => { if (cellGrid) { cellGrid.evolved.fill(0); mazeLayerDirty = true; } }, 900);
        }
      }),

      subscribeToNutrients(roomId, (n) => { nutrients = n; }),

      subscribeToTraps(roomId, (t) => { traps = t; }),

      subscribeToShots(roomId, (s) => {
        shots = s;
        // Drop consumed-ids that no longer exist so the set can't grow forever.
        if (consumedShots.size) {
          for (const id of consumedShots) if (!(id in s)) consumedShots.delete(id);
        }
      }),

      subscribeToPlayers(roomId, (p) => {
        players.set(p);
        for (const pl of p) {
          // Init bot AI state as soon as we see a bot
          if (pl.inputSource === 'bot' && pl.id !== playerId && !botAIStates.has(pl.id)) {
            botAIStates.set(pl.id, {
              genome: defaultGenome(),
              // Battle mode: bots spawn at the hole and race toward the human's start.
              physics: { x: activeMaze.hole.x, y: activeMaze.hole.y, vx: 0, vy: 0 },
              path: null,
              waypointIdx: 0,
              lastProgress: 0,
              lastProgressTime: Date.now(),
              hazard: createHazard(),
              known: createKnown(),
              replanAt: 0,
            });
          }
        }
      }),
    );

    // ── Physics-based bot driver (replaces linear interpolation) ──
    const botDt = 0.05;
    const botDriverId = setInterval(async () => {
      if (!cellGrid) return;
      const nowMs = Date.now();
      const allPlayers = get(players);
      const bots = allPlayers.filter(
        (pl) => pl.inputSource === 'bot' && pl.id !== playerId && !pl.finishedAt,
      );
      // Live human targets for zombie bots (cheap: usually 1-2 players).
      const humans = allPlayers.filter(
        (pl) => pl.inputSource !== 'bot' && pl.x != null && pl.y != null && !pl.finishedAt,
      );
      // Refresh velocity tracks (EMA-smoothed against the ~20fps position
      // stream) so zombies can lead their prey rather than trail it.
      for (const h of humans) {
        const prev = humanTrack.get(h.id);
        let vx = 0, vy = 0;
        if (prev) {
          const dtSec = Math.max(0.001, (nowMs - prev.t) / 1000);
          vx = prev.vx * 0.6 + ((h.x! - prev.x) / dtSec) * 0.4;
          vy = prev.vy * 0.6 + ((h.y! - prev.y) / dtSec) * 0.4;
        }
        humanTrack.set(h.id, { x: h.x!, y: h.y!, t: nowMs, vx, vy });
      }

      // Collect every bot's new position and flush as ONE write at the end.
      const botWrites: { id: string; x: number; y: number; progress: number }[] = [];

      for (const bot of bots) {
        let state = botAIStates.get(bot.id);
        if (!state) continue;

        const hx = activeMaze.hole.x, hy = activeMaze.hole.y;
        const sx = activeMaze.startPosition.x, sy = activeMaze.startPosition.y;

        // Zombies hunt the nearest live human; racers head for the human's start.
        const zombie = isZombie(bot.id);
        let goalX = sx, goalY = sy;   // BFS goal (racer: start; zombie: lead point)
        let preyX = 0, preyY = 0;     // nearest human's live pos (for LOS lunge)
        let hasPrey = false;
        if (zombie && humans.length) {
          let best = Infinity, prey = humans[0];
          for (const h of humans) {
            const ddx = h.x! - state.physics.x, ddy = h.y! - state.physics.y;
            const d = ddx * ddx + ddy * ddy;
            if (d < best) { best = d; prey = h; }
          }
          hasPrey = true;
          preyX = prey.x!; preyY = prey.y!;
          // Lead the prey: aim a short time ahead along its velocity so the
          // zombie cuts the corner. Clamp so the planner target stays in-bounds.
          const tr = humanTrack.get(prey.id);
          const LEAD = 0.35; // seconds of look-ahead
          goalX = Math.max(0, Math.min(WORLD_WIDTH - 1, preyX + (tr ? tr.vx : 0) * LEAD));
          goalY = Math.max(0, Math.min(WORLD_HEIGHT - 1, preyY + (tr ? tr.vy : 0) * LEAD));
        }

        // Shot down (hp ran out) → respawn at start with fresh hp.
        if (bot.hp != null && bot.hp <= 0) {
          state = { ...state, physics: { x: hx, y: hy, vx: 0, vy: 0 }, path: null, waypointIdx: 0 };
          botAIStates.set(bot.id, state);
          setPlayerHp(roomId, bot.id, MAX_HP).catch(console.error);
          botWrites.push({ id: bot.id, x: hx, y: hy, progress: 0 });
          continue;
        }

        // Bot progress = how far it's travelled from its spawn (the hole) toward
        // the human's start, which is its goal.
        const dpx = state.physics.x - hx, dpy = state.physics.y - hy;
        const totalDist = Math.sqrt((hx - sx) ** 2 + (hy - sy) ** 2) || 1; // avoid /0
        const progress = Math.min(100, (Math.sqrt(dpx * dpx + dpy * dpy) / totalDist) * 100);
        const dGx = state.physics.x - sx, dGy = state.physics.y - sy;

        // Reached the human's start? → score this bot and reset only it. The
        // first finisher of the round also advances the maze for everyone (gated).
        // Zombies never "win" the race — they only hunt, so they skip this.
        if (!zombie && Math.sqrt(dGx * dGx + dGy * dGy) < 16) {
          scoreLap(roomId, bot.id).catch(console.error);
          if (!lapWinSent) {
            lapWinSent = true;
            advanceMaze(roomId).catch(console.error);
            lapFlash = 'New maze!';
            if (lapFlashTimer) clearTimeout(lapFlashTimer);
            lapFlashTimer = setTimeout(() => { lapFlash = ''; }, 1600);
          }
          state = {
            ...state,
            physics: { x: hx, y: hy, vx: 0, vy: 0 },
            path: null,
            waypointIdx: 0,
            lastProgress: 0,
            lastProgressTime: nowMs,
          };
          botAIStates.set(bot.id, state);
          continue;
        }

        // Trap check
        let hitTrap = false;
        for (const [trapId, trap] of Object.entries(traps)) {
          const tx = (trap.col + 0.5) * CELL_SIZE, ty = (trap.row + 0.5) * CELL_SIZE;
          const ddx = state.physics.x - tx, ddy = state.physics.y - ty;
          if (ddx * ddx + ddy * ddy < 400) {
            triggerTrap(roomId, trapId).catch(console.error);
            recordDeath(state.hazard, state.physics.x, state.physics.y);
            const newGenome = mutate(state.genome, progress);
            state = {
              genome: newGenome,
              physics: { x: hx, y: hy, vx: 0, vy: 0 },
              path: null,
              waypointIdx: 0,
              lastProgress: 0,
              lastProgressTime: nowMs,
              hazard: state.hazard,
              known: state.known,
              replanAt: 0,
            };
            botAIStates.set(bot.id, state);
            hitTrap = true;
            break;
          }
        }
        if (hitTrap) continue;

        // Stuck check
        if (progress > state.lastProgress + 2) {
          state.lastProgress = progress;
          state.lastProgressTime = nowMs;
        }
        if (isStuck(progress, state.lastProgressTime, state.genome, nowMs)) {
          recordDeath(state.hazard, state.physics.x, state.physics.y);
          const newGenome = mutate(state.genome, progress);
          state = {
            genome: newGenome,
            physics: { x: hx, y: hy, vx: 0, vy: 0 },
            path: null,
            waypointIdx: 0,
            lastProgress: 0,
            lastProgressTime: nowMs,
            hazard: state.hazard,
            known: state.known,
            replanAt: 0,
          };
          botAIStates.set(bot.id, state);
          continue;
        }

        // See what's nearby, then plan over only what's been discovered.
        revealAround(state.known, state.physics.x, state.physics.y);

        let botInput: { x: number; y: number };

        // A zombie that can SEE its prey (clear LOS within range) lunges straight
        // at it — no waypoints, no BFS. The range cap also bounds the raycast.
        const lx = preyX - state.physics.x, ly = preyY - state.physics.y;
        const LOS_RANGE = 420; // px
        if (
          zombie && hasPrey &&
          lx * lx + ly * ly < LOS_RANGE * LOS_RANGE &&
          hasLineOfSight(cellGrid, state.physics.x, state.physics.y, preyX, preyY)
        ) {
          const m = Math.hypot(lx, ly) || 1;
          botInput = { x: lx / m, y: ly / m };
          state.path = null; // out-of-sight next tick → forces a fresh plan
        } else {
          // Re-plan if pathless OR the cooldown elapsed — the latter lets the bot
          // react to walls it just discovered through the fog. Hazard map steers
          // around past deaths; known map gates what counts as a wall. Zombies
          // replan faster (the goal moves) and run the relentless hunter genome.
          if (!state.path || nowMs >= state.replanAt) {
            state.path = bfsPath(cellGrid, state.physics.x, state.physics.y, goalX, goalY, state.hazard, state.known);
            state.waypointIdx = 0;
            state.replanAt = nowMs + (zombie ? 400 : 600);
          }
          const r = computeBotInput(
            zombie ? ZOMBIE_GENOME : state.genome,
            state.path, state.waypointIdx, state.physics.x, state.physics.y, cellGrid,
          );
          botInput = r.input;
          state.waypointIdx = r.nextWaypointIdx;
        }

        // Step physics, then reveal the cells we moved into
        state.physics = stepBotPhysics(state.physics, botInput.x, botInput.y, cellGrid, botDt);
        revealAround(state.known, state.physics.x, state.physics.y);

        // Bot deposits pheromone
        depositPheromone(cellGrid, state.physics.x, state.physics.y, 0.1);

        botWrites.push({ id: bot.id, x: state.physics.x, y: state.physics.y, progress });
        botAIStates.set(bot.id, state);
      }

      // One batched RTDB write for all bots → one echo, no event-loop backup.
      updateBotPositions(roomId, botWrites).catch(console.error);
    }, 50);
    cleanupFns.push(() => clearInterval(botDriverId));

    lastFrameTime = performance.now();
    animFrameId = requestAnimationFrame(gameLoop);
  });

  onDestroy(() => {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (lapFlashTimer) clearTimeout(lapFlashTimer);
    for (const fn of cleanupFns) fn();
    cleanupFns = [];
    localGame.set(null);
  });
</script>

<div class="game-container">
  <canvas
    bind:this={canvas}
    width={CANVAS_WIDTH}
    height={CANVAS_HEIGHT}
    style="width: 100%; height: auto; display: block; margin: 0 auto;"
  />
  {#if lapFlash}
    <div class="lap-banner">{lapFlash}</div>
  {/if}
</div>

{#if inputSource === 'joystick'}
  <JoystickOverlay />
{/if}

{#if inputSource !== 'bot'}
  <button
    class="fire-btn"
    on:pointerdown|preventDefault={fire}
    aria-label="Shoot"
  >FIRE</button>
{/if}

<style>
  .game-container {
    position: relative;
    /* As large as the screen allows while keeping the whole 4:3 maze on screen:
       width can't exceed the viewport, nor the width that would make the 0.75×
       height taller than the viewport (≈133vh). Capped for ultra-wide. */
    width: min(98vw, 130vh);
    max-width: 1400px;
  }

  canvas {
    background: #1a1a2e;
  }

  /* Non-blocking winner notice — bottom banner so the maze stays fully
     visible (the centered overlay used to hide the board for ~2s while
     bots kept racing). */
  .lap-banner {
    position: absolute;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.72);
    color: #ffd700;
    font-family: monospace;
    font-weight: bold;
    font-size: 1rem;
    white-space: nowrap;
    padding: 0.4rem 1rem;
    border-radius: 8px;
    pointer-events: none;
    text-shadow: 0 0 12px rgba(255, 215, 0, 0.7);
    z-index: 30;
  }

  .fire-btn {
    position: fixed;
    right: 1.25rem;
    bottom: 1.5rem;
    width: 78px;
    height: 78px;
    border-radius: 50%;
    border: 2px solid #ffae42;
    background: rgba(200, 60, 20, 0.85);
    color: #fff;
    font-weight: 800;
    font-size: 0.95rem;
    letter-spacing: 0.04em;
    touch-action: none;
    user-select: none;
    z-index: 40;
  }

  .fire-btn:active {
    background: rgba(255, 120, 40, 0.95);
  }
</style>
