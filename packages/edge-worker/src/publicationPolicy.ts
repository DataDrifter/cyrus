import { execFileSync } from "node:child_process";
import type { PublicationPolicy } from "cyrus-core";

const REVIEW_WRITE_DENIALS = [
	"Bash(gh:pr create*)",
	"Bash(gh:pr edit*)",
	"Bash(gh:pr merge*)",
	"Bash(gh:api*)",
	"Bash(glab:mr create*)",
	"Bash(glab:mr update*)",
	"Bash(glab:mr merge*)",
	"Bash(glab:api*)",
	"mcp__*__create_pull_request",
	"mcp__*__update_pull_request",
	"mcp__*__merge_pull_request",
	"mcp__*__create_merge_request",
	"mcp__*__update_merge_request",
	"mcp__*__merge_merge_request",
	"mcp__*__push_files",
	"mcp__*__create_or_update_file",
];

/** Compare transport variants without logging credentials or accepting URL options. */
function repositoryIdentity(value: string): string {
	const scp = /^git@([^/:\s]+):([^\s]+)$/.exec(value);
	let url: URL;
	try {
		url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : value);
	} catch {
		throw new Error("Publication policy requires a valid Git repository URL");
	}
	if (
		!["https:", "ssh:"].includes(url.protocol) ||
		url.password ||
		url.search ||
		url.hash ||
		(url.username && !(url.protocol === "ssh:" && url.username === "git"))
	) {
		throw new Error(
			"Publication policy requires a credential-free Git repository URL",
		);
	}
	const path = url.pathname.replace(/\/$/, "").replace(/\.git$/, "");
	if (!path || path === "/") {
		throw new Error("Publication policy requires a repository path");
	}
	return `${url.host.toLowerCase()}${path}`;
}

/**
 * Validate the configured destination before starting the agent. The returned
 * guidance and known-command denials reduce accidental publication. They are
 * not a security boundary for arbitrary shell programs or broad credentials.
 */
export function resolvePublicationPolicy(
	workingDirectory: string,
	policy?: PublicationPolicy,
): { guidance: string; disallowedTools: string[] } {
	if (!policy) return { guidance: "", disallowedTools: [] };
	const disallowedTools = [...REVIEW_WRITE_DENIALS];
	const common = [
		"<publication_policy>",
		"Apply this configured publication policy throughout this session and every child or resumed session.",
		"It takes precedence over default Cyrus instructions that request pushes, PRs, MRs, or changelog links.",
		"Do not create, update, merge, or publish a PR or MR through a CLI, API, MCP tool, hook, or subagent.",
		"Do not modify remotes, credentials, or this policy to gain publishing access.",
		"Write changelog entries without a PR/MR number when this policy prevents creating one.",
	];
	if (policy.mode === "local-only") {
		disallowedTools.push("Bash(git:*push*)");
		common.push(
			"Keep commits and artifacts local. Do not push or upload repository changes.",
			"Report the local branch, commit, artifact locations, verification, and any remaining work.",
		);
	} else {
		const expected = repositoryIdentity(policy.repositoryUrl);
		let pushUrls: string[];
		try {
			pushUrls = execFileSync(
				"git",
				["remote", "get-url", "--push", "--all", "origin"],
				{
					cwd: workingDirectory,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				},
			)
				.trim()
				.split(/\r?\n/);
		} catch {
			throw new Error(
				"Publication policy could not verify origin's push destination",
			);
		}
		if (
			pushUrls.length !== 1 ||
			repositoryIdentity(pushUrls[0] ?? "") !== expected
		) {
			throw new Error(
				"Publication policy blocked an unapproved origin push destination",
			);
		}
		disallowedTools.push(
			"Bash(git:push upstream*)",
			"Bash(git:push https:*)",
			"Bash(git:push ssh:*)",
			"Bash(git:push git@*)",
		);
		common.push(
			`Only the repository ${expected} is approved for publishing requested code.`,
			"Before each push, recheck that origin has exactly the approved push URL. Stop if it changed.",
			"Push only the current task branch with git -c push.followTags=false push origin HEAD.",
			"Do not publish to another remote or explicit URL, push unrelated branches or tags, force-push, or change existing pull tracking.",
			"Report the published branch and commit without creating a PR or MR.",
		);
	}
	common.push("</publication_policy>");
	return { guidance: common.join("\n"), disallowedTools };
}
