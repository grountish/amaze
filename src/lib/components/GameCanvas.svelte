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
  import { updatePlayerPosition, winLap, subscribeToRoom, subscribeToPlayers, enterShortcut, exitShortcut, subscribeToShortcut, updateMazeGrid, subscribeToMazeGrid, syncNutrients, collectNutrient, subscribeToNutrients, addTrap, triggerTrap, subscribeToTraps } from '$lib/firebase/rooms';
  import type { LocalGameState, GameInput, Maze } from '$lib/game/types';
  import type { InputSource, ShortcutState, TrapData } from '$lib/firebase/types';
  import { createCellGrid, initGridFromMaze, protectZone, depositPheromone, decayPheromone, evolveGrid, serializeWalls, deserializeWalls, getLocalWalls, findNutrientPositions, pickTrapCell, GRID_COLS, GRID_ROWS, CELL_SIZE, EVOLUTION_INTERVAL } from '$lib/game/cellularMaze';
  import type { CellGrid, NutrientData } from '$lib/game/cellularMaze';
  import { defaultGenome, mutate, bfsPath, computeBotInput, stepBotPhysics, isStuck, createHazard, recordDeath, createKnown, revealAround } from '$lib/game/botAI';
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
  // Active procedural maze (changes each lap in endless morph)
  let activeMaze: Maze = defaultMaze;
  let currentSeed = DEFAULT_SEED;
  let currentLap = 0;
  let lapInitialized = false; // skip the winner flash on first room sync (refresh)
  let lapWinSent = false; // guard: one winLap call per lap
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
    hazard: Float32Array; // learned death map, carried across resets
    known: Uint8Array;    // fog-of-war discovered cells, carried across resets
    replanAt: number;     // next time this bot may recompute its path
  };
  const botAIStates = new Map<string, BotAIState>();
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

    const maze = activeMaze;

    // Clear with dark background
    ctx.fillStyle = '#06060f';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    const drawNow = Date.now();

    if (cellGrid) {
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
      for (const wall of activeMaze.walls) {
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

      const color = getPlayerColor(player.id);
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
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
          depositPheromone(cellGrid, pl.x, pl.y, 0.08);
        }
        decayPheromone(cellGrid, deltaTime);

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
            evolveGrid(cellGrid, activeMaze);
            updateMazeGrid(roomId, serializeWalls(cellGrid.walls)).catch(console.error);
            const candidates = findNutrientPositions(cellGrid, 3);
            syncNutrients(roomId, candidates).catch(console.error);

            // Often place a trap on a hot-path cell
            if (Math.random() < 0.6) {
              const existingTrapCells = Object.values(traps);
              const trapCell = pickTrapCell(cellGrid, activeMaze, existingTrapCells);
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
                position: { ...activeMaze.startPosition },
                velocity: { x: 0, y: 0 },
              },
              progress: 0,
            };
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

      // Reached the hole → win this lap (endless morph). The maze regenerates
      // for everyone via the room's seed; we keep playing until the broadcast
      // resets positions. lapWinSent guards one win per lap.
      if (gameState.status === 'finished' && !lapWinSent) {
        lapWinSent = true;
        winLap(roomId, playerId, currentLap, Date.now()).catch(console.error);
        // Unfreeze locally so the ball isn't stuck "finished" before the reset
        gameState = { ...gameState, status: 'playing' };
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
      st.physics = { x: activeMaze.startPosition.x, y: activeMaze.startPosition.y, vx: 0, vy: 0 };
      st.path = null;
      st.waypointIdx = 0;
      st.lastProgress = 0;
      st.lastProgressTime = Date.now();
      st.hazard = createHazard();
      st.known = createKnown(); // new maze ⇒ explore from scratch
      st.replanAt = 0;
    }
    lapWinSent = false;
  }

  onMount(() => {
    const initial = createInitialGameState(activeMaze);
    gameStartTime = Date.now();
    gameState = { ...initial, status: 'playing', startedAt: gameStartTime };
    localGame.set(gameState);

    // Initialise evolving grid
    cellGrid = createCellGrid();
    initGridFromMaze(cellGrid, activeMaze);
    if (activeMaze.shortcut) protectZone(cellGrid, activeMaze.shortcut.zone);

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
      // Watch the room's maze seed — when it changes (someone won a lap),
      // morph the maze for everyone and flash the winner.
      subscribeToRoom(roomId, (r) => {
        if (!r) return;
        const newLap = r.lap ?? 0;
        const prevLap = currentLap;
        const firstSync = !lapInitialized;
        currentLap = newLap;
        lapInitialized = true;
        const seed = seedFromMazeId(r.mazeId);
        if (seed !== currentSeed) {
          applyMaze(seed);
          // Flash only on a real lap advance — not the initial sync on (re)load,
          // which would otherwise replay the persisted winner ("You won lap 7").
          if (!firstSync && newLap > prevLap && newLap > 0 && r.lastWinnerId) {
            const w = get(players).find((p) => p.id === r.lastWinnerId);
            const who = r.lastWinnerId === playerId ? 'You' : (w?.name ?? 'Bot');
            lapFlash = `${who} won lap ${newLap}!`;
            if (lapFlashTimer) clearTimeout(lapFlashTimer);
            lapFlashTimer = setTimeout(() => { lapFlash = ''; }, 1800);
          }
        }
      }),

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
        for (const pl of p) {
          // Init bot AI state as soon as we see a bot
          if (pl.inputSource === 'bot' && pl.id !== playerId && !botAIStates.has(pl.id)) {
            botAIStates.set(pl.id, {
              genome: defaultGenome(),
              physics: { x: activeMaze.startPosition.x, y: activeMaze.startPosition.y, vx: 0, vy: 0 },
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

      for (const bot of bots) {
        let state = botAIStates.get(bot.id);
        if (!state) continue;

        // Progress towards hole
        const hx = activeMaze.hole.x, hy = activeMaze.hole.y;
        const sx = activeMaze.startPosition.x, sy = activeMaze.startPosition.y;
        const dpx = state.physics.x - sx, dpy = state.physics.y - sy;
        const totalDist = Math.sqrt((hx - sx) ** 2 + (hy - sy) ** 2);
        const progress = Math.min(100, (Math.sqrt(dpx * dpx + dpy * dpy) / totalDist) * 100);
        const dHx = state.physics.x - hx, dHy = state.physics.y - hy;

        // Reached hole? → bot wins the lap (endless morph). Don't delete the
        // bot state; the maze regen broadcast resets all bots to start.
        if (Math.sqrt(dHx * dHx + dHy * dHy) < activeMaze.hole.radius - 6) {
          if (!lapWinSent) {
            lapWinSent = true;
            winLap(roomId, bot.id, currentLap, nowMs).catch(console.error);
          }
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
              physics: { x: sx, y: sy, vx: 0, vy: 0 },
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
            physics: { x: sx, y: sy, vx: 0, vy: 0 },
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

        // Re-plan if pathless OR the cooldown elapsed — the latter lets the bot
        // react to walls it just discovered through the fog. Hazard map steers
        // around past deaths; known map gates what counts as a wall.
        if (!state.path || nowMs >= state.replanAt) {
          state.path = bfsPath(cellGrid, state.physics.x, state.physics.y, hx, hy, state.hazard, state.known);
          state.waypointIdx = 0;
          state.replanAt = nowMs + 600;
        }

        // Compute input from genome + path + pheromone
        const { input: botInput, nextWaypointIdx } = computeBotInput(
          state.genome, state.path, state.waypointIdx, state.physics.x, state.physics.y, cellGrid,
        );
        state.waypointIdx = nextWaypointIdx;

        // Step physics, then reveal the cells we moved into
        state.physics = stepBotPhysics(state.physics, botInput.x, botInput.y, cellGrid, botDt);
        revealAround(state.known, state.physics.x, state.physics.y);

        // Bot deposits pheromone
        depositPheromone(cellGrid, state.physics.x, state.physics.y, 0.1);

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
    style="max-width: 100%; display: block; margin: 0 auto;"
  />
  {#if lapFlash}
    <div class="lap-banner">{lapFlash}</div>
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
</style>
