import type { Vector2 } from "$lib/game/types";

export function applyFriction(velocity: Vector2, friction: number): Vector2 {
  return { x: velocity.x * friction, y: velocity.y * friction };
}

export function applyAcceleration(velocity: Vector2, acceleration: Vector2, dt: number): Vector2 {
  return { x: velocity.x + acceleration.x * dt, y: velocity.y + acceleration.y * dt };
}

export function integrate(position: Vector2, velocity: Vector2, dt: number): Vector2 {
  return { x: position.x + velocity.x * dt, y: position.y + velocity.y * dt };
}
