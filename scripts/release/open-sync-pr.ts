/**
 * Decision core for the post-release `main → dev` sync. Two pure pieces; the
 * branch/PR/label side-effects are workflow glue.
 *
 *  1. `syncEligible` — the trigger guard. The sync must fire ONLY on the
 *     `push:main` that just merged a stable Release PR, NOT on a
 *     `workflow_dispatch` republish of an old tag (which would re-touch the
 *     sync flow for, e.g., v0.20.0 — the misfire codex flagged).
 *  2. `decideSyncPrAction` — given GitHub's computed mergeability, never do a
 *     local merge: open the PR and either leave it mergeable or label it for a
 *     human. Fail-closed: anything not cleanly MERGEABLE gets surfaced, never
 *     silently dropped.
 */

export const NEEDS_RESOLUTION_LABEL = "needs-manual-resolution"

export interface SyncEligibleInput {
	eventName: string
	/** the resolved release's prerelease-ness (rc cuts don't sync to dev). */
	isPrerelease: boolean
	/** `github.sha` of this run. */
	headSha: string
	/** the merge commit of the just-merged Release PR, or null if none. */
	releasePrMergeSha: string | null
}

export function syncEligible(input: SyncEligibleInput): { eligible: boolean; reason: string } {
	if (input.eventName !== "push") {
		return { eligible: false, reason: "not a push (a workflow_dispatch republish must never re-sync)" }
	}
	if (input.isPrerelease) {
		return { eligible: false, reason: "prerelease cut — main→dev sync is for stable releases only" }
	}
	if (!input.releasePrMergeSha || input.headSha !== input.releasePrMergeSha) {
		return { eligible: false, reason: "HEAD is not the just-merged stable Release-PR commit" }
	}
	return { eligible: true, reason: "stable Release-PR merge on push:main" }
}

export type Mergeability = "MERGEABLE" | "CONFLICTING" | "UNKNOWN"

export interface SyncPrAction {
	/** label to apply (null = none). */
	label: string | null
	/** whether the PR is ready to merge cleanly. */
	clean: boolean
}

export function decideSyncPrAction(mergeable: Mergeability): SyncPrAction {
	// Fail-closed: only an explicit MERGEABLE is "clean"; CONFLICTING and the
	// not-yet-computed UNKNOWN both get surfaced for a human.
	if (mergeable === "MERGEABLE") return { label: null, clean: true }
	return { label: NEEDS_RESOLUTION_LABEL, clean: false }
}
