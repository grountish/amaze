export type RoomStatus = "waiting" | "countdown" | "playing" | "finished";

export type InputSource = "motion" | "keyboard" | "joystick" | "bot";

export type ShortcutState = {
  occupant: string | null;
  collapseUntil: number | null;
};

export type TrapData = {
  col: number;
  row: number;
};

export type Room = {
  id: string;
  status: RoomStatus;
  mazeId: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  winnerId?: string;
  shortcut?: ShortcutState;
  mazeGrid?: string; // base64-encoded wall bitmap
};

export type Player = {
  id: string;
  name: string;
  ready: boolean;
  online: boolean;
  inputSource: InputSource;
  progress: number;
  x?: number;
  y?: number;
  finishedAt?: number;
  lastSeenAt?: number;
};

export type GameEvent =
  | {
      type: "PLAYER_READY";
      playerId: string;
      createdAt: number;
    }
  | {
      type: "CHECKPOINT_REACHED";
      playerId: string;
      checkpointId: string;
      progress: number;
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
