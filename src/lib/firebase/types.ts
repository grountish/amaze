export type RoomStatus = "waiting" | "countdown" | "playing" | "finished";

export type InputSource = "motion" | "keyboard" | "joystick" | "bot";

export type ShortcutState = {
  occupant: string | null;
  collapseUntil: number | null;
};

export type TrapData = {
  col: number;
  row: number;
  armAt?: number; // epoch ms when it becomes lethal; before that it only warns
  // default (undefined) = lethal to humans; "zombify" enrages all bots;
  // "bomb" = player-dropped mine, lethal to BOTS only (humans walk over it).
  kind?: "zombify" | "bomb";
};

// A projectile. Immutable + time-derived: position = origin + dir·speed·age, so
// it's written ONCE and every client computes its path locally (no per-frame
// network). Processed authoritatively by its owner.
export type ShotData = {
  owner: string;
  x: number; // origin
  y: number;
  dx: number; // unit direction
  dy: number;
  firedAt: number; // epoch ms
};

export type Room = {
  id: string;
  status: RoomStatus;
  mazeId: string; // numeric maze seed (as string); changes each lap
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  winnerId?: string;
  lap?: number; // endless-morph lap counter; bumped each win
  lastWinnerId?: string; // winner of the most recent lap (for flash/score)
  lapAt?: number; // when the current lap's maze was generated
  shortcut?: ShortcutState;
  mazeGrid?: string; // base64-encoded wall bitmap
  rage?: boolean; // true → all bots are zombies (set by zombify trap, cleared on morph)
};

export type Player = {
  id: string;
  name: string;
  ready: boolean;
  online: boolean;
  inputSource: InputSource;
  x?: number;
  y?: number;
  finishedAt?: number;
  lastSeenAt?: number;
  score?: number; // laps won (endless morph)
  hp?: number; // shots-to-die health; respawns at 0 (see MAX_HP)
};

export type GameEvent =
  | {
      type: "PLAYER_READY";
      playerId: string;
      createdAt: number;
    }
  | {
      type: "GOAL_REACHED";
      playerId: string;
      timeMs: number;
      createdAt: number;
    }
  | {
      type: "PLAYER_LEFT";
      playerId: string;
      createdAt: number;
    };
