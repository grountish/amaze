<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { input } from '$lib/stores/inputStore';
  import { localGame, debugMode } from '$lib/stores/gameStore';
  import { players, currentPlayerId } from '$lib/stores/playerStore';
  import { defaultMaze } from '$lib/game/maze';
  import { createInitialGameState, updateGame } from '$lib/game/engine';
  import { startKeyboardInput } from '$lib/input/keyboardInput';
  import { startMotionInput } from '$lib/input/motionInput';
  import JoystickOverlay from '$lib/components/JoystickOverlay.svelte';
  import { updatePlayerPosition, finishPlayer, subscribeToPlayers, enterShortcut, exitShortcut, subscribeToShortcut, updateMazeGrid, subscribeToMazeGrid, syncNutrients, collectNutrient, subscribeToNutrients, addTrap, triggerTrap, subscribeToTraps } from '$lib/firebase/rooms';
  import type { LocalGameState, GameInput, Maze } from '$lib/game/types';
  import type { InputSource, ShortcutState, TrapData } from '$lib/firebase/types';
  import { createCellGrid, initGridFromMaze, protectZone, depositPheromone, decayPheromone, evolveGrid, serializeWalls, deserializeWalls, getLocalWalls, findNutrientPositions, pickTrapCell, GRID_COLS, GRID_ROWS, CELL_SIZE, EVOLUTION_INTERVAL } from '$lib/game/cellularMaze';
  import type { CellGrid, NutrientData } from '$lib/game/cellularMaze';
  import { defaultGenome, mutate, bfsPath, computeBotInput, stepBotPhysics, isStuck } from '$lib/game/botAI';
  import type { BotGenome, BotPhysicsState, GridPath } from '$lib/game/botAI';

  export let roomId: string;
  export let playerId: string;
  export let inputSource: InputSource;
  export let debug: boolean = false;

  $: debugMode.set(debug);

  const CANVAS_WIDTH = 800;
  const CANVAS_HEIGHT = 600;
  const POSITION_SYNC_THROTTLE = 50;

  const PLAYER_COLORS = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#ffeaa7', '#dda0dd'];

  let canvas: HTMLCanvasElement;
  let gameState: LocalGameState;
  let animFrameId: number;
  let cleanupFns: Array<() => void> = [];
  let lastProgressSync: number = 0;
  let gameStartTime: number = 0;
  let lastSyncedPos = { x: -9999, y: -9999 };

  // Lerped display positions for opponents (smooths network lag)
  const opponentDisplayPos = new Map<string, { x: number; y: number }>();

  // Pheromone trail history: playerId → [{x,y,t}]
  type TrailPoint = { x: number; y: number; t: number };
  const TRAIL_MAX_AGE = 3500;
  const TRAIL_MAX_POINTS = 80;
  const opponentTrails = new Map<string, TrailPoint[]>();
  let localTrail: TrailPoint[] = [];

  // Shortcut gate state
  let shortcutState: ShortcutState | null = null;
  let inShortcut = false;

  // Evolving maze grid
  let cellGrid: CellGrid | null = null;
  let lastEvolutionTick = 0;

  // Nutrients & speed boosts
  let nutrients: Record<string, NutrientData> = {};
  let collectedNutrients = new Set<string>();
  type SpeedBoost = { expires: number; factor: number };
  let speedBoosts: SpeedBoost[] = [];

  // Traps
  let traps: Record<string, TrapData> = {};
  let triggeredTraps = new Set<string>();

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
  };
  const botAIStates = new Map<string, BotAIState>();
  let finishedSynced = false;
  let lastKnownProgress = 0;
  let lastFrameTime: number = 0;

  function getPlayerColor(pid: string): string {
    let hash = 0;
    for (let i = 0; i < pid.length; i++) {
      hash = (hash * 31 + pid.charCodeAt(i)) & 0xffffffff;
    }
    return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
  }

  function draw(deltaTime: number) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const maze = defaultMaze;

    // Clear with dark background
    ctx.fillStyle = '#06060f';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    const drawNow = Date.now();

    if (cellGrid) {
      // ── Pheromone heatmap ──────────────────────────────────
      for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
          const i = r * GRID_COLS + c;
          const ph = cellGrid.pheromone[i];
          if (ph < 0.02) continue;
          ctx.globalAlpha = Math.min(0.75, ph);
          // Amber → yellow → white as pheromone increases
          const hue = 35 - ph * 15;
          const light = 45 + ph * 25;
          ctx.fillStyle = `hsl(${hue}, 100%, ${light}%)`;
          ctx.fillRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
      }
      ctx.globalAlpha = 1;

      // ── Wall cells ─────────────────────────────────────────
      for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
          const i = r * GRID_COLS + c;
          if (!cellGrid.walls[i]) continue;
          const ev = cellGrid.evolved[i];
          ctx.fillStyle = ev === -1 ? '#882222' : ev === 1 ? '#224488' : '#2e2e50';
          ctx.fillRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
      }

      // ── Nutrients ──────────────────────────────────────────
      for (const [, n] of Object.entries(nutrients)) {
        if (n.expiresAt < drawNow) continue;
        const nx = n.col * CELL_SIZE + CELL_SIZE / 2;
        const ny = n.row * CELL_SIZE + CELL_SIZE / 2;
        const pulse = 0.6 + 0.4 * Math.sin(drawNow / 300 + n.col);
        ctx.save();
        ctx.shadowColor = '#ffd700';
        ctx.shadowBlur = 14 * pulse;
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
        const pulse = 0.7 + 0.3 * Math.sin(drawNow / 200 + trap.col + trap.row);
        const sz = 5 * pulse;
        ctx.save();
        ctx.shadowColor = '#ff2222';
        ctx.shadowBlur = 10 * pulse;
        ctx.strokeStyle = `rgba(255,30,30,${0.8 + 0.2 * pulse})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(tx - sz, ty - sz); ctx.lineTo(tx + sz, ty + sz);
        ctx.moveTo(tx + sz, ty - sz); ctx.lineTo(tx - sz, ty + sz);
        ctx.stroke();
        ctx.restore();
      }
    } else {
      // Fallback: static walls while grid initialises
      ctx.fillStyle = '#2e2e50';
      for (const wall of defaultMaze.walls) {
        ctx.fillRect(wall.x, wall.y, wall.width, wall.height);
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
        ctx.shadowColor = '#ff4444';
        ctx.shadowBlur = 16 * pulse;
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
        ctx.shadowColor = '#00ffaa';
        ctx.shadowBlur = 18 * pulse;
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

    // ── Pheromone trails ───────────────────────────────────────
    const now = Date.now();

    // Local player trail
    if (gameState) {
      const lp = gameState.ball.position;
      localTrail.push({ x: lp.x, y: lp.y, t: now });
      if (localTrail.length > TRAIL_MAX_POINTS) localTrail.shift();
      for (const pt of localTrail) {
        const age = now - pt.t;
        if (age > TRAIL_MAX_AGE) continue;
        const alpha = (1 - age / TRAIL_MAX_AGE) * 0.25;
        const r = 6 * (1 - age / TRAIL_MAX_AGE);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, Math.max(1, r), 0, Math.PI * 2);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Opponent trails
    const allPlayers = get(players);
    for (const player of allPlayers) {
      if (player.id === playerId) continue;
      if (player.x == null || player.y == null) continue;
      const trail = opponentTrails.get(player.id) ?? [];
      const color = getPlayerColor(player.id);
      for (const pt of trail) {
        const age = now - pt.t;
        if (age > TRAIL_MAX_AGE) continue;
        const alpha = (1 - age / TRAIL_MAX_AGE) * 0.22;
        const r = 6 * (1 - age / TRAIL_MAX_AGE);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, Math.max(1, r), 0, Math.PI * 2);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

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

      const color = getPlayerColor(player.id);
      ctx.beginPath();
      ctx.arc(px, py, 12, 0, Math.PI * 2);
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#fff';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'center';
      // Show bot generation (Gen N/deaths) for bot opponents
      const botState = botAIStates.get(player.id);
      const label = botState
        ? `${player.name} Gen${botState.genome.generation}`
        : player.name;
      ctx.fillText(label, px, py - 16);
      ctx.globalAlpha = 1;
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
      ctx.shadowColor = 'rgba(255, 255, 255, 0.4)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(position.x, position.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();
    }

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
        ctx.shadowColor = '#ffd700';
        ctx.shadowBlur = 8;
        ctx.fillStyle = '#ffd700';
        ctx.font = 'bold 15px monospace';
        ctx.fillText(`⚡ ×${factor.toFixed(1)} ${remaining}s`, CANVAS_WIDTH - 140, CANVAS_HEIGHT - 30);
        ctx.restore();
      }

      // Evolution indicator — flashes briefly when maze just evolved
      const anyEvolved = cellGrid && cellGrid.evolved.some((v) => v !== 0);
      if (anyEvolved) {
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = '#44aaff';
        ctx.font = '13px monospace';
        ctx.fillText('MAZE EVOLVING', CANVAS_WIDTH / 2 - 55, CANVAS_HEIGHT - 30);
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

    // Debug: draw input vector as arrow from ball center
    if (debug && gameState) {
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
          depositPheromone(cellGrid, pl.x, pl.y, 0.04);
        }
        decayPheromone(cellGrid, deltaTime);

        // Evolution tick — host-driven
        if (nowMs - lastEvolutionTick > EVOLUTION_INTERVAL) {
          lastEvolutionTick = nowMs;
          const sortedOnline = get(players).filter((p) => p.online).sort((a, b) => a.id.localeCompare(b.id));
          // Fallback to self if no players loaded yet (Firebase async startup)
          const amHost = sortedOnline.length === 0 || sortedOnline[0].id === playerId;
          if (amHost) {
            evolveGrid(cellGrid, defaultMaze);
            updateMazeGrid(roomId, serializeWalls(cellGrid.walls)).catch(console.error);
            const candidates = findNutrientPositions(cellGrid, 3);
            syncNutrients(roomId, candidates).catch(console.error);

            // 30% chance to place a trap on a hot-path cell
            if (Math.random() < 0.3) {
              const existingTrapCells = Object.values(traps);
              const trapCell = pickTrapCell(cellGrid, defaultMaze, existingTrapCells);
              if (trapCell) addTrap(roomId, trapCell.col, trapCell.row).catch(console.error);
            }
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
                position: { ...defaultMaze.startPosition },
                velocity: { x: 0, y: 0 },
              },
              progress: 0,
            };
          }
        }
      }

      // Build physics walls from grid + optional shortcut collapse
      const shortcutCollapsed =
        defaultMaze.shortcut != null &&
        shortcutState?.collapseUntil != null &&
        shortcutState.collapseUntil > nowMs;
      const localWalls = cellGrid
        ? getLocalWalls(cellGrid, gameState.ball.position.x, gameState.ball.position.y)
        : defaultMaze.walls;
      if (shortcutCollapsed && defaultMaze.shortcut) {
        localWalls.push(defaultMaze.shortcut.gapWall);
      }
      const activeMaze = { ...defaultMaze, walls: localWalls };
      gameState = updateGame(gameState, activeMaze, currentInput, deltaTime, speedFactor);

      // Shortcut zone entry/exit detection
      if (defaultMaze.shortcut) {
        const { x, y } = gameState.ball.position;
        const { zone } = defaultMaze.shortcut;
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

      // Handle finish (once)
      if (gameState.status === 'finished' && !finishedSynced) {
        finishedSynced = true;
        const timeMs = Date.now() - gameStartTime;
        finishPlayer(roomId, playerId, timeMs).catch(console.error);
      }
    }

    draw(deltaTime);

    animFrameId = requestAnimationFrame(gameLoop);
  }

  onMount(() => {
    const initial = createInitialGameState(defaultMaze);
    gameStartTime = Date.now();
    gameState = { ...initial, status: 'playing', startedAt: gameStartTime };
    localGame.set(gameState);

    // Initialise evolving grid
    cellGrid = createCellGrid();
    initGridFromMaze(cellGrid, defaultMaze);
    if (defaultMaze.shortcut) protectZone(cellGrid, defaultMaze.shortcut.zone);

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

      const localBotId = setInterval(() => {
        if (!cellGrid) return;
        const nowMs = Date.now();
        const { x, y } = gameState.ball.position;
        // Re-plan every 2s or when path exhausted
        if (!localBotPath || nowMs > localBotReplansAt) {
          localBotPath = bfsPath(cellGrid, x, y, defaultMaze.hole.x, defaultMaze.hole.y);
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
      subscribeToShortcut(roomId, (s) => { shortcutState = s; }),

      subscribeToMazeGrid(roomId, (b64) => {
        if (b64 && cellGrid) {
          cellGrid.walls = deserializeWalls(b64);
          for (const s of botAIStates.values()) s.path = null;
          // Delay clearing evolved markers so flash is visible for ~1s
          setTimeout(() => { if (cellGrid) cellGrid.evolved.fill(0); }, 900);
        }
      }),

      subscribeToNutrients(roomId, (n) => { nutrients = n; }),

      subscribeToTraps(roomId, (t) => { traps = t; }),

      subscribeToPlayers(roomId, (p) => {
        players.set(p);
        const t = Date.now();
        for (const pl of p) {
          // Init bot AI state as soon as we see a bot — before position check
          if (pl.inputSource === 'bot' && pl.id !== playerId && !botAIStates.has(pl.id)) {
            botAIStates.set(pl.id, {
              genome: defaultGenome(),
              physics: { x: defaultMaze.startPosition.x, y: defaultMaze.startPosition.y, vx: 0, vy: 0 },
              path: null,
              waypointIdx: 0,
              lastProgress: 0,
              lastProgressTime: Date.now(),
            });
          }

          if (pl.id === playerId || pl.x == null || pl.y == null) continue;
          const trail = opponentTrails.get(pl.id) ?? [];
          trail.push({ x: pl.x, y: pl.y, t });
          if (trail.length > TRAIL_MAX_POINTS) trail.shift();
          opponentTrails.set(pl.id, trail);
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

      for (const bot of bots) {
        let state = botAIStates.get(bot.id);
        if (!state) continue;

        // Progress towards hole
        const hx = defaultMaze.hole.x, hy = defaultMaze.hole.y;
        const sx = defaultMaze.startPosition.x, sy = defaultMaze.startPosition.y;
        const dpx = state.physics.x - sx, dpy = state.physics.y - sy;
        const totalDist = Math.sqrt((hx - sx) ** 2 + (hy - sy) ** 2);
        const progress = Math.min(100, (Math.sqrt(dpx * dpx + dpy * dpy) / totalDist) * 100);
        const dHx = state.physics.x - hx, dHy = state.physics.y - hy;

        // Reached hole?
        if (Math.sqrt(dHx * dHx + dHy * dHy) < defaultMaze.hole.radius - 6) {
          botAIStates.delete(bot.id);
          await finishPlayer(roomId, bot.id, nowMs - gameStartTime).catch(console.error);
          continue;
        }

        // Trap check
        let hitTrap = false;
        for (const [trapId, trap] of Object.entries(traps)) {
          const tx = (trap.col + 0.5) * CELL_SIZE, ty = (trap.row + 0.5) * CELL_SIZE;
          const ddx = state.physics.x - tx, ddy = state.physics.y - ty;
          if (ddx * ddx + ddy * ddy < 400) {
            triggerTrap(roomId, trapId).catch(console.error);
            const newGenome = mutate(state.genome, progress);
            state = {
              genome: newGenome,
              physics: { x: sx, y: sy, vx: 0, vy: 0 },
              path: null,
              waypointIdx: 0,
              lastProgress: 0,
              lastProgressTime: nowMs,
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
          const newGenome = mutate(state.genome, progress);
          state = {
            genome: newGenome,
            physics: { x: sx, y: sy, vx: 0, vy: 0 },
            path: null,
            waypointIdx: 0,
            lastProgress: 0,
            lastProgressTime: nowMs,
          };
          botAIStates.set(bot.id, state);
          continue;
        }

        // Re-plan path if needed
        if (!state.path) {
          state.path = bfsPath(cellGrid, state.physics.x, state.physics.y, hx, hy);
          state.waypointIdx = 0;
        }

        // Compute input from genome + path + pheromone
        const { input: botInput, nextWaypointIdx } = computeBotInput(
          state.genome, state.path, state.waypointIdx, state.physics.x, state.physics.y, cellGrid,
        );
        state.waypointIdx = nextWaypointIdx;

        // Step physics
        state.physics = stepBotPhysics(state.physics, botInput.x, botInput.y, cellGrid, botDt);

        // Bot deposits pheromone
        depositPheromone(cellGrid, state.physics.x, state.physics.y, 0.05);

        await updatePlayerPosition(roomId, bot.id, state.physics.x, state.physics.y, progress).catch(console.error);
        botAIStates.set(bot.id, state);
      }
    }, 50);
    cleanupFns.push(() => clearInterval(botDriverId));

    lastFrameTime = performance.now();
    animFrameId = requestAnimationFrame(gameLoop);
  });

  onDestroy(() => {
    if (animFrameId) cancelAnimationFrame(animFrameId);
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
    style="max-width: 100%; display: block; margin: 0 auto;"
  />
  {#if gameState?.status === 'finished'}
    <div class="finished-overlay">
      <p>FINISHED! You reached the hole!</p>
    </div>
  {/if}
</div>

{#if inputSource === 'joystick'}
  <JoystickOverlay />
{/if}

<style>
  .game-container {
    position: relative;
    display: inline-block;
    width: 100%;
    max-width: 800px;
  }

  canvas {
    background: #1a1a2e;
  }

  .finished-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.6);
    pointer-events: none;
  }

  .finished-overlay p {
    color: #ffd700;
    font-size: 2rem;
    font-weight: bold;
    font-family: monospace;
    text-align: center;
    text-shadow: 0 0 20px rgba(255, 215, 0, 0.8);
    padding: 1rem 2rem;
  }
</style>
