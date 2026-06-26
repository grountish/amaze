import { getAuth, signInAnonymously, onAuthStateChanged, type User } from "firebase/auth";
import { getFirebaseApp } from "./app";
import { currentPlayerId } from "$lib/stores/playerStore";

export function getFirebaseAuth() {
  return getAuth(getFirebaseApp());
}

export async function initAuth(): Promise<User> {
  const auth = getFirebaseAuth();
  const result = await signInAnonymously(auth);
  currentPlayerId.set(result.user.uid);
  return result.user;
}

export function onAuthReady(callback: (user: User | null) => void): () => void {
  const auth = getFirebaseAuth();
  return onAuthStateChanged(auth, callback);
}

export function getCurrentUser(): User | null {
  return getFirebaseAuth().currentUser;
}
