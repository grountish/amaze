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
  score?: number; // laps won (endless morph)
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
