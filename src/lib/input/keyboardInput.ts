import { input } from "$lib/stores/inputStore";

const keys = new Set<string>();

function normalizeKey(key: string): string {
  return key.toLowerCase();
}

function updateInput(): void {
  input.set({
    x: Number(keys.has("arrowright") || keys.has("d")) - Number(keys.has("arrowleft") || keys.has("a")),
    y: Number(keys.has("arrowdown") || keys.has("s")) - Number(keys.has("arrowup") || keys.has("w")),
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
