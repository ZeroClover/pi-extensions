/**
 * A short human duration: `250ms`, `1.3s`, `45s`, `5m`, `5m 30s`, `2h`, `1h 15m`. Sub-minute values below ten
 * seconds keep one decimal so a provider's `1.284s` does not read as `1s`.
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const seconds = ms / 1000;
	if (seconds < 10) return `${Number(seconds.toFixed(1))}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const totalSeconds = Math.round(seconds);
	if (totalSeconds < 3600) {
		const minutes = Math.floor(totalSeconds / 60);
		const rest = totalSeconds % 60;
		return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
	}
	const totalMinutes = Math.round(totalSeconds / 60);
	const hours = Math.floor(totalMinutes / 60);
	const rest = totalMinutes % 60;
	return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Whole seconds left, rounded up, for the countdown: `30s` … `1s`. */
export function formatRemaining(ms: number): string {
	return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}
