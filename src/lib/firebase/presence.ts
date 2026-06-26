import { getDatabase, ref, onDisconnect, set, update } from "firebase/database";
import { getFirebaseApp } from "./app";

export function setupPresence(roomId: string, playerId: string): () => void {
  const database = getDatabase(getFirebaseApp());
  const playerRef = ref(database, `rooms/${roomId}/players/${playerId}`);

  update(playerRef, { online: true, lastSeenAt: Date.now() });
  onDisconnect(playerRef).update({ online: false, lastSeenAt: Date.now() });

  const heartbeat = setInterval(() => {
    update(playerRef, { lastSeenAt: Date.now() });
  }, 30000);

  return () => {
    clearInterval(heartbeat);
    update(playerRef, { online: false });
  };
}
