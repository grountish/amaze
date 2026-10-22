<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  // Where the pill sits: lobby → top-right corner; game → next to the Exit button.
  export let placement: "lobby" | "game" = "lobby";

  const STATIONS = [
    { name: "MSX Tribute Radio", short: "MSX Radio", url: "https://radio.juliomarchi.com/listen/msxall/msx-tribute-radio.mp3" },
    { name: "Gamesboro Radio", short: "Gamesboro", url: "https://radio.gamesboro.org/listen/gamesboro_radio/radio.mp3" },
  ];

  let audio: HTMLAudioElement;
  let status: "paused" | "loading" | "playing" | "error" = "paused";
  let stationIdx = 0;
  $: station = STATIONS[stationIdx];

  async function play() {
    status = "loading";
    // Live stream: attach the source only on play, so nothing downloads until asked.
    audio.src = STATIONS[stationIdx].url; // not `station`: reactive, lags a tick after nextStation
    setMediaMetadata();
    try {
      await audio.play();
    } catch {
      status = "error";
    }
  }

  function pause() {
    audio.pause();
    // Drop the connection so a paused live stream stops downloading; resuming
    // rejoins the broadcast live instead of replaying a stale buffer.
    audio.removeAttribute("src");
    audio.load();
    status = "paused";
  }

  function toggle() {
    if (status === "playing" || status === "loading") pause();
    else play();
  }

  // Cycle stations; if something was playing (or failing), tune straight in.
  function nextStation() {
    const wasOn = status !== "paused";
    if (wasOn) pause();
    stationIdx = (stationIdx + 1) % STATIONS.length;
    try { localStorage.setItem("radioStation", String(stationIdx)); } catch { /* storage blocked */ }
    if (wasOn) play();
  }

  function setMediaMetadata() {
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: STATIONS[stationIdx].name, artist: "Live radio" });
    }
  }

  // M toggles the radio anywhere — except while typing in a field.
  function onKey(e: KeyboardEvent) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== "m") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    toggle();
  }

  onMount(() => {
    try {
      const saved = Number(localStorage.getItem("radioStation"));
      if (saved >= 0 && saved < STATIONS.length) stationIdx = saved;
    } catch { /* storage blocked */ }
    window.addEventListener("keydown", onKey);
    // OS / lock-screen media controls.
    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", play);
      navigator.mediaSession.setActionHandler("pause", pause);
      navigator.mediaSession.setActionHandler("nexttrack", nextStation);
    }
  });

  onDestroy(() => {
    window.removeEventListener("keydown", onKey);
    if (audio) pause();
  });

  $: label = status === "playing" ? `Pause ${station.name}` : status === "loading" ? "Stop loading radio" : `Play ${station.name}`;
</script>

<audio
  bind:this={audio}
  preload="none"
  on:playing={() => (status = "playing")}
  on:waiting={() => { if (status === "playing") status = "loading"; }}
  on:pause={() => { if (status === "playing") status = "paused"; }}
  on:error={() => { if (status !== "paused") status = "error"; }}
/>

<div
  class="radio {placement}"
  class:on={status === "playing"}
  class:err={status === "error"}
  role="group"
  aria-label="Radio"
>
  <button class="play" on:click={toggle} aria-label={label} aria-pressed={status === "playing"} title="{label} (M)">
    <span class="ico" aria-hidden="true">
      {#if status === "playing"}
        <span class="eq"><i /><i /><i /></span>
      {:else if status === "loading"}
        <span class="spin" />
      {:else}
        <svg viewBox="0 0 12 12"><path d="M3 1.5v9l7.5-4.5z" /></svg>
      {/if}
    </span>
    <span class="txt">
      {#if status === "error"}{station.short} offline · retry{:else}{station.short}{/if}
    </span>
    {#if status === "playing"}<span class="live">LIVE</span>{/if}
  </button>
  <button class="next" on:click={nextStation} aria-label="Next station" title="Next station">
    <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2v8l5-4zM7 2v8l5-4z" /></svg>
  </button>
</div>

<style>
  .radio {
    position: fixed;
    /* Above the full-screen touch joystick layer (z 50). */
    z-index: 60;
    display: inline-flex;
    align-items: stretch;
    border-radius: 999px;
    border: 1px solid #2a2a4c;
    background: rgba(21, 21, 42, 0.88);
    color: #e8e8ff;
    font: 600 0.82rem/1 system-ui, sans-serif;
    overflow: hidden;
    transition: border-color 0.15s;
  }
  .radio.on { border-color: rgba(124, 124, 255, 0.55); }
  .radio.err { border-color: rgba(224, 122, 122, 0.5); color: #f0b0b0; }

  .radio.lobby { top: 1rem; right: 1rem; }
  /* In game: same row as the Exit button (top-left), just to its right. */
  .radio.game { top: 0.75rem; left: 4.6rem; font-size: 0.75rem; }

  button {
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.15s;
  }
  button:hover { background: rgba(255, 255, 255, 0.06); }

  .play {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.4rem 0.7rem 0.4rem 0.45rem;
  }
  .game .play { padding: 0.28rem 0.6rem 0.28rem 0.35rem; }

  .next {
    display: grid;
    place-items: center;
    padding: 0 0.6rem;
    border-left: 1px solid #2a2a4c;
    color: #b7b7ff;
  }
  .next svg { width: 11px; height: 11px; fill: currentColor; }

  .ico {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: #7c7cff;
    color: #0b0b1a;
    flex-shrink: 0;
  }
  .game .ico { width: 18px; height: 18px; }
  .ico svg { width: 10px; height: 10px; fill: currentColor; margin-left: 1px; }

  .eq { display: flex; align-items: flex-end; gap: 1.5px; height: 10px; }
  .eq i {
    width: 2.5px;
    height: 100%;
    background: currentColor;
    border-radius: 1px;
    transform-origin: bottom;
    animation: eq 0.9s ease-in-out infinite;
  }
  .eq i:nth-child(2) { animation-delay: -0.3s; }
  .eq i:nth-child(3) { animation-delay: -0.6s; }
  @keyframes eq {
    0%, 100% { transform: scaleY(0.3); }
    50% { transform: scaleY(1); }
  }

  .spin {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid rgba(11, 11, 26, 0.3);
    border-top-color: #0b0b1a;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .live {
    font-size: 0.6rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    color: #ff6b6b;
  }

  @media (prefers-reduced-motion: reduce) {
    .eq i, .spin { animation: none; }
    .eq i { transform: scaleY(0.7); }
  }
  /* Narrow lobby: icon-only so it never crowds the title. */
  @media (max-width: 480px) {
    .lobby .txt, .lobby .live { display: none; }
    .lobby .play { padding: 0.35rem; }
  }
</style>
