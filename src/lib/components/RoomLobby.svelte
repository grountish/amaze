<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { subscribeToRoom, subscribeToPlayers, setPlayerReady, setBotCount, startGame, resetRoom, joinRoom, setPlayerName } from "$lib/firebase/rooms";
  import { setupPresence } from "$lib/firebase/presence";
  import { players, currentPlayerId } from "$lib/stores/playerStore";
  import { room } from "$lib/stores/roomStore";
  import type { InputSource, BotTeam } from "$lib/firebase/types";

  export let roomId: string;
  export let playerName: string;
  export let inputSource: InputSource;

  const dispatch = createEventDispatcher();

  let unsubRoom: (() => void) | null = null;
  let unsubPlayers: (() => void) | null = null;
  let cleanupPresence: (() => void) | null = null;
  let gameStarted = false;
  let isReady = false;
  // Bot counts per team (enemy = classic bots; ally = fights for the humans).
  let botCount = 0;
  let allyCount = 0;
  let botCountInit = false; // seed the inputs from the room's current bots once
  const botSyncBusy: Record<BotTeam, boolean> = { enemy: false, ally: false };
  const botPending: Record<BotTeam, boolean> = { enemy: false, ally: false };
  let restarting = false;
  // True if a game was already in progress when we arrived — then we don't
  // auto-enter; the user explicitly chooses Join Game or Restart for all.
  let lateArrival = false;
  let statusChecked = false;

  // Editable display name (committed on blur / Enter).
  let nameDraft = playerName;
  let nameSaved = false;
  let nameSavedTimer: ReturnType<typeof setTimeout> | null = null;

  // How-to-play panel tab. Controls tab opens on the device's own scheme.
  type Tab = "goal" | "controls" | "field";
  let tab: Tab = "goal";
  const touchFirst = inputSource === "joystick";

  $: myId = $currentPlayerId;
  $: me = $players.find((p) => p.id === myId);
  // Startable = a room exists that isn't already running or done. Guarding on
  // "not playing/finished" (instead of exactly "waiting") also recovers a
  // shared room left stuck in a stale status by a previous session.
  $: startable = !!$room && $room.status !== "playing" && $room.status !== "finished";
  // Auto-start only in multiplayer: everyone present has readied up.
  $: allReady = $players.length >= 2 && $players.every((p) => p.ready);
  $: inProgress = $room?.status === "playing";

  async function toggleReady() {
    if (!myId) return;
    isReady = !isReady;
    await setPlayerReady(roomId, myId, isReady);
  }

  const clampBots = (n: number) => Math.max(0, Math.min(50, Math.floor(n) || 0));

  // The bot inputs are the source of truth: reconcile the room to their values.
  // Coalesces rapid edits (per team) so the room converges to the latest number.
  async function syncBots(team: BotTeam) {
    botCount = clampBots(botCount);
    allyCount = clampBots(allyCount);
    if (botSyncBusy[team]) { botPending[team] = true; return; }
    botSyncBusy[team] = true;
    try {
      do {
        botPending[team] = false;
        await setBotCount(roomId, team === "ally" ? allyCount : botCount, team);
      } while (botPending[team]);
    } finally {
      botSyncBusy[team] = false;
    }
  }

  function stepBots(team: BotTeam, delta: number) {
    if (team === "ally") allyCount = clampBots(allyCount + delta);
    else botCount = clampBots(botCount + delta);
    syncBots(team);
  }

  async function commitName() {
    const name = nameDraft.trim().slice(0, 24);
    if (!name) { nameDraft = playerName; return; }
    if (name === playerName || !myId) return;
    playerName = name;
    nameDraft = name;
    localStorage.setItem("playerName", name);
    dispatch("rename", name);
    await setPlayerName(roomId, myId, name);
    nameSaved = true;
    if (nameSavedTimer) clearTimeout(nameSavedTimer);
    nameSavedTimer = setTimeout(() => (nameSaved = false), 1400);
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
    if (nameSavedTimer) clearTimeout(nameSavedTimer);
  });

  // Humans listed individually; bots collapsed into a single anonymous count.
  $: humans = $players.filter((p) => p.inputSource !== "bot");
  $: botList = $players.filter((p) => p.inputSource === "bot");
  $: allyList = botList.filter((p) => p.team === "ally");
  $: enemyList = botList.filter((p) => p.team !== "ally");
  // Seed the bot inputs from the room's current bots once (e.g. rejoining).
  $: if (!botCountInit && $players.length > 0) {
    botCount = enemyList.length;
    allyCount = allyList.length;
    botCountInit = true;
  }

  const CONTROL_LABEL: Record<InputSource, string> = {
    keyboard: "Keyboard",
    joystick: "Touch",
    motion: "Tilt",
    bot: "Bot",
  };
</script>

<div class="start">
  <header class="hero">
    <svg class="mark" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="14" class="mark-bg" />
      <path d="M13 25V13h38v38H13V39M42 29v-7H22v20h20v-5" class="mark-walls" />
      <circle cx="32" cy="32" r="4.5" class="mark-ball" />
    </svg>
    <div class="hero-text">
      <h1>AMAZE</h1>
      <p class="tagline">A marble battle-race through a living maze</p>
    </div>
  </header>

  <p class="intro">
    Roll your marble from your home keep to the enemy lair on the far side of the map.
    The walls evolve while you play, zombie bots hunt you, and every lap you finish
    reshapes the maze into a new biome. Shoot, build walls, lay mines and pick your
    route.
  </p>

  <div class="layout">
    <!-- ── Lobby ─────────────────────────────────────────── -->
    <section class="card lobby" aria-labelledby="lobby-title">
      <div class="card-head">
        <h2 id="lobby-title">Lobby</h2>
        <span class="status" class:live={inProgress}>
          <span class="dot" />
          {inProgress ? "Game in progress" : "Waiting for players"}
        </span>
      </div>

      <label class="field-label" for="playerName">Your name</label>
      <div class="name-row">
        <input
          id="playerName"
          class="name-input"
          type="text"
          maxlength="24"
          autocomplete="nickname"
          spellcheck="false"
          bind:value={nameDraft}
          on:blur={commitName}
          on:keydown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <span class="saved" class:show={nameSaved} aria-live="polite">{nameSaved ? "Saved" : ""}</span>
      </div>

      <div class="field-label row-label">
        <span>Players</span>
        <span class="count">{humans.length} human{humans.length === 1 ? "" : "s"} · {allyList.length} all{allyList.length === 1 ? "y" : "ies"} · {enemyList.length} enem{enemyList.length === 1 ? "y" : "ies"}</span>
      </div>
      <ul class="player-list">
        {#each humans as player (player.id)}
          <li class="player" class:offline={!player.online} class:me={player.id === myId}>
            <span class="avatar">{player.name.slice(0, 1).toUpperCase()}</span>
            <span class="player-name">
              {player.name}
              {#if player.id === myId}<span class="you">you</span>{/if}
            </span>
            <span class="pill subtle">{CONTROL_LABEL[player.inputSource]}</span>
            <span class="pill" class:ready={player.ready}>{player.ready ? "Ready" : "Not ready"}</span>
          </li>
        {/each}
        {#if humans.length === 0}
          <li class="player empty">Connecting…</li>
        {/if}
      </ul>

      <div class="bots">
        <div class="bot-row">
          <span class="team-dot ally" aria-hidden="true" />
          <div class="bots-text">
            <span class="bots-title">Allies</span>
            <span class="bots-sub">Escort you, hunt zombies, race for the lair</span>
          </div>
          <div class="stepper" role="group" aria-label="Number of ally bots">
            <button type="button" on:click={() => stepBots("ally", -1)} disabled={allyCount <= 0} aria-label="Fewer allies">−</button>
            <input
              id="allyCount"
              type="number"
              min="0"
              max="50"
              inputmode="numeric"
              bind:value={allyCount}
              on:change={() => syncBots("ally")}
              aria-label="Number of ally bots"
            />
            <button type="button" on:click={() => stepBots("ally", 1)} disabled={allyCount >= 50} aria-label="More allies">+</button>
          </div>
        </div>
        <div class="bot-row">
          <span class="team-dot enemy" aria-hidden="true" />
          <div class="bots-text">
            <span class="bots-title">Enemies</span>
            <span class="bots-sub">Half race to your home, half hunt you</span>
          </div>
          <div class="stepper" role="group" aria-label="Number of enemy bots">
            <button type="button" on:click={() => stepBots("enemy", -1)} disabled={botCount <= 0} aria-label="Fewer enemies">−</button>
            <input
              id="botCount"
              type="number"
              min="0"
              max="50"
              inputmode="numeric"
              bind:value={botCount}
              on:change={() => syncBots("enemy")}
              aria-label="Number of enemy bots"
            />
            <button type="button" on:click={() => stepBots("enemy", 1)} disabled={botCount >= 50} aria-label="More enemies">+</button>
          </div>
        </div>
      </div>

      {#if inProgress}
        <button class="btn primary" on:click={joinGame}>Join game in progress</button>
        <p class="note">A round is already running. Jump in, or restart it for everyone.</p>
      {:else}
        <button class="btn primary" on:click={handleStartNow} disabled={!startable}>Start game</button>
        <button class="btn secondary" class:on={isReady} on:click={toggleReady} aria-pressed={isReady}>
          {isReady ? "✓ Ready (tap to cancel)" : "Ready up"}
        </button>
        <p class="note">
          {#if humans.length > 1}
            The game starts by itself once every player is ready.
          {:else}
            Playing solo? Add a few bots and press Start.
          {/if}
        </p>
      {/if}

      <div class="danger">
        <button class="link-danger" on:click={handleRestart} disabled={restarting}>
          {restarting ? "Restarting…" : "Restart for everyone"}
        </button>
        <span class="danger-sub">Clears all players, bots and the current maze.</span>
      </div>
    </section>

    <!-- ── How to play ───────────────────────────────────── -->
    <section class="card guide" aria-labelledby="guide-title">
      <div class="card-head">
        <h2 id="guide-title">How to play</h2>
      </div>

      <div class="tabs" role="tablist" aria-label="How to play">
        <button role="tab" aria-selected={tab === "goal"} class:active={tab === "goal"} on:click={() => (tab = "goal")}>Goal</button>
        <button role="tab" aria-selected={tab === "controls"} class:active={tab === "controls"} on:click={() => (tab = "controls")}>Controls</button>
        <button role="tab" aria-selected={tab === "field"} class:active={tab === "field"} on:click={() => (tab = "field")}>Field guide</button>
      </div>

      <div class="tab-body" role="tabpanel">
        {#if tab === "goal"}
          <ol class="steps">
            <li>
              <span class="num">1</span>
              <div><strong>Reach the enemy lair.</strong> You start at your home keep. Get your marble into the lair at the other end to score a lap.</div>
            </li>
            <li>
              <span class="num">2</span>
              <div><strong>The maze keeps changing.</strong> Walls open and close as you play. When anyone finishes a lap, everyone gets a new maze in a new biome.</div>
            </li>
            <li>
              <span class="num">3</span>
              <div><strong>Survive the bots.</strong> Enemy racer bots head for <em>your</em> home keep. Red zombie bots hunt you, and touching one sends you back to the start. Add blue ally bots to escort you: they chase zombies, take out any enemy bot they touch (and respawn), and can win laps for you.</div>
            </li>
            <li>
              <span class="num">4</span>
              <div><strong>Fight back.</strong> One shot kills a bot. Shots also break walls. You can take 3 hits before you respawn at home.</div>
            </li>
          </ol>
          <p class="foot">The player with the most laps leads the scoreboard. Rounds never end, so keep racing.</p>
        {:else if tab === "controls"}
          <div class="controls" class:touch-first={touchFirst}>
            <div class="scheme">
              <div class="scheme-head">
                <span>Keyboard</span>
                {#if !touchFirst}<span class="pill ready">This device</span>{/if}
              </div>
              <div class="keyrow">
                <div class="arrows" aria-hidden="true">
                  <kbd class="up">↑</kbd><kbd class="left">←</kbd><kbd class="down">↓</kbd><kbd class="right">→</kbd>
                </div>
                <span>Move (4 directions)</span>
              </div>
              <div class="keyrow"><kbd>A</kbd><span>Shoot where you're facing</span></div>
              <div class="keyrow"><kbd>S</kbd><span>Build a wall in front of you</span></div>
              <div class="keyrow"><kbd>D</kbd><span>Drop a bomb behind you (kills bots)</span></div>
              <div class="keyrow"><kbd>M</kbd><span>Play / pause the radio</span></div>
            </div>
            <div class="scheme">
              <div class="scheme-head">
                <span>Touch</span>
                {#if touchFirst}<span class="pill ready">This device</span>{/if}
              </div>
              <div class="keyrow"><span class="touch-ico" aria-hidden="true"><span /></span><span>Drag anywhere to steer</span></div>
              <div class="keyrow"><span class="chip fire">FIRE</span><span>Shoot where you're facing</span></div>
              <div class="keyrow"><span class="chip build">BUILD</span><span>Build a wall in front of you</span></div>
            </div>
          </div>
          <p class="foot">You face the direction you last moved, and the small notch on your marble shows it. Shots and walls go that way.</p>
        {:else}
          <div class="legend">
            <h3>Pickups</h3>
            <div class="item"><span class="sw orb" style="--c:#ffb000" /><div><strong>Orange orb</strong>: speed boost for 8 seconds</div></div>
            <div class="item"><span class="sw orb" style="--c:#be46ff" /><div><strong>Purple orb</strong>: +3 bombs</div></div>
            <div class="item"><span class="sw orb" style="--c:#3cd2e6" /><div><strong>Cyan orb</strong>: +2 rafts for crossing water</div></div>

            <h3>Hazards</h3>
            <div class="item"><span class="sw ring" style="--c:#ff3c28" /><div><strong>Trap</strong>: flashes orange while arming, then turns red. A red trap sends you back to start.</div></div>
            <div class="item"><span class="sw ring" style="--c:#3cdc50" /><div><strong>Zombify trap</strong>: turns every bot into a zombie for 1 minute (or until the next maze).</div></div>
            <div class="item"><span class="sw orb solid" style="--c:#e0241c" /><div><strong>Red marble</strong>: a zombie. Shoot it or run.</div></div>
            <div class="item"><span class="sw orb solid ally" style="--c:#3d8bff" /><div><strong>Blue marble with white ring</strong>: your ally. Your shots and bombs don't hurt it.</div></div>
            <div class="item"><span class="sw wall" style="--c:#ff2a2a" /><div><strong>Armored wall</strong>: shots can't break it. It turns red once you've hit it.</div></div>

            <h3>Terrain</h3>
            <div class="item"><span class="sw tile" style="--c:#c8a050" /><div><strong>Sand</strong>: slows you down a lot.</div></div>
            <div class="item"><span class="sw tile" style="--c:#2a6ab0" /><div><strong>Water</strong>: drowns you unless you have a raft. Bots drown too, so lure zombies in.</div></div>
            <div class="item"><span class="sw tile" style="--c:#2f7a3a" /><div><strong>Forest</strong>: hides you from zombies.</div></div>
            <div class="item"><span class="sw gate" /><div><strong>Shortcut gate</strong>: only one marble can be inside. If two enter, it closes for 5 seconds.</div></div>
          </div>
        {/if}
      </div>
    </section>
  </div>
</div>

<style>
  .start {
    --surface: #15152a;
    --surface-2: #1c1c36;
    --line: #2a2a4c;
    --text: #e8e8ff;
    --muted: #8b8bb0;
    --accent: #7c7cff;
    --go: #2fbf71;
    --danger: #e07a7a;
    max-width: 1040px;
    margin: 0 auto;
    padding: 2.5rem 1.25rem 3rem;
    color: var(--text);
  }

  /* ── Hero ───────────────────────────────── */
  .hero {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .mark { width: 64px; height: 64px; flex-shrink: 0; }
  .mark-bg { fill: #1c1c3a; stroke: #3a3a6a; stroke-width: 2; }
  .mark-walls { fill: none; stroke: #7c7cff; stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }
  .mark-ball { fill: #fff; }
  h1 {
    font-size: clamp(2.4rem, 7vw, 3.5rem);
    font-weight: 900;
    letter-spacing: 0.14em;
    line-height: 1;
    background: linear-gradient(90deg, #ffffff 0%, #b7b7ff 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .tagline {
    margin-top: 0.4rem;
    color: var(--muted);
    font-size: 1rem;
    letter-spacing: 0.02em;
  }
  .intro {
    margin: 1.25rem 0 2rem;
    max-width: 68ch;
    color: #c4c4e4;
    line-height: 1.6;
    font-size: 1rem;
  }

  /* ── Layout ─────────────────────────────── */
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 400px) minmax(0, 1fr);
    gap: 1.25rem;
    align-items: start;
  }
  @media (max-width: 820px) {
    .layout { grid-template-columns: minmax(0, 1fr); }
    .start { padding-top: 1.75rem; }
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 1.25rem;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  h2 {
    font-size: 1.1rem;
    font-weight: 700;
    letter-spacing: 0.01em;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #e0b040; }
  .status.live .dot { background: var(--go); box-shadow: 0 0 0 3px rgba(47, 191, 113, 0.2); }

  /* ── Lobby ──────────────────────────────── */
  .field-label {
    display: block;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-bottom: 0.45rem;
  }
  .row-label {
    display: flex;
    justify-content: space-between;
    margin-top: 1.1rem;
  }
  .count { text-transform: none; letter-spacing: 0; font-weight: 500; }

  .name-row { position: relative; }
  .name-input {
    width: 100%;
    padding: 0.7rem 0.85rem;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: #10101f;
    color: var(--text);
    font: inherit;
    font-size: 1rem;
    font-weight: 600;
    outline: none;
    transition: border-color 0.15s;
  }
  .name-input:focus { border-color: var(--accent); }
  .saved {
    position: absolute;
    right: 0.8rem;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.75rem;
    color: var(--go);
    opacity: 0;
    transition: opacity 0.2s;
    pointer-events: none;
  }
  .saved.show { opacity: 1; }

  .player-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 220px;
    overflow-y: auto;
  }
  .player {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    background: var(--surface-2);
    border: 1px solid transparent;
    border-radius: 10px;
    padding: 0.55rem 0.7rem;
    font-size: 0.92rem;
  }
  .player.me { border-color: #34346a; }
  .player.offline { opacity: 0.4; }
  .player.empty { color: var(--muted); justify-content: center; }
  .avatar {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: #2c2c58;
    color: #c8c8ff;
    font-size: 0.75rem;
    font-weight: 700;
    flex-shrink: 0;
  }
  .player-name {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .you {
    margin-left: 0.35rem;
    font-size: 0.7rem;
    font-weight: 500;
    color: var(--muted);
  }
  .pill {
    font-size: 0.68rem;
    font-weight: 700;
    padding: 0.18rem 0.5rem;
    border-radius: 999px;
    background: #2a2a48;
    color: var(--muted);
    white-space: nowrap;
  }
  .pill.subtle { background: transparent; border: 1px solid var(--line); font-weight: 500; }
  .pill.ready { background: rgba(47, 191, 113, 0.15); color: #5fe0a0; }

  .bots {
    display: flex;
    flex-direction: column;
    margin: 1.1rem 0 1.25rem;
    border-radius: 12px;
    background: var(--surface-2);
  }
  .bot-row {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    padding: 0.7rem 0.85rem;
  }
  .bot-row + .bot-row { border-top: 1px solid var(--line); }
  .team-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  .team-dot.ally { background: #3d8bff; box-shadow: 0 0 0 2px #fff inset; }
  .team-dot.enemy { background: #e0241c; }
  .bots-text { display: flex; flex-direction: column; gap: 0.15rem; flex: 1; min-width: 0; }
  .bots-title { font-weight: 700; font-size: 0.95rem; }
  .bots-sub { font-size: 0.78rem; color: var(--muted); }
  .stepper {
    display: flex;
    align-items: center;
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
    background: #10101f;
  }
  .stepper button {
    width: 36px;
    height: 36px;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 1.15rem;
    line-height: 1;
  }
  .stepper button:hover:not(:disabled) { background: #22224a; }
  .stepper button:disabled { opacity: 0.3; cursor: default; }
  .stepper input {
    width: 2.75rem;
    height: 36px;
    border: none;
    border-left: 1px solid var(--line);
    border-right: 1px solid var(--line);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-weight: 700;
    text-align: center;
    -moz-appearance: textfield;
    appearance: textfield;
  }
  .stepper input::-webkit-outer-spin-button,
  .stepper input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

  .btn {
    width: 100%;
    padding: 0.9rem;
    border-radius: 12px;
    font: inherit;
    font-size: 1rem;
    font-weight: 700;
    transition: background 0.15s, transform 0.08s, border-color 0.15s;
  }
  .btn:active:not(:disabled) { transform: scale(0.985); }
  .btn.primary {
    border: none;
    background: var(--go);
    color: #04140b;
    font-size: 1.05rem;
    letter-spacing: 0.01em;
  }
  .btn.primary:hover:not(:disabled) { background: #3ad583; }
  .btn.primary:disabled { opacity: 0.4; cursor: default; }
  .btn.secondary {
    margin-top: 0.55rem;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--text);
    font-weight: 600;
  }
  .btn.secondary:hover { border-color: #3c3c70; background: #1a1a34; }
  .btn.secondary.on { border-color: rgba(47, 191, 113, 0.5); color: #5fe0a0; }

  .note {
    margin-top: 0.75rem;
    font-size: 0.82rem;
    color: var(--muted);
    text-align: center;
  }

  .danger {
    margin-top: 1.25rem;
    padding-top: 1rem;
    border-top: 1px solid var(--line);
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 0.75rem;
  }
  .link-danger {
    border: none;
    background: none;
    color: var(--danger);
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 0;
  }
  .link-danger:hover:not(:disabled) { text-decoration: underline; }
  .link-danger:disabled { opacity: 0.5; cursor: default; }
  .danger-sub { font-size: 0.75rem; color: #6c6c90; }

  /* ── Guide ──────────────────────────────── */
  .tabs {
    display: flex;
    gap: 0.25rem;
    padding: 0.25rem;
    border-radius: 12px;
    background: #10101f;
    border: 1px solid var(--line);
    margin-bottom: 1.1rem;
  }
  .tabs button {
    flex: 1;
    padding: 0.55rem 0.5rem;
    border: none;
    border-radius: 9px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 0.88rem;
    font-weight: 600;
    transition: background 0.15s, color 0.15s;
  }
  .tabs button:hover { color: var(--text); }
  .tabs button.active { background: var(--surface-2); color: var(--text); box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset; }

  .tab-body { font-size: 0.92rem; line-height: 1.55; color: #cfcfee; }
  .tab-body strong { color: var(--text); }

  .steps { list-style: none; display: flex; flex-direction: column; gap: 0.9rem; }
  .steps li { display: flex; gap: 0.8rem; align-items: flex-start; }
  .num {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: rgba(124, 124, 255, 0.15);
    color: #b7b7ff;
    font-size: 0.8rem;
    font-weight: 700;
  }
  .foot {
    margin-top: 1.1rem;
    padding: 0.7rem 0.85rem;
    border-radius: 10px;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 0.84rem;
  }

  .controls {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  .controls.touch-first .scheme:last-child { order: -1; }
  @media (max-width: 560px) { .controls { grid-template-columns: 1fr; } }
  .scheme {
    background: var(--surface-2);
    border-radius: 12px;
    padding: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .scheme-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-weight: 700;
    color: var(--text);
  }
  .keyrow { display: flex; align-items: center; gap: 0.7rem; font-size: 0.86rem; }
  kbd {
    display: inline-grid;
    place-items: center;
    min-width: 28px;
    height: 28px;
    padding: 0 0.4rem;
    border-radius: 7px;
    border: 1px solid #3a3a66;
    border-bottom-width: 3px;
    background: #10101f;
    color: var(--text);
    font: 700 0.8rem/1 system-ui, sans-serif;
    flex-shrink: 0;
  }
  .arrows {
    display: grid;
    grid-template-columns: repeat(3, 24px);
    grid-template-rows: 24px 24px;
    gap: 3px;
    flex-shrink: 0;
  }
  .arrows kbd { min-width: 24px; height: 24px; padding: 0; font-size: 0.7rem; }
  .arrows .up { grid-area: 1 / 2; }
  .arrows .left { grid-area: 2 / 1; }
  .arrows .down { grid-area: 2 / 2; }
  .arrows .right { grid-area: 2 / 3; }
  .touch-ico {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2px solid #4a4a80;
    display: grid;
    place-items: center;
    flex-shrink: 0;
  }
  .touch-ico span { width: 12px; height: 12px; border-radius: 50%; background: #c8c8ff; }
  .chip {
    font-size: 0.66rem;
    font-weight: 800;
    letter-spacing: 0.05em;
    padding: 0.35rem 0.5rem;
    border-radius: 8px;
    flex-shrink: 0;
    min-width: 52px;
    text-align: center;
  }
  .chip.fire { background: rgba(255, 90, 60, 0.18); color: #ff9a80; border: 1px solid rgba(255, 90, 60, 0.4); }
  .chip.build { background: rgba(124, 124, 255, 0.15); color: #b7b7ff; border: 1px solid rgba(124, 124, 255, 0.4); }

  .legend h3 {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin: 1rem 0 0.5rem;
  }
  .legend h3:first-child { margin-top: 0; }
  .item { display: flex; align-items: flex-start; gap: 0.75rem; padding: 0.3rem 0; font-size: 0.88rem; }
  .sw { width: 20px; height: 20px; flex-shrink: 0; margin-top: 1px; }
  .sw.orb {
    border-radius: 50%;
    background: radial-gradient(circle, var(--c) 0 40%, transparent 42%);
    box-shadow: 0 0 10px -2px var(--c);
  }
  .sw.orb.solid { background: var(--c); box-shadow: none; border: 2px solid #6e0a06; }
  .sw.orb.solid.ally { border-color: #fff; }
  .sw.ring { border-radius: 50%; border: 3px solid var(--c); }
  .sw.tile { border-radius: 4px; background: var(--c); opacity: 0.85; }
  .sw.wall { border-radius: 3px; background: var(--c); width: 20px; height: 10px; margin-top: 6px; }
  .sw.gate { border-radius: 3px; border: 2px solid #3cdc50; box-shadow: 0 0 8px rgba(60, 220, 80, 0.5); }
</style>
