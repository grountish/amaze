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
  increment,
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
    lastSeenAt: now,
    hp: 3,
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

// A real player record has its core fields. Partial nodes can appear when the
// presence heartbeat recreates a path that was wiped (e.g. another client
// after "Restart for all"), leaving just { lastSeenAt } — those must be
// dropped or the renderer crashes on the missing id.
function isValidPlayer(p: Player | null | undefined): p is Player {
  return !!p && typeof p.id === "string" && typeof p.inputSource === "string";
}

export function subscribeToPlayers(roomId: string, callback: (players: Player[]) => void): () => void {
  const playersRef = ref(db(), `rooms/${roomId}/players`);
  const unsub = onValue(playersRef, (snapshot) => {
    if (!snapshot.exists()) { callback([]); return; }
    const data = snapshot.val() as Record<string, Player>;
    const now = Date.now();
    // Derive id from the key so a record missing the field is still usable.
    const list = Object.entries(data).map(([id, p]) => ({ ...p, id }));
    callback(list.filter((p) => isValidPlayer(p) && isFresh(p, now)));
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
    // Drop stale ghosts and malformed partial records alike.
    if (!isValidPlayer({ ...p, id }) || !isFresh(p, now)) updates[id] = null;
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

export async function updatePlayerPosition(
  roomId: string,
  playerId: string,
  x: number,
  y: number,
): Promise<void> {
  // RTDB rejects NaN/Infinity — never write a corrupted position.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  await update(ref(db(), `rooms/${roomId}/players/${playerId}`), {
    x: Math.round(x),
    y: Math.round(y),
    lastSeenAt: Date.now(),
  });
}

// Batch every bot's position into ONE multi-path update. The old code awaited a
// separate write per bot inside a 20Hz loop — N serial round-trips per tick that
// backed up the event loop and fired N subscribeToPlayers re-renders. One write
// → one echo, regardless of bot count.
export async function updateBotPositions(
  roomId: string,
  updates: { id: string; x: number; y: number }[],
): Promise<void> {
  if (updates.length === 0) return;
  const now = Date.now();
  const payload: Record<string, number> = {};
  for (const u of updates) {
    if (!Number.isFinite(u.x) || !Number.isFinite(u.y)) continue;
    payload[`${u.id}/x`] = Math.round(u.x);
    payload[`${u.id}/y`] = Math.round(u.y);
    payload[`${u.id}/lastSeenAt`] = now;
  }
  await update(ref(db(), `rooms/${roomId}/players`), payload);
}

export async function sendGameEvent(roomId: string, event: GameEvent): Promise<void> {
  const eventsRef = ref(db(), `rooms/${roomId}/events`);
  await push(eventsRef, event);
}

export async function setRoomStatus(roomId: string, status: Room["status"]): Promise<void> {
  await update(ref(db(), `rooms/${roomId}`), { status });
}

// Personal lap: a racer reached their own goal. Atomically bump only their
// score. Uses increment() rather than a transaction — a transaction here locks
// the player node and collides with the constant position updates (which write
// the same subtree), throwing "set" via repoAbortTransactions.
export async function scoreLap(roomId: string, playerId: string): Promise<void> {
  await update(ref(db(), `rooms/${roomId}/players/${playerId}`), { score: increment(1) });
}

// Advance to a fresh maze for everyone. The first finisher of a lap triggers
// this; the shared seed changes → every client regenerates the same maze.
// Writes individual leaf fields (NOT a room-node transaction) so it never
// aborts the trap/nutrient/position writes happening on sibling subtrees.
export async function advanceMaze(roomId: string): Promise<void> {
  const base = `rooms/${roomId}`;
  const snap = await get(ref(db(), `${base}/mazeId`));
  const seed = parseInt(snap.val() ?? "1", 10) || 1;
  await Promise.all([
    set(ref(db(), `${base}/mazeId`), String(nextSeed(seed))),
    set(ref(db(), `${base}/lap`), increment(1)),
    set(ref(db(), `${base}/mazeGrid`), null), // drop evolved deltas; fresh maze
    set(ref(db(), `${base}/rage`), false), // fresh maze clears any zombie rage
    set(ref(db(), `${base}/traps`), null), // stale traps/bombs map to old walls
  ]);
}

// Zombify-trap rage flag: when a human crosses one, every bot turns zombie
// until the maze morphs. Leaf write (not a room-node update) so it never aborts
// sibling trap/score transactions — same reason advanceMaze writes leaves.
export async function setRage(roomId: string, on: boolean): Promise<void> {
  await set(ref(db(), `rooms/${roomId}/rage`), on);
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
  // Random suffix so a tight add-loop can't collide on Date.now() (same ms).
  const botId = `bot_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const now = Date.now();
  const botData: Player = {
    id: botId,
    name: "Bot",
    ready: true,
    online: true,
    inputSource: "bot",
    lastSeenAt: now,
    hp: 3,
  };
  await set(ref(db(), `rooms/${roomId}/players/${botId}`), botData);
  return botId;
}

// Reconcile the room's bot count to exactly `target` (0 = no bots): add bots
// if short, remove extras if over. Lets a single number input drive bots
// directly, no separate "add" action.
export async function setBotCount(roomId: string, target: number): Promise<void> {
  const n = Math.max(0, Math.min(50, Math.floor(target) || 0));
  const playersRef = ref(db(), `rooms/${roomId}/players`);
  const snap = await get(playersRef);
  const data = (snap.val() ?? {}) as Record<string, Player>;
  const botIds = Object.entries(data)
    .filter(([, p]) => p.inputSource === "bot")
    .map(([id]) => id);

  if (botIds.length < n) {
    for (let i = botIds.length; i < n; i++) await addBotPlayer(roomId);
  } else if (botIds.length > n) {
    const updates: Record<string, null> = {};
    for (const id of botIds.slice(n)) updates[id] = null;
    await update(playersRef, updates);
  }
}

// ── Evolving maze grid ─────────────────────────────────────────

export async function updateMazeGrid(roomId: string, wallsB64: string): Promise<void> {
  // Leaf write — a room-node update would abort in-flight trap/nutrient/score
  // transactions on sibling subtrees ("set" error).
  await set(ref(db(), `rooms/${roomId}/mazeGrid`), wallsB64);
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

export async function addTrap(
  roomId: string,
  col: number,
  row: number,
  armAt: number,
  kind?: "zombify" | "bomb",
): Promise<void> {
  const trapsRef = ref(db(), `rooms/${roomId}/traps`);
  const snap = await get(trapsRef);
  const existing: Record<string, TrapData> = snap.val() ?? {};
  if (Object.keys(existing).length >= 14) return; // cap (AI traps + player bombs)
  const data: TrapData = { col, row, armAt };
  if (kind) data.kind = kind; // omit when undefined — RTDB rejects undefined
  await update(trapsRef, { [`t_${Date.now()}`]: data });
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

// ── Shots ──────────────────────────────────────────────────────

import type { ShotData } from './types';

// One write per shot. Position is derived from firedAt on every client, so the
// projectile never needs a position update — see ShotData.
export async function fireShot(roomId: string, shot: ShotData): Promise<void> {
  const id = `s_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await update(ref(db(), `rooms/${roomId}/shots`), { [id]: shot });
}

export function subscribeToShots(
  roomId: string,
  callback: (shots: Record<string, ShotData>) => void,
): () => void {
  return onValue(ref(db(), `rooms/${roomId}/shots`), (snap) => callback(snap.val() ?? {}));
}

// Batched removal of consumed/expired shots (one write for many ids).
export async function pruneShots(roomId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const payload: Record<string, null> = {};
  for (const id of ids) payload[id] = null;
  await update(ref(db(), `rooms/${roomId}/shots`), payload);
}

// Atomic -1 to a victim's hp (safe under concurrent shooters — increment, not a
// transaction, so it never aborts sibling writes).
export async function damagePlayer(roomId: string, playerId: string): Promise<void> {
  await update(ref(db(), `rooms/${roomId}/players/${playerId}`), { hp: increment(-1) });
}

export async function setPlayerHp(roomId: string, playerId: string, hp: number): Promise<void> {
  await update(ref(db(), `rooms/${roomId}/players/${playerId}`), { hp });
}
