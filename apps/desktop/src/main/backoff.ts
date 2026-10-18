export const DEFAULT_RESTART_SCHEDULE_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];

export function restartDelay(consecutiveCrashes: number, schedule: readonly number[] = DEFAULT_RESTART_SCHEDULE_MS): number {
  return schedule[Math.min(consecutiveCrashes, schedule.length - 1)] ?? 16000;
}
