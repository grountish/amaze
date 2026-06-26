<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { requestMotionPermission, startMotionInput } from '$lib/input/motionInput';
  import { sensor } from '$lib/stores/sensorStore';

  const dispatch = createEventDispatcher<{ granted: void }>();

  async function handleClick() {
    const result = await requestMotionPermission();
    if (result) {
      startMotionInput();
      dispatch('granted');
    }
  }
</script>

{#if $sensor.permission === 'unknown'}
  <button class="motion-btn" on:click={handleClick}>
    Enable Motion Control
  </button>
{:else if $sensor.permission === 'granted'}
  <div class="motion-active">
    <span class="checkmark">&#10003;</span> Motion Active
  </div>
{:else if $sensor.permission === 'denied'}
  <div class="motion-denied">
    Motion Denied - use keyboard
  </div>
{/if}

<style>
  .motion-btn {
    padding: 0.5rem 1rem;
    border: 1px solid #555;
    border-radius: 4px;
    background: #222;
    color: #fff;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .motion-btn:hover {
    background: #333;
  }

  .motion-active {
    color: #4caf50;
    font-size: 0.9rem;
  }

  .checkmark {
    font-weight: bold;
  }

  .motion-denied {
    color: #e53935;
    font-size: 0.9rem;
  }
</style>
