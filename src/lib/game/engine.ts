import type { GameInput, LocalGameState, Maze } from "$lib/game/types";

export function createInitialGameState(maze: Maze): LocalGameState {
  return {
    ball: {
      position: { ...maze.startPosition },
      velocity: { x: 0, y: 0 },
      radius: 9,
    },
    status: "idle",
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
  };

  if (isInsideHole(position, state.ball.radius, maze)) {
    return {
      ...nextState,
      status: "finished",
      finishedAt: Date.now(),
    };
  }

  return resolveWallCollisions(nextState, maze);
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
      const nx = dx / safe, ny = dy / safe;
      const overlap = radius - safe;
      // Push out of the wall...
      position = { x: position.x + nx * overlap, y: position.y + ny * overlap };
      // ...and remove only the velocity component pushing INTO the wall, keeping
      // the tangential part so the ball SLIDES along walls instead of bouncing
      // back / stalling. No speed penalty for grazing a wall.
      const vn = velocity.x * nx + velocity.y * ny;
      if (vn < 0) {
        velocity = { x: velocity.x - vn * nx, y: velocity.y - vn * ny };
      }
    }
  }

  return { ...state, ball: { ...state.ball, position, velocity } };
}
