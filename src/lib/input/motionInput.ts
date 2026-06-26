import { input } from "$lib/stores/inputStore";
import { sensor } from "$lib/stores/sensorStore";

type DeviceMotionEventWithPermission = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

export async function requestMotionPermission(): Promise<boolean> {
  const MotionEvent = DeviceMotionEvent as DeviceMotionEventWithPermission;

  if (typeof MotionEvent.requestPermission === "function") {
    const permission = await MotionEvent.requestPermission();
    sensor.update((s) => ({ ...s, permission }));
    return permission === "granted";
  }

  sensor.update((s) => ({ ...s, permission: "granted" }));
  return true;
}

export function startMotionInput(): () => void {
  function handleMotion(event: DeviceMotionEvent) {
    const rawX = event.accelerationIncludingGravity?.x ?? 0;
    const rawY = event.accelerationIncludingGravity?.y ?? 0;
    const rawZ = event.accelerationIncludingGravity?.z ?? 0;

    sensor.set({ permission: "granted", x: rawX, y: rawY, z: rawZ });
    input.set({ x: -rawX / 10, y: rawY / 10 });
  }

  window.addEventListener("devicemotion", handleMotion);
  return () => window.removeEventListener("devicemotion", handleMotion);
}
