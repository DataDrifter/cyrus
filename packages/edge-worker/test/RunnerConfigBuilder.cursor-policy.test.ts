import type {
	CyrusAgentSession,
	EdgeWorkerConfig,
	ILogger,
	RepositoryConfig,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import { FAILURE_MODE_PROMPT_ADDENDUM } from "../src/prompts/failureModePromptAddendum.js";
import { GITHUB_CLI_MEDIA_PROMPT_ADDENDUM } from "../src/prompts/githubCliMediaPromptAddendum.js";
import { resolvePublicationPolicy } from "../src/publicationPolicy.js";
import {
	type IssueRunnerConfigInput,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";
import { RunnerSelectionService } from "../src/RunnerSelectionService.js";

const logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
} as unknown as ILogger;
function builder(config: Partial<EdgeWorkerConfig> = {}) {
	return new RunnerConfigBuilder(
		{ buildChatAllowedTools: () => ["Read"] },
		{ buildMcpConfig: () => ({}), buildMergedMcpConfigPath: () => undefined },
		new RunnerSelectionService({
			repositories: [],
			allowedRunners: ["cursor"],
			cursorTeamId: 42,
			cursorAccountEmail: "agent@example.com",
			workspaceSupportPaths: ["_workflow", ".agents/skills"],
			cursorSettingSources: ["user", "project"],
			...config,
		}),
	);
}
function input(): IssueRunnerConfigInput {
	return {
		session: {
			issueId: "issue-1",
			workspace: { path: "/tmp/workspace" },
		} as CyrusAgentSession,
		repository: {
			id: "repo",
			name: "Repo",
			repositoryPath: "/tmp/repo",
			baseBranch: "main",
		} as RepositoryConfig,
		sessionId: "session-1",
		systemPrompt: "Use the requested complete workflow.",
		allowedTools: ["Read"],
		disallowedTools: ["WebFetch"],
		allowedDirectories: [],
		cyrusHome: "/tmp/cyrus",
		logger,
		onMessage() {},
		onError() {},
		requireLinearWorkspaceId: () => "workspace",
		plugins: [{ type: "local", path: "/tmp/complete-package" }],
		skills: ["build-auto"],
	};
}

describe("Cursor runner configuration policy", () => {
	it("forwards managed packages and the selected account into a resumed Cursor issue", () => {
		const request = input();
		request.session.cursorSessionId = "agent-existing";
		request.resumeSessionId = "agent-existing";
		const { config, runnerType } = builder().buildIssueConfig(request);
		expect(runnerType).toBe("cursor");
		expect(config.cursorTeamId).toBe(42);
		expect(config.cursorAccountEmail).toBe("agent@example.com");
		expect(config.workspaceSupportSource).toBe("/tmp/repo");
		expect(config.workspaceSupportPaths).toEqual([
			"_workflow",
			".agents/skills",
		]);
		expect(config.cursorSettingSources).toEqual(["user", "project"]);
		expect(config.resumeSessionId).toBe("agent-existing");
		expect(config.plugins).toEqual(request.plugins);
		expect(config.skills).toEqual(["build-auto"]);
	});

	it("rejects resuming a session owned by a forbidden provider", () => {
		const request = input();
		request.session.claudeSessionId = "claude-existing";
		request.resumeSessionId = "claude-existing";
		expect(() => builder().buildIssueConfig(request)).toThrow(
			"resumed issue session",
		);
	});

	it("keeps chat sessions on the same provider and account policy", () => {
		const request = {
			workspacePath: "/tmp/chat",
			workspaceName: "chat",
			systemPrompt: "Brief",
			sessionId: "chat-1",
			cyrusHome: "/tmp/cyrus",
			platformName: "linear",
			logger,
			onMessage() {},
			onError() {},
		};
		expect(builder().buildChatConfig(request).cursorTeamId).toBe(42);
		expect(() =>
			builder().buildChatConfig({
				...request,
				runnerType: "claude",
				resumeSessionId: "old",
			}),
		).toThrow("chat session");
	});

	it("replaces automatic shipping hooks with the configured local-only instructions", () => {
		const request = input();
		const policy = { mode: "local-only" } as const;
		const config = builder({ publicationPolicy: policy }).buildIssueConfig(
			request,
		).config;
		const publication = resolvePublicationPolicy(
			request.session.workspace.path,
			policy,
		);
		const provider = new RunnerSelectionService({
			repositories: [],
			allowedRunners: ["cursor"],
		}).getRunnerPolicy();
		expect(config.hooks?.Stop).toBeUndefined();
		expect(config.disallowedTools).toEqual([
			"WebFetch",
			...publication.disallowedTools,
			...provider.disallowedTools,
		]);
		expect(config.appendSystemPrompt).toBe(
			`Use the requested complete workflow.\n\n${publication.guidance}\n\n${provider.guidance}\n\n${FAILURE_MODE_PROMPT_ADDENDUM}\n\n${GITHUB_CLI_MEDIA_PROMPT_ADDENDUM}`,
		);
	});
});
