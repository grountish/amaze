<script lang="ts">
  import { players } from '$lib/stores/playerStore';

  export let roomId: string = '';

  $: sorted = [...$players].sort((a, b) => {
    const aFinished = a.finishedAt != null;
    const bFinished = b.finishedAt != null;

    if (aFinished && bFinished) {
      return a.finishedAt! - b.finishedAt!;
    }
    if (aFinished) return -1;
    if (bFinished) return 1;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  function formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const centiseconds = Math.floor((ms % 1000) / 10);
    if (minutes > 0) {
      return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
    }
    return `${seconds}.${centiseconds.toString().padStart(2, '0')}s`;
  }
</script>

<div class="overlay">
  <div class="panel">
    <h2 class="title">Leaderboard</h2>
    <ol class="list">
      {#each sorted as player, i}
        <li class="row">
          <span class="rank">{i + 1}</span>
          <div class="info">
            <div class="name-row">
              <span class="name">{player.name}</span>
              {#if i === 0 && player.finishedAt != null}
                <span class="winner-badge">WINNER</span>
              {/if}
              {#if player.finishedAt != null}
                <span class="finish-time">{formatTime(player.finishedAt)}</span>
              {/if}
            </div>
            <div class="score-line">{player.score ?? 0} {(player.score ?? 0) === 1 ? 'lap' : 'laps'}</div>
          </div>
        </li>
      {/each}
    </ol>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
    z-index: 100;
  }

  .panel {
    background: rgba(15, 15, 25, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    padding: 2rem 2.5rem;
    min-width: 320px;
    max-width: 480px;
    width: 100%;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(8px);
  }

  .title {
    margin: 0 0 1.5rem;
    font-size: 1.5rem;
    font-weight: 700;
    text-align: center;
    color: #ffffff;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .rank {
    font-size: 1rem;
    font-weight: 700;
    color: rgba(255, 255, 255, 0.4);
    width: 1.5rem;
    text-align: right;
    flex-shrink: 0;
  }

  .info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .name {
    font-size: 0.95rem;
    font-weight: 600;
    color: #ffffff;
  }

  .winner-badge {
    font-size: 0.65rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.15);
    border: 1px solid rgba(251, 191, 36, 0.4);
    border-radius: 4px;
    padding: 1px 6px;
    text-transform: uppercase;
  }

  .finish-time {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.5);
    margin-left: auto;
  }

  .score-line {
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.6);
  }
</style>
