export function runLogEmptyState(input: { hasRun: boolean; isRunning: boolean }): { title: string; detail: string } {
  if (!input.hasRun) {
    return input.isRunning
      ? { title: 'Starting an agent…', detail: 'Waiting for the first message.' }
      : { title: 'No agent has run yet', detail: 'Logs appear here once an agent starts working on this story.' };
  }
  return input.isRunning
    ? { title: 'Agent session started', detail: 'Analyzing repository and preparing reasoning thoughts...' }
    : { title: 'Agent session ended', detail: 'No message logs recorded.' };
}

export function formatCheckExit(exitCode: number | null): string {
  return exitCode === null ? '(no exit code)' : `(exit ${exitCode})`;
}
