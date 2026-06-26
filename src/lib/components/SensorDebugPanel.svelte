<script lang="ts">
  import { sensor } from '$lib/stores/sensorStore';
  import { input } from '$lib/stores/inputStore';
</script>

<div class="debug-panel">
  <div class="title">Debug</div>
  <div class="section">
    <div class="label">Sensor</div>
    <div>x: {$sensor.x.toFixed(2)}</div>
    <div>y: {$sensor.y.toFixed(2)}</div>
    <div>z: {$sensor.z.toFixed(2)}</div>
  </div>
  <div class="section">
    <div class="label">Input</div>
    <div>x: {$input.x.toFixed(3)}</div>
    <div>y: {$input.y.toFixed(3)}</div>
  </div>
  <div class="section">
    <div class="label">Permission</div>
    <div>{$sensor.permission}</div>
  </div>
</div>

<style>
  .debug-panel {
    position: fixed;
    bottom: 16px;
    right: 16px;
    background: rgba(0, 0, 0, 0.75);
    color: #e0e0e0;
    font-family: monospace;
    font-size: 11px;
    padding: 10px 14px;
    border-radius: 8px;
    z-index: 9999;
    line-height: 1.6;
    min-width: 160px;
  }

  .title {
    font-size: 12px;
    font-weight: bold;
    margin-bottom: 6px;
    color: #ffffff;
  }

  .section {
    margin-top: 6px;
  }

  .label {
    color: #aaaaaa;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 2px;
  }
</style>
