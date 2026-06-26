<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { subscribeToRoom, subscribeToPlayers, setPlayerReady, addBotPlayer, setRoomStatus } from "$lib/firebase/rooms";
  import { setupPresence } from "$lib/firebase/presence";
  import { players, currentPlayerId } from "$lib/stores/playerStore";
  import { room } from "$lib/stores/roomStore";
  import type { InputSource } from "$lib/firebase/types";

  export let roomId: string;
  export let playerName: string;
  export let inputSource: InputSource;

  const dispatch = createEventDispatcher();

  let countdown = 0;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let unsubRoom: (() => void) | null = null;
  let unsubPlayers: (() => void) | null = null;
  let cleanupPresence: (() => void) | null = null;
  let gameStarted = false;
  let isReady = false;

  $: myId = $currentPlayerId;
  $: me = $players.find((p) => p.id === myId);
  $: allReady = $players.length >= 2 && $players.every((p) => p.ready);
  $: isHost = $players.length > 0 && $players[0].id === myId;

  async function toggleReady() {
    if (!myId) return;
    isReady = !isReady;
    await setPlayerReady(roomId, myId, isReady);
  }

  async function handleAddBot() {
    await addBotPlayer(roomId);
  }

  function startCountdown() {
    countdown = 3;
    countdownTimer = setInterval(async () => {
      countdown--;
      if (countdown <= 0) {
        if (countdownTimer) clearInterval(countdownTimer);
        await setRoomStatus(roomId, "playing");
      }
    }, 1000);
  }

  $: if (allReady && myId && $room?.status === "waiting" && !countdownTimer) {
    setRoomStatus(roomId, "countdown");
  }

  $: if ($room?.status === "countdown" && !countdownTimer) {
    startCountdown();
  }

  $: if ($room?.status === "playing" && !gameStarted) {
    gameStarted = true;
    dispatch("start");
  }

  onMount(() => {
    unsubRoom = subscribeToRoom(roomId, (r) => room.set(r));
    unsubPlayers = subscribeToPlayers(roomId, (p) => players.set(p));
    if (myId) cleanupPresence = setupPresence(roomId, myId);
  });

  onDestroy(() => {
    unsubRoom?.();
    unsubPlayers?.();
    cleanupPresence?.();
    if (countdownTimer) clearInterval(countdownTimer);
  });
</script>

<div class="lobby">
  <div class="room-code">
    <span class="label">Room Code</span>
    <span class="code">{roomId}</span>
  </div>

  {#if $room?.status === "countdown"}
    <div class="countdown">{countdown}</div>
  {/if}

  <div class="players-section">
    <h2>Players ({$players.length})</h2>
    <ul class="player-list">
      {#each $players as player (player.id)}
        <li class="player-item" class:offline={!player.online}>
          <span class="player-name">
            {player.name}
            {#if player.id === myId}<span class="you">(you)</span>{/if}
          </span>
          <span class="player-meta">{player.inputSource}</span>
          <span class="ready-badge" class:ready={player.ready}>
            {player.ready ? "READY" : "waiting"}
          </span>
        </li>
      {/each}
    </ul>
  </div>

  <div class="actions">
    <button class="btn-ready" class:active={isReady} on:click={toggleReady}>
      {isReady ? "Not Ready" : "Ready Up"}
    </button>
    <button class="btn-bot" on:click={handleAddBot}>Add Bot</button>
  </div>

  {#if allReady && $room?.status === "waiting"}
    <p class="status-msg">All ready! Starting countdown...</p>
  {:else if $players.length < 2}
    <p class="status-msg">Waiting for more players...</p>
  {:else}
    <p class="status-msg">Waiting for all players to ready up...</p>
  {/if}
</div>

<style>
  .lobby {
    max-width: 480px;
    margin: 0 auto;
    padding: 2rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .room-code {
    background: #1e1e3a;
    border: 1px solid #3a3a6a;
    border-radius: 12px;
    padding: 1.5rem;
    text-align: center;
  }

  .label {
    display: block;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #8888aa;
    margin-bottom: 0.5rem;
  }

  .code {
    font-size: 2.5rem;
    font-weight: 700;
    letter-spacing: 0.3em;
    color: #a0a0ff;
    font-family: monospace;
  }

  .countdown {
    font-size: 6rem;
    font-weight: 900;
    text-align: center;
    color: #ffcc44;
    animation: pulse 0.5s ease-in-out infinite alternate;
  }

  @keyframes pulse {
    from { transform: scale(1); }
    to { transform: scale(1.1); }
  }

  h2 {
    font-size: 1rem;
    color: #8888aa;
    margin-bottom: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .player-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .player-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: #1e1e3a;
    border-radius: 8px;
    padding: 0.75rem 1rem;
  }

  .player-item.offline {
    opacity: 0.4;
  }

  .player-name {
    flex: 1;
    font-weight: 600;
  }

  .you {
    font-size: 0.75rem;
    color: #8888aa;
    font-weight: 400;
  }

  .player-meta {
    font-size: 0.75rem;
    color: #6666aa;
    text-transform: uppercase;
  }

  .ready-badge {
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    background: #333355;
    color: #8888aa;
    text-transform: uppercase;
  }

  .ready-badge.ready {
    background: #1a4a2a;
    color: #44dd88;
  }

  .actions {
    display: flex;
    gap: 0.75rem;
  }

  .btn-ready {
    flex: 1;
    padding: 0.875rem;
    border: none;
    border-radius: 10px;
    font-size: 1rem;
    font-weight: 700;
    background: #3333aa;
    color: #fff;
    transition: background 0.15s;
  }

  .btn-ready.active {
    background: #1a6a3a;
  }

  .btn-ready:hover {
    opacity: 0.9;
  }

  .btn-bot {
    padding: 0.875rem 1.25rem;
    border: 1px solid #3a3a6a;
    border-radius: 10px;
    font-size: 0.875rem;
    background: transparent;
    color: #8888aa;
  }

  .btn-bot:hover {
    background: #1e1e3a;
  }

  .status-msg {
    text-align: center;
    color: #8888aa;
    font-size: 0.875rem;
  }
</style>
