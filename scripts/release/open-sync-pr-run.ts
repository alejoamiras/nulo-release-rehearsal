/**
 * The I/O runner around the pure sync decision (open-sync-pr.ts). On the
 * `push:main` that just published a STABLE release, it opens a `main → dev` sync
 * PR — branch FROM the exact release commit (never a local merge, never moving
 * `origin/main`), plus the prerelease-manifest re-baseline — and lets GitHub
 * compute mergeability: clean PRs are left
 * mergeable, CONFLICTING/UNKNOWN ones are labeled + commented (surfaced, never
 * silently dropped). It combines the manual runbook's two steps (merge main→dev,
 * then bump the prerelease manifest) into one PR.
 *
 * Safety, by construction:
 *  - `syncEligible` gates it to the stable Release-PR merge — a workflow_dispatch
 *    republish of an old tag is never eligible (codex Critical-1);
 *  - the Release-PR merge sha is resolved ONLY on the push+stable path, so the
 *    common path is zero-API;
 *  - idempotent: an already-open sync PR for the version → no-op;
 *  - all I/O is injected, so every branch is unit-testable with zero secrets.
 */

import { decideSyncPrAction, type Mergeability, NEEDS_RESOLUTION_LABEL, syncEligible } from "./open-sync-pr"

export const SYNC_BRANCH_PREFIX = "sync/main-to-dev-v"

/** The injectable GitHub/git side — real impls shell out to `gh` / `git`. */
export interface SyncIO {
	/** The merge_commit_sha of the merged Release PR at `headSha`, or null when HEAD is not a Release-PR merge. */
	resolveReleasePrMergeSha(headSha: string): Promise<string | null>
	/** The number of an already-open sync PR for `branch` (base dev), or null. */
	findOpenSyncPr(branch: string): Promise<number | null>
	/** Create `branch` from the release commit `baseSha`, write the prerelease-manifest re-baseline, commit + push. */
	prepareSyncBranch(branch: string, baseSha: string, version: string): Promise<void>
	/** Open the `branch → dev` PR (via the App token so dev's CI fires); returns the PR number. */
	openPr(branch: string, title: string, body: string): Promise<number>
	/** GitHub's computed mergeability (the impl polls until it's no longer UNKNOWN, bounded). */
	mergeability(prNumber: number): Promise<Mergeability>
	flagConflict(prNumber: number, label: string, comment: string): Promise<void>
	log(msg: string): void
}

export interface RunSyncOpts {
	eventName: string
	isPrerelease: boolean
	headSha: string
	/** the stable release version, e.g. "0.24.0" — names the branch + the manifest re-baseline. */
	version: string
	io: SyncIO
}

export type SyncAction = "skip" | "exists" | "opened-clean" | "opened-conflict"

export interface RunSyncResult {
	action: SyncAction
	reason: string
	prNumber: number | null
	exitCode: 0 | 1
}

export async function runSync(opts: RunSyncOpts): Promise<RunSyncResult> {
	const { io } = opts

	// Resolve the Release-PR merge sha ONLY on the eligible-looking path (a stable
	// push), so a workflow_dispatch / prerelease run stays zero-API.
	const worthResolving = opts.eventName === "push" && !opts.isPrerelease
	const releasePrMergeSha = worthResolving ? await io.resolveReleasePrMergeSha(opts.headSha) : null

	const el = syncEligible({
		eventName: opts.eventName,
		isPrerelease: opts.isPrerelease,
		headSha: opts.headSha,
		releasePrMergeSha,
	})
	if (!el.eligible) {
		io.log(`sync: skip — ${el.reason}`)
		return { action: "skip", reason: el.reason, prNumber: null, exitCode: 0 }
	}

	const branch = `${SYNC_BRANCH_PREFIX}${opts.version}`
	const existing = await io.findOpenSyncPr(branch)
	if (existing !== null) {
		io.log(`sync: an open sync PR (#${existing}) already exists for ${branch} — idempotent no-op`)
		return { action: "exists", reason: "sync PR already open", prNumber: existing, exitCode: 0 }
	}

	await io.prepareSyncBranch(branch, opts.headSha, opts.version)
	const title = "chore: sync main → dev"
	const body =
		`Post-release sync of \`main\` → \`dev\` for **v${opts.version}** — brings the release version bump + ` +
		`\`CHANGELOG.md\` into \`dev\` and re-baselines \`.release-please-prerelease-manifest.json\` to \`${opts.version}\` ` +
		`(so the next rc series cuts from the right base). Squash-merge via the UI (GitHub signs the squash commit). ` +
		`See CLAUDE.md § "After a stable cut promotes to main".`
	const pr = await io.openPr(branch, title, body)

	const mergeable = await io.mergeability(pr)
	const decision = decideSyncPrAction(mergeable)
	if (decision.clean) {
		io.log(`sync: opened #${pr} — GitHub computed MERGEABLE`)
		return { action: "opened-clean", reason: "mergeable", prNumber: pr, exitCode: 0 }
	}
	const comment =
		`GitHub computed this \`main → dev\` sync as **${mergeable}**. Resolve manually (usually \`CHANGELOG.md\` or ` +
		`\`bun.lock\`), then squash-merge. This is expected when \`dev\` has diverged since the release — it's surfaced, ` +
		`not auto-merged, by design.`
	await io.flagConflict(pr, decision.label as string, comment)
	io.log(`sync: opened #${pr} + labeled '${decision.label}' (${mergeable}) — needs manual resolution`)
	return { action: "opened-conflict", reason: mergeable, prNumber: pr, exitCode: 0 }
}

// CLI entry — the `sync-main-to-dev` release job runs `bun scripts/release/open-sync-pr-run.ts`.
// Skipped on import (import.meta.main is false in the unit tests, which inject a fake IO).
if (import.meta.main) {
	const { $ } = await import("bun")
	const repo = process.env.GITHUB_REPOSITORY ?? ""
	const PRERELEASE_MANIFEST = ".release-please-prerelease-manifest.json"
	const BOT_NAME = "github-actions[bot]"
	const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"

	const realIO: SyncIO = {
		async resolveReleasePrMergeSha(headSha) {
			const res = await $`gh api ${`repos/${repo}/commits/${headSha}/pulls`} --jq ${".[]"}`.nothrow().quiet()
			if (res.exitCode !== 0) return null
			const lines = res.stdout.toString().trim()
			if (!lines) return null
			// `gh api --jq '.[]'` prints one JSON object per line.
			for (const line of lines.split("\n")) {
				if (!line.trim()) continue
				const pr = JSON.parse(line) as {
					merged_at?: string | null
					base?: { ref?: string }
					labels?: Array<{ name: string }>
					merge_commit_sha?: string
				}
				const labels = (pr.labels ?? []).map((l) => l.name)
				const isReleasePr = pr.merged_at != null && pr.base?.ref === "main" && (labels.includes("autorelease: tagged") || labels.includes("autorelease: pending"))
				if (isReleasePr && pr.merge_commit_sha) return pr.merge_commit_sha
			}
			return null
		},
		async findOpenSyncPr(branch) {
			const res = await $`gh pr list --head ${branch} --base dev --state open --json number --jq ${".[0].number // empty"}`.nothrow().quiet()
			if (res.exitCode !== 0) return null
			const out = res.stdout.toString().trim()
			return out ? Number(out) : null
		},
		async prepareSyncBranch(branch, baseSha, version) {
			// Branch from the EXACT release commit, not live origin/main — if another PR
			// lands on main during the long release run, the sync must still carry only the
			// released state (baseSha == github.sha, already present from fetch-depth: 0).
			await $`git checkout -B ${branch} ${baseSha}`
			await Bun.write(PRERELEASE_MANIFEST, `${JSON.stringify({ ".": version }, null, 2)}\n`)
			await $`git -c user.name=${BOT_NAME} -c user.email=${BOT_EMAIL} add ${PRERELEASE_MANIFEST}`
			// --allow-empty: if main already carries this manifest value, the sync PR still
			// opens (it carries main's release commits into dev even with no manifest delta).
			await $`git -c user.name=${BOT_NAME} -c user.email=${BOT_EMAIL} commit --allow-empty -m ${`chore: re-baseline prerelease manifest to ${version}`}`
			// Fresh per-version branch on the normal path. A non-fast-forward here means a
			// stale branch from a prior partial run (the push landed but openPr then failed) —
			// fail loud so a human deletes it + re-runs, rather than force-pushing.
			await $`git push -u origin ${branch}`
		},
		async openPr(branch, title, body) {
			const out = await $`gh pr create --base dev --head ${branch} --title ${title} --body ${body}`.text()
			// `gh pr create` prints the PR URL; the trailing path segment is the number.
			const m = out.trim().match(/\/pull\/(\d+)\s*$/)
			if (!m) throw new Error(`could not parse PR number from: ${out.trim()}`)
			return Number(m[1])
		},
		async mergeability(prNumber) {
			for (let i = 0; i < 10; i++) {
				const res = await $`gh pr view ${String(prNumber)} --json mergeable --jq .mergeable`.nothrow().quiet()
				const v = res.stdout.toString().trim()
				if (v === "MERGEABLE" || v === "CONFLICTING") return v
				await new Promise((r) => setTimeout(r, 3000))
			}
			return "UNKNOWN" // bounded wait elapsed → fail-closed (labeled for a human)
		},
		async flagConflict(prNumber, label, comment) {
			// `gh pr edit --add-label` FAILS if the label isn't defined in the repo yet —
			// `needs-manual-resolution` won't exist on a fresh repo. Ensure it first
			// (idempotent via --force). Same class of bug the rehearsal found on auto-unstick.
			await $`gh label create ${label} --color d93f0b --force`.nothrow().quiet()
			await $`gh pr edit ${String(prNumber)} --add-label ${label}`
			await $`gh pr comment ${String(prNumber)} --body ${comment}`
		},
		log: (m) => console.log(m),
	}

	const result = await runSync({
		eventName: process.env.EVENT_NAME ?? "",
		isPrerelease: (process.env.IS_PRERELEASE ?? "").trim() === "true",
		headSha: process.env.HEAD_SHA ?? "",
		version: process.env.VERSION?.trim() || "",
		io: realIO,
	})
	console.log(`sync result: ${result.action} (${result.reason})${result.prNumber ? ` → PR #${result.prNumber}` : ""}`)
	process.exit(result.exitCode)
}
