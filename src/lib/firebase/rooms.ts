import {
  getDatabase,
  ref,
  set,
  get,
  push,
  update,
  remove,
  onValue,
  onDisconnect,
  runTransaction,
} from "firebase/database";
import { getFirebaseApp } from "./app";
import { getCurrentUser } from "./auth";
import type { Room, Player, GameEvent, InputSource, ShortcutState } from "./types";
import { randomSeed, nextSeed } from "$lib/game/mazeGen";

export const SINGLE_ROOM_ID = "MAIN";

function db() {
  return getDatabase(getFirebaseApp());
}

function generateRoomId(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

export async function createRoom(playerName: string, inputSource: InputSource): Promise<string> {
  const user = getCurrentUser();
  if (!user) throw new Error("Not authenticated");

  const roomId = generateRoomId();
  const now = Date.now();

  const roomData: Room = {
    id: roomId,
    status: "waiting",
    mazeId: String(randomSeed()), // procedural maze seed
    createdAt: now,
    lap: 0,
  };

  const playerData: Player = {
    id: user.uid,
    name: playerName,
    ready: false,
    online: true,
    inputSource,
    progress: 0,
    lastSeenAt: now,
  };

  await set(ref(db(), `rooms/${roomId}`), roomData);
  await set(ref(db(), `rooms/${roomId}/players/${user.uid}`), playerData);

  return roomId;
}

export async function deleteRoom(roomId: string): Promise<void> {
  await remove(ref(db(), `rooms/${roomId}`));
}

// "Restart for all": wipe the whole room — every player, bot, trap, nutrient
// and the evolved maze — and recreate a fresh waiting lobby with a new maze.
// The caller re-joins afterwards; other clients should re-enter/reload.
export async function resetRoom(roomId: string): Promise<void> {
  await set(ref(db(), `rooms/${roomId}`), {
    id: roomId,
    status: "waiting",
    mazeId: String(randomSeed()),
    createdAt: Date.now(),
    lap: 0,
  } satisfies Room);
}

// Shortcut gate — atomic transaction returns: 'claimed' | 'collapsed' | 'blocked'
export async function enterShortcut(
  roomId: string,
  playerId: string,
): Promise<"claimed" | "collapsed" | "blocked"> {
  const shortcutRef = ref(db(), `rooms/${roomId}/shortcut`);
  let outcome: "claimed" | "collapsed" | "blocked" = "claimed";

  await runTransaction(shortcutRef, (current) => {
    const now = Date.now();
    if (current?.collapseUntil && current.collapseUntil > now) {
      outcome = "blocked";
      return current;
    }
    if (current?.occupant && current.occupant !== playerId) {
      outcome = "collapsed";
      return { occupant: null, collapseUntil: now + 5000 };
    }
    outcome = "claimed";
    return { occupant: playerId, collapseUntil: null };
  });

  return outcome;
}

export async function exitShortcut(roomId: string, playerId: string): Promise<void> {
  const shortcutRef = ref(db(), `rooms/${roomId}/shortcut`);
  await runTransaction(shortcutRef, (current) => {
    if (current?.occupant === playerId) {
      return { ...current, occupant: null };
    }
    return current;
  });
}

export function subscribeToShortcut(
  roomId: string,
  callback: (state: ShortcutState | null) => void,
): () => void {
  return onValue(ref(db(), `rooms/${roomId}/shortcut`), (snap) => callback(snap.val()));
}

export async function ensureRoom(roomId: string): Promise<void> {
  const roomRef = ref(db(), `rooms/${roomId}`);
  const snapshot = await get(roomRef);
  if (!snapshot.exists() || snapshot.val().status === "finished") {
    await set(roomRef, {
      id: roomId,
      status: "waiting",
      mazeId: "default",
      createdAt: Date.now(),
    } satisfies Room);
  }
}

export async function joinRoom(roomId: string, playerName: string, inputSource: InputSource): Promise<void> {
  const user = getCurrentUser();
  if (!user) throw new Error("Not authenticated");

  // Sweep ghosts (and idle bots) left by prior sessions before joining.
  await pruneStalePlayers(roomId);

  const now = Date.now();
  const playerData: Player = {
    id: user.uid,
    name: playerName,
    ready: false,
    online: true,
    inputSource,
    progress: 0,
    lastSeenAt: now,
  };

  const playerRef = ref(db(), `rooms/${roomId}/players/${user.uid}`);
  await set(playerRef, playerData);
  // Auto-remove player from Firebase if they close the tab or lose connection
  onDisconnect(playerRef).remove();
}

export function subscribeToRoom(roomId: string, callback: (room: Room | null) => void): () => void {
  const roomRef = ref(db(), `rooms/${roomId}`);
  const unsub = onValue(roomRef, (snapshot) => {
    if (!snapshot.exists()) { callback(null); return; }
    const data = snapshot.val();
    callback({ ...data, id: roomId } as Room);
  });
  return unsub;
}

// Heartbeat is 30s (presence.ts); host re-writes bot lastSeenAt every frame.
// Anything not seen in 90s is a ghost: a tab that died before onDisconnect
// could remove it, or a bot from a finished session. Such ghosts kept
// `online: true, ready: false` forever, piling up in the shared room and
// blocking `every(p => p.ready)` so the game could never start.
const STALE_MS = 90_000;

function isFresh(p: Player, now: number): boolean {
  if (p.online === false) return false; // deliberate leave
  return now - (p.lastSeenAt ?? 0) < STALE_MS;
}

export function subscribeToPlayers(roomId: string, callback: (players: Player[]) => void): () => void {
  const playersRef = ref(db(), `rooms/${roomId}/players`);
  const unsub = onValue(playersRef, (snapshot) => {
    if (!snapshot.exists()) { callback([]); return; }
    const data = snapshot.val() as Record<string, Player>;
    const now = Date.now();
    callback(Object.values(data).filter((p) => isFresh(p, now)));
  });
  return unsub;
}

// Hard-delete stale records so they don't accumulate in the shared room.
// Called on join: each visitor sweeps the ghosts left by previous sessions.
export async function pruneStalePlayers(roomId: string): Promise<void> {
  const playersRef = ref(db(), `rooms/${roomId}/players`);
  const snap = await get(playersRef);
  if (!snap.exists()) return;
  const data = snap.val() as Record<string, Player>;
  const now = Date.now();
  const updates: Record<string, null> = {};
  for (const [id, p] of Object.entries(data)) {
    if (!isFresh(p, now)) updates[id] = null;
  }
  if (Object.keys(updates).length > 0) await update(playersRef, updates);
}

// Bots are session-scoped: the in-game driver keeps writing their lastSeenAt
// so the staleness sweep can't catch them, and they pile up across add-bot /
// refresh cycles. Wipe all bots — called when joining a lobby that isn't
// mid-game, so each lobby starts with zero bots and you add the ones you want.
export async function removeBots(roomId: string): Promise<void> {
  const playersRef = ref(db(), `rooms/${roomId}/players`);
  const snap = await get(playersRef);
  if (!snap.exists()) return;
  const data = snap.val() as Record<string, Player>;
  const updates: Record<string, null> = {};
  for (const [id, p] of Object.entries(data)) {
    if (p.inputSource === "bot") updates[id] = null;
  }
  if (Object.keys(updates).length > 0) await update(playersRef, updates);
}

export async function setPlayerReady(roomId: string, playerId: string, ready: boolean): Promise<void> {
  await update(ref(db(), `rooms/${roomId}/players/${playerId}`), { ready });
}

export async function updatePlayerProgress(roomId: string, playerId: string, progress: number): Promise<void> {
  await update(ref(db(), `rooms/${roomId}/players/${playerId}`), { progress, lastSeenAt: Date.now() });
}

export async function updatePlayerPosition(
  roomId: string,
  playerId: string,
  x: number,
  y: number,
  progress: number,
): Promise<void> {
  await update(ref(db(), `rooms/${roomId}/players/${playerId}`), {
    x: Math.round(x),
    y: Math.round(y),
    progress,
    lastSeenAt: Date.now(),
  });
}

export async function sendGameEvent(roomId: string, event: GameEvent): Promise<void> {
  const eventsRef = ref(db(), `rooms/${roomId}/events`);
  await push(eventsRef, event);
}

export async function finishPlayer(roomId: string, playerId: string, timeMs: number): Promise<void> {
  const now = Date.now();
  await update(ref(db(), `rooms/${roomId}/players/${playerId}`), {
    progress: 100,
    finishedAt: now,
  });

  const roomRef = ref(db(), `rooms/${roomId}`);
  await update(roomRef, { status: "finished", winnerId: playerId, finishedAt: now });

  await sendGameEvent(roomId, { type: "GOAL_REACHED", playerId, timeMs, createdAt: now });
}

// ── Endless morph: win a lap → regenerate the maze for everyone ──
// Race-safe: a transaction on the room only advances the lap if `lapSeen`
// still matches, so if two players reach the hole near-simultaneously only
// the first registers the win. Returns true if THIS caller won the lap.
export async function winLap(
  roomId: string,
  playerId: string,
  lapSeen: number,
  nowMs: number,
): Promise<boolean> {
  const roomRef = ref(db(), `rooms/${roomId}`);
  const result = await runTransaction(roomRef, (room: Room | null) => {
    if (!room) return room;
    const curLap = room.lap ?? 0;
    if (curLap !== lapSeen) return room; // someone already won this lap
    const seed = parseInt(room.mazeId, 10) || 1;
    room.lap = curLap + 1;
    room.mazeId = String(nextSeed(seed));
    room.lastWinnerId = playerId;
    room.winnerId = playerId;
    room.lapAt = nowMs;
    room.mazeGrid = null as unknown as undefined; // drop evolved deltas; fresh maze
    return room;
  });

  const snap = result.snapshot.val() as Room | null;
  const iWon = result.committed && snap?.lap === lapSeen + 1 && snap?.lastWinnerId === playerId;

  if (iWon) {
    // Increment the winner's score (separate path, own transaction).
    const scoreRef = ref(db(), `rooms/${roomId}/players/${playerId}/score`);
    await runTransaction(scoreRef, (s: number | null) => (s ?? 0) + 1);
    await sendGameEvent(roomId, { type: "GOAL_REACHED", playerId, timeMs: 0, createdAt: nowMs });
  }
  return !!iWon;
}

export async function setRoomStatus(roomId: string, status: Room["status"]): Promise<void> {
  await update(ref(db(), `rooms/${roomId}`), { status });
}

// Flip to playing AND stamp startedAt so the in-game timer actually starts.
export async function startGame(roomId: string): Promise<void> {
  await update(ref(db(), `rooms/${roomId}`), { status: "playing", startedAt: Date.now() });
}

export async function leaveRoom(roomId: string, playerId: string): Promise<void> {
  await update(ref(db(), `rooms/${roomId}/players/${playerId}`), { online: false });
  await sendGameEvent(roomId, { type: "PLAYER_LEFT", playerId, createdAt: Date.now() });
}

export async function addBotPlayer(roomId: string): Promise<string> {
  const botId = `bot_${Date.now()}`;
  const now = Date.now();
  const botData: Player = {
    id: botId,
    name: "Bot",
    ready: true,
    online: true,
    inputSource: "bot",
    progress: 0,
    lastSeenAt: now,
  };
  await set(ref(db(), `rooms/${roomId}/players/${botId}`), botData);
  return botId;
}

// ── Evolving maze grid ─────────────────────────────────────────

export async function updateMazeGrid(roomId: string, wallsB64: string): Promise<void> {
  await update(ref(db(), `rooms/${roomId}`), { mazeGrid: wallsB64 });
}

export function subscribeToMazeGrid(
  roomId: string,
  callback: (wallsB64: string | null) => void,
): () => void {
  return onValue(ref(db(), `rooms/${roomId}/mazeGrid`), (snap) => callback(snap.val()));
}

// ── Nutrients ──────────────────────────────────────────────────

import type { NutrientData } from '$lib/game/cellularMaze';

export async function syncNutrients(
  roomId: string,
  candidates: NutrientData[],
): Promise<void> {
  const nutrientRef = ref(db(), `rooms/${roomId}/nutrients`);
  const snap = await get(nutrientRef);
  const now = Date.now();
  const existing: Record<string, NutrientData> = snap.val() ?? {};

  const updates: Record<string, NutrientData | null> = {};

  // Expire old nutrients
  for (const [k, v] of Object.entries(existing)) {
    if (v.expiresAt < now) updates[k] = null;
  }

  const activeCount = Object.values(existing).filter((v) => v.expiresAt >= now).length;
  const toAdd = Math.min(candidates.length, Math.max(0, 4 - activeCount));

  for (let i = 0; i < toAdd; i++) {
    updates[`n_${now}_${i}`] = { ...candidates[i], expiresAt: now + 18000 };
  }

  if (Object.keys(updates).length > 0) {
    await update(nutrientRef, updates);
  }
}

export async function collectNutrient(
  roomId: string,
  nutrientId: string,
): Promise<boolean> {
  let collected = false;
  await runTransaction(ref(db(), `rooms/${roomId}/nutrients/${nutrientId}`), (current) => {
    if (current == null) return undefined; // already gone
    collected = true;
    return null;
  });
  return collected;
}

export function subscribeToNutrients(
  roomId: string,
  callback: (nutrients: Record<string, NutrientData>) => void,
): () => void {
  return onValue(ref(db(), `rooms/${roomId}/nutrients`), (snap) => callback(snap.val() ?? {}));
}

// ── Traps ──────────────────────────────────────────────────────

import type { TrapData } from './types';

export async function addTrap(roomId: string, col: number, row: number): Promise<void> {
  const trapsRef = ref(db(), `rooms/${roomId}/traps`);
  const snap = await get(trapsRef);
  const existing: Record<string, TrapData> = snap.val() ?? {};
  if (Object.keys(existing).length >= 8) return; // cap at 8
  await update(trapsRef, { [`t_${Date.now()}`]: { col, row } });
}

export async function triggerTrap(roomId: string, trapId: string): Promise<boolean> {
  let triggered = false;
  await runTransaction(ref(db(), `rooms/${roomId}/traps/${trapId}`), (current) => {
    if (current == null) return undefined;
    triggered = true;
    return null; // one-shot: remove after triggering
  });
  return triggered;
}

export function subscribeToTraps(
  roomId: string,
  callback: (traps: Record<string, TrapData>) => void,
): () => void {
  return onValue(ref(db(), `rooms/${roomId}/traps`), (snap) => callback(snap.val() ?? {}));
}
