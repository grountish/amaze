<script lang="ts">
  import Home from '$lib/components/Home.svelte';
  import RoomLobby from '$lib/components/RoomLobby.svelte';
  import GameScreen from '$lib/components/GameScreen.svelte';
  import { debugMode } from '$lib/stores/gameStore';
  import { onMount } from 'svelte';
  import type { InputSource } from '$lib/firebase/types';

  let screen: "home" | "lobby" | "game" = "home";
  let roomId: string = "";
  let playerName: string = "";
  let inputSource: InputSource = "keyboard";

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") === "true") {
      debugMode.set(true);
    }
  });

  function handleNavigate(event: CustomEvent) {
    const detail = event.detail;
    screen = detail.screen;
    roomId = detail.roomId;
    playerName = detail.playerName;
    inputSource = detail.inputSource;
  }

  function handleStart() {
    screen = "game";
  }

  function handleHome() {
    screen = "home";
    roomId = "";
    playerName = "";
    const isMobile = navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches;
    inputSource = isMobile ? "joystick" : "keyboard";
  }
</script>

{#if screen === "home"}
  <Home on:navigate={handleNavigate} />
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
</style>
