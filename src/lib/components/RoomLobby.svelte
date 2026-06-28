<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { subscribeToRoom, subscribeToPlayers, setPlayerReady, setBotCount, startGame, resetRoom, joinRoom } from "$lib/firebase/rooms";
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
  let botCount = 0;
  let botCountInit = false; // seed the input from the room's current bots once
  let botSyncBusy = false;
  let botPending = false;
  let restarting = false;
  // True if a game was already in progress when we arrived — then we don't
  // auto-enter; the user explicitly chooses Join Game or Restart for all.
  let lateArrival = false;
  let statusChecked = false;

  $: myId = $currentPlayerId;
  $: me = $players.find((p) => p.id === myId);
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

  // The bot input is the source of truth: reconcile the room to its value.
  // Coalesces rapid edits so the room converges to the latest number.
  async function syncBots() {
    botCount = Math.max(0, Math.min(50, Math.floor(botCount) || 0));
    if (botSyncBusy) { botPending = true; return; }
    botSyncBusy = true;
    try {
      do {
        botPending = false;
        await setBotCount(roomId, botCount);
      } while (botPending);
    } finally {
      botSyncBusy = false;
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

  // Explicitly enter a game already in progress.
  function joinGame() {
    gameStarted = true;
    dispatch("start");
  }

  // Restart for all: wipe players, bots and level, then re-join a fresh lobby.
  async function handleRestart() {
    if (!myId) return;
    restarting = true;
    try {
      await resetRoom(roomId);
      await joinRoom(roomId, playerName, inputSource);
      isReady = false;
      gameStarted = false;
      lateArrival = false;
    } finally {
      restarting = false;
    }
  }

  // Auto-enter only when WE drove the room into "playing" (not when we arrived
  // to a game already running — that case shows an explicit Join Game button).
  $: if ($room?.status === "playing" && !gameStarted && !lateArrival) {
    gameStarted = true;
    dispatch("start");
  }

  onMount(() => {
    unsubRoom = subscribeToRoom(roomId, (r) => {
      room.set(r);
      if (!statusChecked && r) {
        lateArrival = r.status === "playing";
        statusChecked = true;
      }
    });
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
  // Seed the bot input from the room's current bots once (e.g. rejoining).
  $: if (!botCountInit && $players.length > 0) { botCount = botList.length; botCountInit = true; }
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
      <label class="bot-label" for="botCount">Bots</label>
      <input
        id="botCount"
        class="bot-count"
        type="number"
        min="0"
        max="50"
        bind:value={botCount}
        on:change={syncBots}
        aria-label="Number of bots"
      />
    </div>
  </div>

  {#if $room?.status === "playing"}
    <button class="btn-start" on:click={joinGame}>Join Game in progress</button>
  {:else}
    <button class="btn-start" on:click={handleStartNow} disabled={!startable}>
      Start Game
    </button>
  {/if}

  <button class="btn-restart" on:click={handleRestart} disabled={restarting}>
    {restarting ? "Restarting…" : "Restart for all"}
  </button>

  {#if $room?.status === "playing"}
    <p class="status-msg">A game is in progress. Join it, or restart for everyone.</p>
  {:else if !allReady}
    <p class="status-msg">Ready up, or just press Start.</p>
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

  .bot-add {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .bot-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: #8888aa;
    text-transform: uppercase;
    letter-spacing: 0.05em;
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

  .btn-restart {
    width: 100%;
    padding: 0.65rem;
    border: 1px solid #6a3a3a;
    border-radius: 10px;
    font-size: 0.9rem;
    font-weight: 600;
    background: transparent;
    color: #d68a8a;
  }

  .btn-restart:hover:not(:disabled) {
    background: rgba(80, 30, 30, 0.4);
  }

  .btn-restart:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .status-msg {
    text-align: center;
    color: #8888aa;
    font-size: 0.875rem;
  }
</style>
