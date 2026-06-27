<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { subscribeToRoom, subscribeToPlayers, setPlayerReady, addBotPlayer, startGame } from "$lib/firebase/rooms";
  import { setupPresence } from "$lib/firebase/presence";
  import { players, currentPlayerId } from "$lib/stores/playerStore";
  import { room } from "$lib/stores/roomStore";
  import type { InputSource } from "$lib/firebase/types";

  export let roomId: string;
  export let playerName: string;
  export let inputSource: InputSource;

  const dispatch = createEventDispatcher();

  let unsubRoom: (() => void) | null = null;
  let unsubPlayers: (() => void) | null = null;
  let cleanupPresence: (() => void) | null = null;
  let gameStarted = false;
  let isReady = false;
  let botCount = 1;
  let addingBots = false;

  $: myId = $currentPlayerId;
  $: me = $players.find((p) => p.id === myId);
  $: isHost = $players.length > 0 && $players[0].id === myId;
  // Startable = a room exists that isn't already running or done. Guarding on
  // "not playing/finished" (instead of exactly "waiting") also recovers a
  // shared room left stuck in a stale status by a previous session.
  $: startable = !!$room && $room.status !== "playing" && $room.status !== "finished";
  // Auto-start only in multiplayer: everyone present has readied up.
  $: allReady = $players.length >= 2 && $players.every((p) => p.ready);

  async function toggleReady() {
    if (!myId) return;
    isReady = !isReady;
    await setPlayerReady(roomId, myId, isReady);
  }

  async function handleAddBots() {
    const n = Math.max(1, Math.min(50, Math.floor(botCount) || 1));
    addingBots = true;
    try {
      for (let i = 0; i < n; i++) await addBotPlayer(roomId);
    } finally {
      addingBots = false;
    }
  }

  // No countdown — multiplayer auto-starts once everyone is ready.
  $: if (allReady && myId && startable) {
    startGame(roomId);
  }

  // Host can force-start at any time (e.g. solo, or before laggards ready up).
  function handleStartNow() {
    if (myId && startable) startGame(roomId);
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
  });

  // Humans listed individually; bots collapsed into a single anonymous count.
  $: humans = $players.filter((p) => p.inputSource !== "bot");
  $: botList = $players.filter((p) => p.inputSource === "bot");
</script>

<div class="lobby">
  <div class="room-code">
    <span class="label">Room Code</span>
    <span class="code">{roomId}</span>
  </div>

  <div class="players-section">
    <h2>Players ({$players.length})</h2>
    <ul class="player-list">
      {#each humans as player (player.id)}
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
      {#if botList.length > 0}
        <li class="player-item">
          <span class="player-name">Bots ×{botList.length}</span>
          <span class="player-meta">bot</span>
          <span class="ready-badge ready">READY</span>
        </li>
      {/if}
    </ul>
  </div>

  <div class="actions">
    <button class="btn-ready" class:active={isReady} on:click={toggleReady}>
      {isReady ? "Not Ready" : "Ready Up"}
    </button>
    <div class="bot-add">
      <input
        class="bot-count"
        type="number"
        min="1"
        max="50"
        bind:value={botCount}
        aria-label="Number of bots"
      />
      <button class="btn-bot" on:click={handleAddBots} disabled={addingBots}>
        {addingBots ? "Adding…" : "Add Bots"}
      </button>
    </div>
  </div>

  {#if isHost}
    <button class="btn-start" on:click={handleStartNow} disabled={!startable}>
      Start Game
    </button>
  {/if}

  {#if !isHost && $players.length < 2}
    <p class="status-msg">Waiting for the host to start...</p>
  {:else if !allReady}
    <p class="status-msg">Ready up — host can start any time.</p>
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

  .btn-bot:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .bot-add {
    display: flex;
    gap: 0.5rem;
    align-items: stretch;
  }

  .bot-count {
    width: 4rem;
    padding: 0.5rem;
    border: 1px solid #3a3a6a;
    border-radius: 10px;
    background: #14142a;
    color: #e8e8ff;
    font-size: 0.875rem;
    text-align: center;
  }

  .btn-start {
    width: 100%;
    padding: 0.95rem;
    border: none;
    border-radius: 10px;
    font-size: 1.05rem;
    font-weight: 800;
    letter-spacing: 0.03em;
    background: #1a6a3a;
    color: #fff;
  }

  .btn-start:hover:not(:disabled) {
    background: #228a4a;
  }

  .btn-start:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .status-msg {
    text-align: center;
    color: #8888aa;
    font-size: 0.875rem;
  }
</style>
