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
    mazeId: "default",
    createdAt: now,
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

export function subscribeToPlayers(roomId: string, callback: (players: Player[]) => void): () => void {
  const playersRef = ref(db(), `rooms/${roomId}/players`);
  const unsub = onValue(playersRef, (snapshot) => {
    if (!snapshot.exists()) { callback([]); return; }
    const data = snapshot.val() as Record<string, Player>;
    callback(Object.values(data));
  });
  return unsub;
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

export async function setRoomStatus(roomId: string, status: Room["status"]): Promise<void> {
  await update(ref(db(), `rooms/${roomId}`), { status });
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
