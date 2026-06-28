export type Vector2 = {
  x: number;
  y: number;
};

export type GameInput = {
  x: number;
  y: number;
};

export type BallState = {
  position: Vector2;
  velocity: Vector2;
  radius: number;
};

export type Wall = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Hole = {
  x: number;
  y: number;
  radius: number;
};

export type Shortcut = {
  // detection zone (larger than the visual gap)
  zone: { x: number; y: number; width: number; height: number };
  // wall segment that fills the gap when collapsed
  gapWall: Wall;
};

export type Maze = {
  id: string;
  width: number;
  height: number;
  startPosition: Vector2;
  hole: Hole;
  walls: Wall[];
  checkpoints: Vector2[];
  shortcut?: Shortcut;
};

export type LocalGameState = {
  ball: BallState;
  status: "idle" | "playing" | "finished";
  startedAt?: number;
  finishedAt?: number;
};
