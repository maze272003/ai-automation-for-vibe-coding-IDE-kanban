export function formatUsd(value: number | null): string {
  if (value === null) return '—';
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function costLabel(summary: { costComplete: boolean; estimated: boolean }): string | null {
  const labels = [];
  if (summary.estimated) labels.push('estimated');
  if (!summary.costComplete) labels.push('incomplete');
  return labels.length ? labels.join(' · ') : null;
}
