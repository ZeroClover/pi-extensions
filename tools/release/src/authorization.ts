import type { BatchMember } from "./batch.ts";
import { type Ledger, sameRecord } from "./ledger.ts";

/** The ledger at one first-parent commit of the default branch after the release commit. */
export interface LedgerSnapshot {
	readonly commit: string;
	readonly ledger: Ledger;
}

/**
 * Authorization continuity: every original batch record must stay present and structurally
 * unchanged in every snapshot, in order. A removal or mutation ends the preparation's
 * authority for good, even when an identical record appears again later.
 */
export function continuityProblems(members: readonly BatchMember[], snapshots: readonly LedgerSnapshot[]): string[] {
	for (const snapshot of snapshots) {
		const problems: string[] = [];
		for (const member of members) {
			const record = snapshot.ledger.get(member.key);
			if (record === undefined) {
				problems.push(`${member.key} was removed at ${snapshot.commit}`);
			} else if (!sameRecord(record, member.record)) {
				problems.push(`${member.key} was modified at ${snapshot.commit}`);
			}
		}
		if (problems.length > 0) {
			return problems;
		}
	}
	return [];
}
