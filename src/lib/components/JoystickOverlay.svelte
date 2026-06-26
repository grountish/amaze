<script lang="ts">
  import { onDestroy } from 'svelte';
  import { input } from '$lib/stores/inputStore';

  const MAX_RADIUS = 60;

  let active = false;
  let touchId: number | null = null;
  let baseX = 0;
  let baseY = 0;
  let knobX = 0;
  let knobY = 0;

  function handleTouchStart(e: TouchEvent) {
    e.preventDefault();
    if (active) return;
    const touch = e.changedTouches[0];
    touchId = touch.identifier;
    baseX = touch.clientX;
    baseY = touch.clientY;
    knobX = baseX;
    knobY = baseY;
    active = true;
  }

  function handleTouchMove(e: TouchEvent) {
    e.preventDefault();
    const touch = Array.from(e.changedTouches).find(t => t.identifier === touchId);
    if (!touch) return;

    const dx = touch.clientX - baseX;
    const dy = touch.clientY - baseY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const clamped = Math.min(dist, MAX_RADIUS);
    const angle = Math.atan2(dy, dx);

    knobX = baseX + Math.cos(angle) * clamped;
    knobY = baseY + Math.sin(angle) * clamped;

    input.set({
      x: (clamped / MAX_RADIUS) * Math.cos(angle),
      y: (clamped / MAX_RADIUS) * Math.sin(angle),
    });
  }

  function handleTouchEnd(e: TouchEvent) {
    e.preventDefault();
    const released = Array.from(e.changedTouches).find(t => t.identifier === touchId);
    if (!released) return;
    active = false;
    touchId = null;
    input.set({ x: 0, y: 0 });
  }

  onDestroy(() => {
    input.set({ x: 0, y: 0 });
  });
</script>

<div
  class="zone"
  on:touchstart={handleTouchStart}
  on:touchmove={handleTouchMove}
  on:touchend={handleTouchEnd}
  on:touchcancel={handleTouchEnd}
>
  {#if active}
    <div class="base" style="left:{baseX}px; top:{baseY}px;" />
    <div class="knob" style="left:{knobX}px; top:{knobY}px;" />
  {/if}
</div>

<style>
  .zone {
    position: fixed;
    inset: 0;
    z-index: 50;
    touch-action: none;
  }

  .base {
    position: fixed;
    width: 120px;
    height: 120px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.08);
    border: 2px solid rgba(255, 255, 255, 0.25);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }

  .knob {
    position: fixed;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.55);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }
</style>
