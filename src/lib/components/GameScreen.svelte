<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import GameCanvas from './GameCanvas.svelte';
  import Leaderboard from './Leaderboard.svelte';
  import SensorDebugPanel from './SensorDebugPanel.svelte';
  import MotionPermissionButton from './MotionPermissionButton.svelte';
  import { currentPlayerId, players } from '$lib/stores/playerStore';
  import { debugMode } from '$lib/stores/gameStore';
  import { room } from '$lib/stores/roomStore';
  import { subscribeToRoom, deleteRoom } from '$lib/firebase/rooms';
  import type { InputSource } from '$lib/firebase/types';

  const dispatch = createEventDispatcher();

  export let roomId: string;
  export let playerName: string;
  export let inputSource: InputSource;

  let showLeaderboard = false;
  let motionReady = false;
  let playerId: string | null = null;

  let hasDebugParam = false;
  let elapsedSeconds = 0;
  let timerInterval: ReturnType<typeof setInterval> | null = null;

  let unsubRoom: (() => void) | null = null;
  let unsubPlayerId: (() => void) | null = null;

  $: showDebug = $debugMode || hasDebugParam;
  // Live lap scoreboard (endless morph)
  $: scores = [...$players]
    .filter((p) => p.online)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  async function exitGame() {
    await deleteRoom(roomId);
    dispatch('home');
  }

  function startTimer(startedAt: number) {
    if (timerInterval) return;
    elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    timerInterval = setInterval(() => {
      elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    }, 1000);
  }

  onMount(() => {
    hasDebugParam = new URLSearchParams(window.location.search).has('debug');

    unsubPlayerId = currentPlayerId.subscribe((id) => {
      playerId = id;
    });

    unsubRoom = subscribeToRoom(roomId, (roomData) => {
      room.set(roomData);
      if (roomData?.status === 'finished') {
        showLeaderboard = true;
        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }
      }
      if (roomData?.status === 'playing' && roomData.startedAt) {
        startTimer(roomData.startedAt);
      }
    });
  });

  onDestroy(() => {
    unsubRoom?.();
    unsubPlayerId?.();
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  });
</script>

<div class="game-screen">
  {#if inputSource === 'motion' && !motionReady}
    <div class="permission-overlay">
      <MotionPermissionButton on:granted={() => (motionReady = true)} />
    </div>
  {:else}
    {#if playerId}
      <GameCanvas {roomId} {inputSource} playerId={playerId} />
    {/if}
  {/if}

  {#if showLeaderboard}
    <div class="leaderboard-overlay">
      <Leaderboard {roomId} />
      <button class="home-btn" on:click={async () => { await deleteRoom(roomId); dispatch('home'); }}>Back to Home</button>
    </div>
  {/if}

  {#if showDebug}
    <SensorDebugPanel />
  {/if}

  {#if $room?.startedAt}
    <div class="timer">
      {elapsedSeconds}s
    </div>
  {/if}

  {#if playerId && scores.length > 0}
    <div class="scoreboard">
      <div class="sb-title">Laps</div>
      {#each scores as p (p.id)}
        <div class="sb-row" class:me={p.id === playerId}>
          <span class="sb-name">{p.name}</span>
          <span class="sb-score">{p.score ?? 0}</span>
        </div>
      {/each}
    </div>
  {/if}

  <button class="exit-btn" on:click={exitGame}>Exit</button>
</div>

<style>
  .game-screen {
    position: relative;
    width: 100vw;
    height: 100vh;
    background: #0f0f0f;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .scoreboard {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    background: rgba(20, 20, 40, 0.82);
    border: 1px solid #3a3a6a;
    border-radius: 8px;
    padding: 0.4rem 0.6rem;
    min-width: 110px;
    color: #e8e8ff;
    font-size: 0.8rem;
    z-index: 20;
  }
  .sb-title {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8888aa;
    margin-bottom: 0.25rem;
  }
  .sb-row {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.1rem 0;
  }
  .sb-row.me .sb-name { color: #6ad06a; font-weight: 600; }
  .sb-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 90px; }
  .sb-score { font-variant-numeric: tabular-nums; font-weight: 700; }

  .exit-btn {
    position: absolute;
    top: 0.75rem;
    left: 0.75rem;
    background: rgba(40, 20, 20, 0.82);
    border: 1px solid #6a3a3a;
    color: #ffd0d0;
    border-radius: 8px;
    padding: 0.35rem 0.8rem;
    font-size: 0.8rem;
    cursor: pointer;
    z-index: 20;
  }
  .exit-btn:hover { background: rgba(80, 30, 30, 0.9); }

  .permission-overlay {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    color: #f0f0f0;
    font-family: system-ui, sans-serif;
  }

  .leaderboard-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.5rem;
    background: rgba(0, 0, 0, 0.8);
    z-index: 100;
  }

  .home-btn {
    padding: 0.75rem 2rem;
    background: #6366f1;
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
  }

  .home-btn:hover {
    background: #4f46e5;
  }

  .timer {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.6);
    color: #ffffff;
    font-family: monospace;
    font-size: 1.25rem;
    font-weight: bold;
    padding: 4px 14px;
    border-radius: 6px;
    z-index: 10;
    letter-spacing: 0.05em;
  }
</style>
