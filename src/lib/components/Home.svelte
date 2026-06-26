<script lang="ts">
  import { onMount, createEventDispatcher } from "svelte";
  import { initAuth } from "$lib/firebase/auth";
  import { ensureRoom, joinRoom, SINGLE_ROOM_ID } from "$lib/firebase/rooms";
  import { currentPlayerId } from "$lib/stores/playerStore";
  import type { InputSource } from "$lib/firebase/types";

  const dispatch = createEventDispatcher();

  let playerName = "";
  let inputSource: InputSource = "joystick";
  let error = "";
  let loading = false;

  onMount(() => {
    initAuth();
    const saved = localStorage.getItem("playerName");
    if (saved) playerName = saved;
  });

  async function handlePlay() {
    error = "";
    if (!playerName.trim()) {
      error = "Enter your name.";
      return;
    }
    loading = true;
    try {
      const playerId = $currentPlayerId;
      if (!playerId) {
        error = "Not authenticated yet. Try again.";
        return;
      }
      localStorage.setItem("playerName", playerName.trim());
      await ensureRoom(SINGLE_ROOM_ID);
      await joinRoom(SINGLE_ROOM_ID, playerName.trim(), inputSource);
      dispatch("navigate", {
        screen: "lobby",
        roomId: SINGLE_ROOM_ID,
        playerName: playerName.trim(),
        inputSource,
      });
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Failed to join.";
    } finally {
      loading = false;
    }
  }
</script>

<div class="home">
  <h1>Amaze</h1>

  <div class="form-group">
    <label for="playerName">Your Name</label>
    <input
      id="playerName"
      type="text"
      bind:value={playerName}
      placeholder="Enter your name"
      maxlength="24"
      disabled={loading}
    />
  </div>

  <div class="form-group">
    <label for="inputSource">Controls</label>
    <select id="inputSource" bind:value={inputSource} disabled={loading}>
      <option value="joystick">Joystick (mobile)</option>
      <option value="keyboard">Keyboard</option>
      <option value="motion">Motion (gyro)</option>
      <option value="bot">Bot</option>
    </select>
  </div>

  <button class="btn" on:click={handlePlay} disabled={loading}>
    {loading ? "..." : "Play"}
  </button>

  {#if error}
    <p class="error">{error}</p>
  {/if}
</div>

<style>
  .home {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 2rem;
    box-sizing: border-box;
    background: #0f0f0f;
    color: #f0f0f0;
    font-family: system-ui, sans-serif;
  }

  h1 {
    font-size: 3rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    margin: 0 0 2rem;
    color: #ffffff;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 320px;
    margin-bottom: 1rem;
  }

  label {
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #aaa;
    margin-bottom: 0.4rem;
  }

  input,
  select {
    padding: 0.65rem 0.9rem;
    border: 1px solid #333;
    border-radius: 6px;
    background: #1a1a1a;
    color: #f0f0f0;
    font-size: 1rem;
    outline: none;
    transition: border-color 0.15s;
    width: 100%;
    box-sizing: border-box;
  }

  input:focus,
  select:focus {
    border-color: #555;
  }

  input:disabled,
  select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn {
    width: 100%;
    max-width: 320px;
    padding: 0.75rem;
    margin-top: 0.5rem;
    border: none;
    border-radius: 6px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    background: #ffffff;
    color: #0f0f0f;
    transition: opacity 0.15s, transform 0.1s;
  }

  .btn:active {
    transform: scale(0.98);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .error {
    margin-top: 1rem;
    color: #ff6b6b;
    font-size: 0.9rem;
    text-align: center;
    max-width: 320px;
  }
</style>
