import type { GameInput, LocalGameState, Maze } from "$lib/game/types";

export function createInitialGameState(maze: Maze): LocalGameState {
  return {
    ball: {
      position: { ...maze.startPosition },
      velocity: { x: 0, y: 0 },
      radius: 12,
    },
    status: "idle",
    progress: 0,
  };
}

export function updateGame(
  state: LocalGameState,
  maze: Maze,
  gameInput: GameInput,
  deltaTime: number,
  sensitivityMul = 1.0,
): LocalGameState {
  if (state.status !== "playing") return state;

  const sensitivity = 420 * sensitivityMul;
  const friction = 0.985;

  const velocity = {
    x: (state.ball.velocity.x + gameInput.x * sensitivity * deltaTime) * friction,
    y: (state.ball.velocity.y + gameInput.y * sensitivity * deltaTime) * friction,
  };

  const position = {
    x: state.ball.position.x + velocity.x * deltaTime,
    y: state.ball.position.y + velocity.y * deltaTime,
  };

  const nextState: LocalGameState = {
    ...state,
    ball: { ...state.ball, position, velocity },
    progress: calculateProgress(position, maze),
  };

  if (isInsideHole(position, state.ball.radius, maze)) {
    return {
      ...nextState,
      status: "finished",
      progress: 100,
      finishedAt: Date.now(),
    };
  }

  return resolveWallCollisions(nextState, maze);
}

function calculateProgress(position: { x: number; y: number }, maze: Maze): number {
  const dx = maze.hole.x - maze.startPosition.x;
  const dy = maze.hole.y - maze.startPosition.y;
  const totalDistance = Math.sqrt(dx * dx + dy * dy);

  const currentDx = position.x - maze.startPosition.x;
  const currentDy = position.y - maze.startPosition.y;
  const currentDistance = Math.sqrt(currentDx * currentDx + currentDy * currentDy);

  return Math.min(100, Math.max(0, (currentDistance / totalDistance) * 100));
}

function isInsideHole(position: { x: number; y: number }, radius: number, maze: Maze): boolean {
  const dx = position.x - maze.hole.x;
  const dy = position.y - maze.hole.y;
  return Math.sqrt(dx * dx + dy * dy) < maze.hole.radius - radius / 2;
}

function resolveWallCollisions(state: LocalGameState, maze: Maze): LocalGameState {
  let position = { ...state.ball.position };
  let velocity = { ...state.ball.velocity };
  const radius = state.ball.radius;

  for (const wall of maze.walls) {
    const closestX = Math.max(wall.x, Math.min(position.x, wall.x + wall.width));
    const closestY = Math.max(wall.y, Math.min(position.y, wall.y + wall.height));
    const dx = position.x - closestX;
    const dy = position.y - closestY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < radius) {
      const safe = distance || 1;
      const overlap = radius - safe;
      position = { x: position.x + (dx / safe) * overlap, y: position.y + (dy / safe) * overlap };
      velocity = { x: velocity.x * -0.35, y: velocity.y * -0.35 };
    }
  }

  return { ...state, ball: { ...state.ball, position, velocity } };
}
