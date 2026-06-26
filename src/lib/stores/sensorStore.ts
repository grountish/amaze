import { writable } from "svelte/store";

export type SensorState = {
  permission: "unknown" | "granted" | "denied";
  x: number;
  y: number;
  z: number;
};

export const sensor = writable<SensorState>({
  permission: "unknown",
  x: 0,
  y: 0,
  z: 0,
});
