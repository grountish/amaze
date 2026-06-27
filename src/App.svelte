<script lang="ts">
  import RoomLobby from '$lib/components/RoomLobby.svelte';
  import GameScreen from '$lib/components/GameScreen.svelte';
  import { debugMode } from '$lib/stores/gameStore';
  import { initAuth } from '$lib/firebase/auth';
  import { ensureRoom, joinRoom, SINGLE_ROOM_ID } from '$lib/firebase/rooms';
  import { onMount } from 'svelte';
  import type { InputSource } from '$lib/firebase/types';

  let screen: "loading" | "lobby" | "game" = "loading";
  let roomId: string = "";
  let playerName: string = "";
  let inputSource: InputSource = "keyboard";
  let error = "";

  function inferControls(): InputSource {
    const isMobile = navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches;
    return isMobile ? "joystick" : "keyboard";
  }

  function defaultName(): string {
    const saved = localStorage.getItem("playerName");
    if (saved) return saved;
    const name = `Player${Math.floor(1000 + Math.random() * 9000)}`;
    localStorage.setItem("playerName", name);
    return name;
  }

  async function autoJoin() {
    error = "";
    screen = "loading";
    try {
      inputSource = inferControls();
      playerName = defaultName();
      await initAuth();
      await ensureRoom(SINGLE_ROOM_ID);
      await joinRoom(SINGLE_ROOM_ID, playerName, inputSource);
      roomId = SINGLE_ROOM_ID;
      screen = "lobby";
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Failed to join.";
    }
  }

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") === "true") debugMode.set(true);
    autoJoin();
  });

  function handleStart() {
    screen = "game";
  }

  // No home screen — leaving a game drops back into the lobby.
  function handleHome() {
    inputSource = inferControls();
    autoJoin();
  }
</script>

{#if screen === "loading"}
  <div class="splash">
    <h1>Amaze</h1>
    {#if error}
      <p class="error">{error}</p>
      <button class="retry" on:click={autoJoin}>Retry</button>
    {:else}
      <p class="hint">Joining…</p>
    {/if}
  </div>
{/if}
{#if screen === "lobby"}
  <RoomLobby {roomId} {playerName} {inputSource} on:start={handleStart} />
{/if}
{#if screen === "game"}
  <GameScreen {roomId} {playerName} {inputSource} on:home={handleHome} />
{/if}

<style>
  :global(*) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) { background: #0f0f1a; color: #e0e0ff; font-family: system-ui, sans-serif; min-height: 100vh; }
  :global(button) { cursor: pointer; }

  .splash {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    min-height: 100vh;
    padding: 2rem;
  }
  .splash h1 {
    font-size: 3rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    color: #fff;
  }
  .hint { color: #8888aa; }
  .error { color: #ff6b6b; text-align: center; max-width: 320px; }
  .retry {
    padding: 0.6rem 1.5rem;
    border: none;
    border-radius: 8px;
    background: #3333aa;
    color: #fff;
    font-weight: 600;
  }
</style>
