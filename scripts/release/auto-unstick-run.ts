/**
 * The I/O runner around the pure `decideUnstick` (auto-unstick.ts). Resolves the
 * live GitHub state the decision needs — the PR attached to `github.sha` and the
 * tag's current SHA — calls `decideUnstick`, and performs the tag + relabel +
 * release when (and only when) the decision is `create`.
 *
 * Staged-rollout + safety, by construction:
 *  - The expensive resolution (PR-by-commit, tag SHA) runs ONLY when the kill
 *    switch is on AND release-please genuinely aborted AND this is a push — so
 *    the common path (flag off by default, or a normal push) is zero-API.
 *  - `decideUnstick` is the single source of truth for whether to act; this
 *    runner only maps its verdict to side effects.
 *  - `abort` (tag exists at the WRONG sha) exits non-zero — fail-closed, never
 *    re-points a tag.
 *  - All I/O is injected, so every branch is unit-testable with zero secrets.
 */

import { AUTORELEASE_PENDING_LABEL, type AutoUnstickAction, decideUnstick } from "./auto-unstick"

/** release-please labels a merged-but-unpublished Release PR `autorelease: pending`; the publish flips it to `tagged`. */
export const AUTORELEASE_TAGGED_LABEL = "autorelease: tagged"

export interface MergedPrRef {
	number: number
	merged: boolean
	baseRef: string
	labels: string[]
	mergeSha: string
}

/** The injectable GitHub/git side of the runner — real impls shell out to `gh` / `git` in the workflow. */
export interface UnstickIO {
	/** The PR whose merge produced `headSha` (commits→PR association API), or null when HEAD is not a merged PR head. */
	resolveMergedPr(headSha: string): Promise<MergedPrRef | null>
	/** The SHA the tag points at, or null if the tag doesn't exist. */
	resolveTagSha(tag: string): Promise<string | null>
	createTag(tag: string, sha: string, message: string): Promise<void>
	relabelPr(prNumber: number, add: string, remove: string): Promise<void>
	/** Idempotently ensure an EMPTY GitHub Release exists for the tag (the publish chain fills notes + assets later). */
	ensureRelease(tag: string, prerelease: boolean): Promise<void>
	log(msg: string): void
}

export interface RunUnstickOpts {
	/** `vars.AUTO_UNSTICK_ENABLED` — default OFF (staged rollout); the real-release flip is the human's. */
	autoUnstickEnabled: boolean
	/** release-please's `release_created` output — true means it worked, no unstick. */
	releaseCreated: boolean
	/** `github.event_name` — only `push` is eligible. */
	eventName: string
	/** `github.sha` — the commit the workflow runs on. */
	headSha: string
	/** The release version (read from `package.json#version` at HEAD by the workflow), e.g. "0.24.0". */
	version: string
	io: UnstickIO
}

export interface RunUnstickResult {
	action: AutoUnstickAction
	reason: string
	/** true only when a tag + release were actually created. */
	performed: boolean
	exitCode: 0 | 1
}

export async function runUnstick(opts: RunUnstickOpts): Promise<RunUnstickResult> {
	const { io } = opts
	const tag = `v${opts.version}`

	// Cheap guards first: resolve the (API-costing) PR + tag state ONLY when the
	// flag is on, release-please genuinely aborted, and this is a push. The common
	// path — flag off by default, or a normal push — stays zero-API.
	const eligible = opts.autoUnstickEnabled && !opts.releaseCreated && opts.eventName === "push"
	const mergedPr = eligible ? await io.resolveMergedPr(opts.headSha) : null
	const existingTagSha = mergedPr ? await io.resolveTagSha(tag) : null

	const decision = decideUnstick({
		autoUnstickEnabled: opts.autoUnstickEnabled,
		releaseCreated: opts.releaseCreated,
		eventName: opts.eventName,
		headSha: opts.headSha,
		mergedPr,
		existingTagSha,
	})

	switch (decision.action) {
		case "disabled":
		case "noop":
			io.log(`auto-unstick: ${decision.action} — ${decision.reason}`)
			return { action: decision.action, reason: decision.reason, performed: false, exitCode: 0 }
		case "abort":
			io.log(`auto-unstick: ABORT — ${decision.reason}`)
			return { action: "abort", reason: decision.reason, performed: false, exitCode: 1 }
		case "skip": {
			// Tag already at the merge SHA. Heal a partial prior run (tag pushed, but the
			// release or relabel didn't finish) by idempotently ensuring BOTH — otherwise a
			// rerun would skip forever and `resolve` would never advance. Never a 2nd tag.
			const prerelease = opts.version.includes("-")
			await io.ensureRelease(tag, prerelease)
			await io.relabelPr(decision.prNumber as number, AUTORELEASE_TAGGED_LABEL, AUTORELEASE_PENDING_LABEL)
			io.log(`auto-unstick: skip (tag exists) — ensured release + label for ${tag}`)
			return { action: "skip", reason: decision.reason, performed: false, exitCode: 0 }
		}
		case "create": {
			// A hyphen in the version (e.g. 0.24.0-rc.1) means a prerelease GitHub Release.
			const prerelease = opts.version.includes("-")
			io.log(`auto-unstick: creating ${tag} at ${decision.tagSha} (Release PR #${decision.prNumber})`)
			await io.createTag(tag, decision.tagSha as string, `Release ${opts.version}`)
			await io.relabelPr(decision.prNumber as number, AUTORELEASE_TAGGED_LABEL, AUTORELEASE_PENDING_LABEL)
			await io.ensureRelease(tag, prerelease)
			io.log(`auto-unstick: created ${tag}, relabeled PR #${decision.prNumber} → tagged (prerelease=${prerelease})`)
			return { action: "create", reason: decision.reason, performed: true, exitCode: 0 }
		}
	}
}

// CLI entry — the `auto-unstick` release job runs `bun scripts/release/auto-unstick-run.ts`.
// Skipped on import (import.meta.main is false in the unit tests, which inject a fake IO).
// The real IO shells out to `gh` + `git`; the decision + action-mapping above are what's
// unit-tested, so this boundary stays a thin, un-mocked wrapper.
if (import.meta.main) {
	const { $ } = await import("bun")
	const repo = process.env.GITHUB_REPOSITORY ?? ""
	// github-actions[bot] identity for the annotated tag (tags need no signature —
	// main's signed-commits rule covers commits, and the tag points at the already
	// bot-signed merge commit).
	const BOT_NAME = "github-actions[bot]"
	const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"

	const realIO: UnstickIO = {
		async resolveMergedPr(headSha) {
			const res = await $`gh api ${`repos/${repo}/commits/${headSha}/pulls`} --jq ${".[0] // empty"}`.nothrow().quiet()
			// Fail LOUD on a transport/auth/rate-limit error. Returning null here would be
			// indistinguishable from "no Release PR" → a silent noop → a stuck-but-green
			// release. A commit with no PRs is exit 0 + empty output (handled below).
			if (res.exitCode !== 0) throw new Error(`gh api commits/${headSha}/pulls failed (exit ${res.exitCode}): ${res.stderr.toString().trim()}`)
			const out = res.stdout.toString().trim()
			if (!out) return null
			const pr = JSON.parse(out) as {
				number?: number
				merged_at?: string | null
				base?: { ref?: string }
				labels?: Array<{ name: string }>
				merge_commit_sha?: string
			}
			if (!pr.number) return null
			return {
				number: pr.number,
				merged: pr.merged_at != null,
				baseRef: pr.base?.ref ?? "",
				labels: (pr.labels ?? []).map((l) => l.name),
				mergeSha: pr.merge_commit_sha ?? "",
			}
		},
		async resolveTagSha(tag) {
			const ref = `${tag}^{commit}`
			const res = await $`git rev-parse --verify --quiet ${ref}`.nothrow().quiet()
			if (res.exitCode !== 0) return null
			return res.stdout.toString().trim() || null
		},
		async createTag(tag, sha, message) {
			await $`git -c user.name=${BOT_NAME} -c user.email=${BOT_EMAIL} tag -a ${tag} ${sha} -m ${message}`
			await $`git push origin ${tag}`
		},
		async relabelPr(prNumber, add, remove) {
			// `gh pr edit --add-label` FAILS if the label isn't defined in the repo. The
			// `autorelease: tagged` label won't exist on a repo that has never completed a
			// release (the v4 abort means release-please never created it). Ensure it first
			// (idempotent via --force). Found by the throwaway-repo rehearsal.
			await $`gh label create ${add} --color ededed --force`.nothrow().quiet()
			await $`gh pr edit ${String(prNumber)} --add-label ${add} --remove-label ${remove}`
		},
		async ensureRelease(tag, prerelease) {
			// Idempotent: a prior (possibly partial) run may already have created it.
			const exists = await $`gh release view ${tag}`.nothrow().quiet()
			if (exists.exitCode === 0) return
			const flags = ["release", "create", tag, "--verify-tag", "--title", tag, "--notes", "Filled by publish run."]
			if (prerelease) flags.push("--prerelease")
			await $`gh ${flags}`
		},
		log: (m) => console.log(m),
	}

	const version = process.env.VERSION?.trim() || ((await Bun.file("package.json").json()) as { version: string }).version
	const flag = (process.env.AUTO_UNSTICK_ENABLED ?? "").trim().toLowerCase()

	const result = await runUnstick({
		autoUnstickEnabled: flag === "on" || flag === "true" || flag === "1",
		releaseCreated: (process.env.RELEASE_CREATED ?? "").trim() === "true",
		eventName: process.env.EVENT_NAME ?? "",
		headSha: process.env.HEAD_SHA ?? "",
		version,
		io: realIO,
	})

	// Feed the downstream `resolve` job: `unstuck=true` (+ the tag) only when we
	// actually created the release, so the publish chain continues on exactly the
	// abort path and stays skipped (today's manual-unstick behavior) otherwise.
	const ghOut = process.env.GITHUB_OUTPUT
	if (ghOut) {
		const { appendFileSync } = await import("node:fs")
		const unstuck = result.action === "create" ? "true" : "false"
		const tagName = result.action === "create" ? `v${version}` : ""
		appendFileSync(ghOut, `unstuck=${unstuck}\ntag_name=${tagName}\n`)
	}
	process.exit(result.exitCode)
}
