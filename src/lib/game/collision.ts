import type { Wall, Vector2 } from "$lib/game/types";

export function circleAABBCollision(
  center: Vector2,
  radius: number,
  wall: Wall,
): { collides: boolean; normal: Vector2; overlap: number } {
  const closestX = Math.max(wall.x, Math.min(center.x, wall.x + wall.width));
  const closestY = Math.max(wall.y, Math.min(center.y, wall.y + wall.height));
  const dx = center.x - closestX;
  const dy = center.y - closestY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance >= radius) {
    return { collides: false, normal: { x: 0, y: 0 }, overlap: 0 };
  }

  const safe = distance || 1;
  return {
    collides: true,
    normal: { x: dx / safe, y: dy / safe },
    overlap: radius - distance,
  };
}
