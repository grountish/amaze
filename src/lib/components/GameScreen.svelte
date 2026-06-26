<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import GameCanvas from './GameCanvas.svelte';
  import Leaderboard from './Leaderboard.svelte';
  import SensorDebugPanel from './SensorDebugPanel.svelte';
  import MotionPermissionButton from './MotionPermissionButton.svelte';
  import { currentPlayerId } from '$lib/stores/playerStore';
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
