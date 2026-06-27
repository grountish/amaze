import { getDatabase, ref, onDisconnect, remove, update } from "firebase/database";
import { getFirebaseApp } from "./app";

export function setupPresence(roomId: string, playerId: string): () => void {
  const database = getDatabase(getFirebaseApp());
  const playerRef = ref(database, `rooms/${roomId}/players/${playerId}`);

  update(playerRef, { online: true, lastSeenAt: Date.now() });
  // Remove player on hard disconnect (refresh/tab-close) so they don't linger as ghosts
  onDisconnect(playerRef).remove();

  const heartbeat = setInterval(() => {
    update(playerRef, { lastSeenAt: Date.now() });
  }, 30000);

  return () => {
    clearInterval(heartbeat);
    update(playerRef, { online: false });
  };
}
