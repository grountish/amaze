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
  import { startBotProgressLoop } from '$lib/input/botInput';
  import { updatePlayerPosition, finishPlayer, subscribeToPlayers, enterShortcut, exitShortcut, subscribeToShortcut } from '$lib/firebase/rooms';
  import type { LocalGameState, GameInput, Maze } from '$lib/game/types';
  import type { InputSource, ShortcutState } from '$lib/firebase/types';

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
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Draw walls
    ctx.fillStyle = '#4a4a6a';
    for (const wall of maze.walls) {
      ctx.fillRect(wall.x, wall.y, wall.width, wall.height);
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
      ctx.fillText(player.name, px, py - 16);
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

    // Draw progress text bottom-left
    if (gameState) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '16px monospace';
      ctx.fillText(`Progress: ${Math.round(gameState.progress)}%`, 30, CANVAS_HEIGHT - 30);
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
      // If shortcut is collapsed, inject its gap wall into physics
      const nowMs = Date.now();
      const shortcutCollapsed =
        defaultMaze.shortcut != null &&
        shortcutState?.collapseUntil != null &&
        shortcutState.collapseUntil > nowMs;
      const activeMaze = shortcutCollapsed
        ? { ...defaultMaze, walls: [...defaultMaze.walls, defaultMaze.shortcut!.gapWall] }
        : defaultMaze;
      gameState = updateGame(gameState, activeMaze, currentInput, deltaTime);

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

    if (inputSource === 'keyboard') {
      cleanupFns.push(startKeyboardInput());
    } else if (inputSource === 'motion') {
      cleanupFns.push(startMotionInput());
    } else if (inputSource === 'bot') {
      cleanupFns.push(
        startBotProgressLoop((progress) => {
          if (finishedSynced) return;

          gameState = { ...gameState, progress };

          if (progress >= 100) {
            gameState = {
              ...gameState,
              status: 'finished',
              progress: 100,
              finishedAt: Date.now(),
            };
            finishedSynced = true;
            localGame.set(gameState);
            const timeMs = Date.now() - gameStartTime;
            finishPlayer(roomId, playerId, timeMs).catch(console.error);
          } else {
            localGame.set(gameState);
            const now = performance.now();
            if (now - lastProgressSync > POSITION_SYNC_THROTTLE) {
              const { x, y } = gameState.ball.position;
              const dx = x - lastSyncedPos.x;
              const dy = y - lastSyncedPos.y;
              if (dx * dx + dy * dy >= 4) {
                lastProgressSync = now;
                lastSyncedPos = { x, y };
                updatePlayerPosition(roomId, playerId, x, y, progress).catch(console.error);
              }
            }
          }
        })
      );
    }

    // Keep players store live during the game (lobby subscription died on unmount)
    // Also drive any bot players: write their progress+position to Firebase at fixed pace
    const botIntervals: ReturnType<typeof setInterval>[] = [];
    cleanupFns.push(
      subscribeToShortcut(roomId, (s) => { shortcutState = s; }),

      subscribeToPlayers(roomId, (p) => {
        players.set(p);
        // Append received positions to pheromone trail history
        const t = Date.now();
        for (const pl of p) {
          if (pl.id === playerId || pl.x == null || pl.y == null) continue;
          const trail = opponentTrails.get(pl.id) ?? [];
          trail.push({ x: pl.x, y: pl.y, t });
          if (trail.length > TRAIL_MAX_POINTS) trail.shift();
          opponentTrails.set(pl.id, trail);
        }


        // Start a driver interval for any bot we haven't started yet
        const bots = p.filter((pl) => pl.inputSource === 'bot' && pl.finishedAt == null);
        if (bots.length > botIntervals.length) {
          for (const bot of bots.slice(botIntervals.length)) {
            const startedAt = Date.now();
            const id = setInterval(async () => {
              const elapsed = Date.now() - startedAt;
              const progress = Math.min(100, (elapsed / 35000) * 100); // ~35s to finish
              const t = progress / 100;
              const bx = Math.round(defaultMaze.startPosition.x + (defaultMaze.hole.x - defaultMaze.startPosition.x) * t);
              const by = Math.round(defaultMaze.startPosition.y + (defaultMaze.hole.y - defaultMaze.startPosition.y) * t);
              if (progress >= 100) {
                clearInterval(id);
                await finishPlayer(roomId, bot.id, elapsed).catch(console.error);
              } else {
                await updatePlayerPosition(roomId, bot.id, bx, by, progress).catch(console.error);
              }
            }, 200);
            botIntervals.push(id);
          }
        }
      }),
      () => { for (const id of botIntervals) clearInterval(id); },
    );

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
