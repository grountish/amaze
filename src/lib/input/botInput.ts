export function getNextBotProgress(currentProgress: number): number {
  return Math.min(100, currentProgress + Math.random() * 8);
}

export function startBotProgressLoop(
  onProgress: (progress: number) => void,
  intervalMs = 800,
): () => void {
  let progress = 0;
  const id = setInterval(() => {
    progress = getNextBotProgress(progress);
    onProgress(progress);
    if (progress >= 100) clearInterval(id);
  }, intervalMs);
  return () => clearInterval(id);
}
