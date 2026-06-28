import { input } from "$lib/stores/inputStore";

const keys = new Set<string>();

function normalizeKey(key: string): string {
  return key.toLowerCase();
}

function updateInput(): void {
  // Arrow keys only — A/S are reserved for shoot/build (see GameCanvas).
  input.set({
    x: Number(keys.has("arrowright")) - Number(keys.has("arrowleft")),
    y: Number(keys.has("arrowdown")) - Number(keys.has("arrowup")),
  });
}

export function startKeyboardInput(): () => void {
  function handleKeyDown(event: KeyboardEvent) {
    keys.add(normalizeKey(event.key));
    updateInput();
  }

  function handleKeyUp(event: KeyboardEvent) {
    keys.delete(normalizeKey(event.key));
    updateInput();
  }

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);

  return () => {
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("keyup", handleKeyUp);
    keys.clear();
    updateInput();
  };
}
