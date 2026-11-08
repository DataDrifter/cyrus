import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLIIssueTrackerService,
	type SerializableEdgeWorkerState,
} from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { RepositoryConfig } from "../src/types.js";

// Exercise the actual disk snapshot and a fresh worker. Only tracker requests
// and the runner boundary are replaced. No server or model process is started.
describe("EdgeWorker parked session recovery", () => {
	let dir: string;
	const repo: RepositoryConfig = {
		id: "repo-1",
		name: "Recovery fixture",
		repositoryPath: "/fixture/repo",
		workspaceBaseDir: "/fixture/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "workspace-1",
		isActive: true,
	};
	const agentSession = {
		id: "session-1",
		issue: {
			id: "issue-1",
			identifier: "REC-1",
			title: "Wait for a dependency",
		},
	};
	const prompted = {
		type: "AgentSessionEvent",
		action: "prompted",
		organizationId: "workspace-1",
		agentSession,
		agentActivity: { content: { type: "prompt", body: "Resume" } },
	};

	function worker(repositories = [repo]) {
		const instance = new EdgeWorker({
			platform: "cli",
			proxyUrl: "http://localhost:1",
			cyrusHome: dir,
			repositories,
		});
		const internal = instance as any;
		const issue = {
			id: "issue-1",
			state: Promise.resolve({ type: "started" }),
			archivedAt: null,
			inverseRelations: vi.fn().mockResolvedValue({ nodes: [] }),
		};
		const tracker = {
			fetchIssue: vi.fn().mockResolvedValue(issue),
			fetchAgentSession: vi.fn().mockResolvedValue({ status: "active" }),
		};
		internal.issueTrackers.set("workspace-1", tracker);
		const initialize = vi
			.spyOn(internal, "initializeAgentRunner")
			.mockResolvedValue(undefined);
		const resume = vi
			.spyOn(internal, "handleNormalPromptedActivity")
			.mockResolvedValue(undefined);
		vi.spyOn(internal.activityPoster, "postThoughtActivity").mockResolvedValue(
			undefined,
		);
		vi.spyOn(
			internal.agentSessionManager,
			"createResponseActivity",
		).mockResolvedValue(undefined);
		return { instance, internal, issue, tracker, initialize, resume };
	}

	function park(target: ReturnType<typeof worker>, phase = "waiting") {
		target.internal.parkedSessions.set("issue-1", {
			agentSession,
			repositories: [{ ...repo, linearToken: "must-not-be-persisted" }],
			linearWorkspaceId: "workspace-1",
			guidance: [{ body: "Keep the workflow instructions", origin: "fixture" }],
			commentBody: "Original request",
			baseBranchOverrides: new Map([["repo-1", "feature-base"]]),
			routingMethod: "description-tag",
			blockingIssueIds: ["blocker-1"],
			phase,
		});
	}

	async function restart(
		source: ReturnType<typeof worker>,
		repositories = [repo],
	) {
		await source.internal.savePersistedState(true);
		const restored = worker(repositories);
		const snapshot =
			await restored.internal.persistenceManager.loadEdgeWorkerState();
		restored.instance.restoreMappings(snapshot);
		return restored;
	}

	function block(target: ReturnType<typeof worker>, state = "started") {
		target.issue.inverseRelations.mockResolvedValue({
			nodes: [
				{
					type: "blocks",
					issue: Promise.resolve({
						id: "blocker-1",
						state: Promise.resolve({ type: state }),
					}),
				},
			],
		});
	}

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "cyrus-parked-recovery-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(dir, { recursive: true, force: true });
	});

	it("durably parks a new request when dependency lookup is unavailable", async () => {
		const original = worker();
		vi.spyOn(
			original.internal.repositoryRouter,
			"determineRepositoryForWebhook",
		).mockResolvedValue({ type: "selected", repositories: [repo] });
		vi.spyOn(original.internal, "checkUserAccess").mockReturnValue({
			allowed: true,
		});
		vi.spyOn(
			original.internal,
			"linkChildSessionToParentIssueSession",
		).mockResolvedValue(undefined);
		vi.spyOn(original.internal, "fetchFullIssueDetails").mockResolvedValue(
			null,
		);
		await original.internal.handleAgentSessionCreatedWebhook(
			{ ...prompted, action: "created" },
			[repo],
		);
		expect(original.initialize).not.toHaveBeenCalled();
		const saved =
			await original.internal.persistenceManager.loadEdgeWorkerState();
		expect(saved.parkedSessions["issue-1"].agentSession.id).toBe("session-1");
		const restored = worker();
		restored.instance.restoreMappings(saved);
		await restored.internal.reconcileParkedSessions();
		expect(restored.initialize).toHaveBeenCalledOnce();
	});

	it("publishes a safe startup failure and persists error status when the requested provider is disabled", async () => {
		const target = worker();
		target.initialize.mockRestore();
		target.internal.runnerSelectionService.setConfig({
			...target.internal.config,
			defaultRunner: "cursor",
			allowedRunners: ["cursor"],
		});
		const session = {
			id: "session-1",
			status: "active",
			workspace: { path: dir },
			issue: agentSession.issue,
			issueId: "issue-1",
		};
		vi.spyOn(target.internal.agentSessionManager, "getSession").mockReturnValue(
			session,
		);
		vi.spyOn(
			target.internal.agentSessionManager,
			"serializeState",
		).mockImplementation(() => ({
			sessions: { "session-1": session },
			entries: {},
		}));
		vi.spyOn(target.internal, "postInstantAcknowledgment").mockResolvedValue(
			undefined,
		);
		vi.spyOn(target.internal, "createCyrusAgentSession").mockResolvedValue({
			session,
			fullIssue: { ...agentSession.issue, description: "[agent=claude]" },
			workspace: session.workspace,
			attachmentResult: { manifest: "" },
			allowedDirectories: [dir],
		});
		vi.spyOn(target.internal, "fetchIssueLabels").mockResolvedValue([]);
		vi.spyOn(
			target.internal,
			"determineSystemPromptFromLabels",
		).mockResolvedValue(null);
		vi.spyOn(target.internal, "assemblePrompt").mockResolvedValue({
			userPrompt: "Build this",
			metadata: { components: [] },
		});
		const createRunner = vi.spyOn(target.internal, "createRunnerForType");
		const postActivity = vi.fn().mockResolvedValue({ success: true });
		(target.tracker as any).createAgentActivity = postActivity;
		await expect(
			target.internal.initializeAgentRunner(
				agentSession,
				[repo],
				"workspace-1",
			),
		).rejects.toThrow("not permitted");
		expect(createRunner).not.toHaveBeenCalled();
		expect(session.status).toBe("error");
		expect(postActivity).toHaveBeenCalledWith({
			agentSessionId: "session-1",
			content: {
				type: "error",
				body: expect.stringContaining(
					"Check the selected provider, its account",
				),
			},
		});
		const saved =
			await target.internal.persistenceManager.loadEdgeWorkerState();
		expect(saved.agentSessions["session-1"].status).toBe("error");
	});

	it("marks the CLI remote session as failed without publishing setup exception details", async () => {
		const target = worker();
		target.initialize.mockRestore();
		const tracker = new CLIIssueTrackerService();
		tracker.seedDefaultData();
		const issue = await tracker.createIssue({
			title: "Startup failure",
			teamId: "team-default",
		});
		const remote = await (
			await tracker.createAgentSessionOnIssue({ issueId: issue.id })
		).agentSession;
		target.internal.issueTrackers.set("workspace-1", tracker);
		vi.spyOn(target.internal, "postInstantAcknowledgment").mockResolvedValue(
			undefined,
		);
		const upstream = new Error("credential=fixture-secret upstream response");
		vi.spyOn(target.internal, "createCyrusAgentSession").mockRejectedValue(
			upstream,
		);
		await expect(
			target.internal.initializeAgentRunner(
				{ id: remote!.id, issue },
				[repo],
				"workspace-1",
			),
		).rejects.toBe(upstream);
		expect((await tracker.fetchAgentSession(remote!.id)).status).toBe("error");
		const activities = tracker.listAgentActivities(remote!.id);
		expect(activities).toHaveLength(1);
		expect(activities[0]?.type).toBe("error");
		expect(activities[0]?.content).toContain("local Cyrus log");
		expect(activities[0]?.content).not.toContain("fixture-secret");
	});

	it("restores complete replay context without repository credentials", async () => {
		const original = worker();
		park(original);
		const restored = await restart(original);
		const snapshot = restored.instance.serializeMappings();
		expect(JSON.stringify(snapshot)).not.toContain("must-not-be-persisted");
		expect(snapshot.parkedSessions?.["issue-1"]).toMatchObject({
			agentSession,
			repositoryIds: ["repo-1"],
			guidance: [{ body: "Keep the workflow instructions", origin: "fixture" }],
			commentBody: "Original request",
			baseBranchOverrides: { "repo-1": "feature-base" },
			routingMethod: "description-tag",
			blockingIssueIds: ["blocker-1"],
		});
		expect(
			restored.internal.parkedSessions.get("issue-1").baseBranchOverrides,
		).toEqual(new Map([["repo-1", "feature-base"]]));
		block(restored);
		await restored.internal.reconcileParkedSessions();
		expect(restored.initialize).not.toHaveBeenCalled();
		expect(restored.internal.parkedSessions.has("issue-1")).toBe(true);
	});

	it("starts once when a dependency completed offline and uses current repository configuration", async () => {
		const original = worker();
		park(original);
		const currentRepo = { ...repo, repositoryPath: "/fixture/current-repo" };
		const restored = await restart(original, [currentRepo]);
		block(restored, "completed");
		let releaseStart!: () => void;
		const starting = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		restored.initialize.mockImplementation(async () => starting);
		const first = restored.internal.reconcileParkedSessions();
		await vi.waitFor(() => expect(restored.initialize).toHaveBeenCalledOnce());
		const claimed =
			await restored.internal.persistenceManager.loadEdgeWorkerState();
		expect(claimed.parkedSessions["issue-1"].phase).toBe("starting");
		await restored.internal.reconcileParkedSessions();
		await restored.internal.handleIssueStateChange({
			organizationId: "workspace-1",
			data: { id: "blocker-1", stateId: "done" },
		});
		expect(restored.initialize).toHaveBeenCalledOnce();
		expect(restored.initialize).toHaveBeenCalledWith(
			agentSession,
			[expect.objectContaining(currentRepo)],
			"workspace-1",
			expect.any(Array),
			"Original request",
			new Map([["repo-1", "feature-base"]]),
			"description-tag",
		);
		releaseStart();
		await first;
		const again = await restart(restored);
		await again.internal.reconcileParkedSessions();
		expect(again.initialize).not.toHaveBeenCalled();
		expect(again.internal.parkedSessions.size).toBe(0);
	});

	it.each([
		"tracker error",
		"unknown issue state",
		"unknown issue state type",
		"unknown session state",
		"unknown blocker state",
		"incomplete pagination",
	])("retains parked work after %s", async (failure) => {
		const original = worker();
		park(original);
		const restored = await restart(original);
		if (failure === "tracker error")
			restored.tracker.fetchIssue.mockRejectedValue(new Error("offline"));
		if (failure === "unknown issue state")
			restored.issue.state = Promise.resolve(undefined as any);
		if (failure === "unknown issue state type")
			restored.issue.state = Promise.resolve({} as any);
		if (failure === "unknown session state")
			restored.tracker.fetchAgentSession.mockResolvedValue({});
		if (failure === "unknown blocker state")
			restored.issue.inverseRelations.mockResolvedValue({
				nodes: [
					{ type: "blocks", issue: Promise.resolve({ id: "blocker-1" }) },
				],
			});
		if (failure === "incomplete pagination")
			restored.issue.inverseRelations.mockResolvedValue({
				nodes: [],
				pageInfo: { hasNextPage: true },
			});
		await restored.internal.reconcileParkedSessions();
		expect(restored.initialize).not.toHaveBeenCalled();
		expect(restored.internal.parkedSessions.has("issue-1")).toBe(true);
		const again = await restart(restored);
		expect(again.internal.parkedSessions.has("issue-1")).toBe(true);
	});

	it("checks all dependency pages before resuming", async () => {
		const original = worker();
		park(original);
		const restored = await restart(original);
		restored.issue.inverseRelations
			.mockResolvedValueOnce({
				nodes: [],
				pageInfo: { hasNextPage: true, endCursor: "page-2" },
			})
			.mockResolvedValueOnce({
				nodes: [
					{
						type: "blocks",
						issue: Promise.resolve({
							id: "late-blocker",
							state: Promise.resolve({ type: "started" }),
						}),
					},
				],
				pageInfo: { hasNextPage: false },
			});
		await restored.internal.reconcileParkedSessions();
		expect(restored.initialize).not.toHaveBeenCalled();
		expect(restored.issue.inverseRelations).toHaveBeenLastCalledWith({
			first: 100,
			after: "page-2",
		});
		expect(
			restored.internal.parkedSessions.get("issue-1").blockingIssueIds,
		).toEqual(["late-blocker"]);
	});

	it.each([
		"completed",
		"canceled",
		"archived",
		"ended session",
		"complete session",
		"error session",
	])("never replays a %s issue or session", async (closed) => {
		const original = worker();
		park(original);
		const restored = await restart(original);
		if (closed === "archived") restored.issue.archivedAt = new Date() as any;
		else if (closed === "ended session")
			restored.tracker.fetchAgentSession.mockResolvedValue({
				status: "active",
				endedAt: new Date(),
			});
		else if (closed.endsWith("session"))
			restored.tracker.fetchAgentSession.mockResolvedValue({
				status: closed.split(" ")[0],
			});
		else restored.issue.state = Promise.resolve({ type: closed });
		await restored.internal.reconcileParkedSessions();
		expect(restored.initialize).not.toHaveBeenCalled();
		expect(restored.internal.parkedSessions.size).toBe(0);
		const again = await restart(restored);
		expect(again.internal.parkedSessions.size).toBe(0);
	});

	it("persists stop before a pending tracker request can start the runner", async () => {
		const original = worker();
		park(original);
		const restored = await restart(original);
		let finishLookup!: (value: typeof restored.issue) => void;
		restored.tracker.fetchIssue.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishLookup = resolve;
				}),
		);
		const waking = restored.internal.reconcileParkedSessions();
		await restored.internal.handleStopSignal({
			...prompted,
			agentActivity: { signal: "stop" },
		});
		finishLookup(restored.issue);
		await waking;
		expect(restored.initialize).not.toHaveBeenCalled();
		const again = await restart(restored);
		expect(again.internal.parkedSessions.size).toBe(0);
	});

	it("persists unassignment even when the issue has no cached repository or session", async () => {
		const original = worker();
		park(original);
		const restored = await restart(original);
		await restored.internal.handleIssueUnassignedWebhook({
			organizationId: "workspace-1",
			notification: { issue: agentSession.issue },
		});
		const again = await restart(restored);
		await again.internal.reconcileParkedSessions();
		expect(again.initialize).not.toHaveBeenCalled();
		expect(again.internal.parkedSessions.size).toBe(0);
	});

	it("holds an interrupted start until an explicit matching resume prompt", async () => {
		const original = worker();
		park(original);
		original.initialize.mockRejectedValue(
			new Error("interrupted while starting"),
		);
		await original.internal.reconcileParkedSessions();
		expect(original.initialize).toHaveBeenCalledOnce();
		const restored = await restart(original);
		await restored.internal.reconcileParkedSessions();
		expect(restored.initialize).not.toHaveBeenCalled();
		await restored.internal.handleAgentSessionCreatedWebhook(
			{ ...prompted, action: "created" },
			[repo],
		);
		expect(restored.internal.parkedSessions.get("issue-1").phase).toBe(
			"starting",
		);
		await restored.internal.handleParkedSessionReprompt(
			{
				...prompted,
				agentSession: { ...agentSession, id: "unrelated-session" },
			},
			"issue-1",
		);
		expect(restored.initialize).not.toHaveBeenCalled();
		await restored.internal.handleParkedSessionReprompt(prompted, "issue-1");
		expect(restored.initialize).toHaveBeenCalledOnce();
	});

	it("rechecks blockers before explicitly resuming a saved session", async () => {
		const original = worker();
		park(original, "starting");
		const restored = await restart(original);
		vi.spyOn(
			restored.internal.agentSessionManager,
			"getSession",
		).mockReturnValue({ id: "session-1" });
		block(restored);
		await restored.internal.handleParkedSessionReprompt(prompted, "issue-1");
		expect(restored.resume).not.toHaveBeenCalled();
		block(restored, "completed");
		await restored.internal.handleParkedSessionReprompt(prompted, "issue-1");
		expect(restored.resume).toHaveBeenCalledOnce();
		expect(restored.initialize).not.toHaveBeenCalled();
	});

	it("delivers steering prompts to a live runner while its start journal is retained", async () => {
		const target = worker();
		park(target, "starting");
		target.internal.wakingParkedSessions.add("issue-1");
		target.internal.repositoryRouter
			.getIssueRepositoryCache()
			.set("issue-1", ["repo-1"]);
		vi.spyOn(target.internal.agentSessionManager, "getSession").mockReturnValue(
			{ id: "session-1", agentRunner: {} },
		);
		await target.internal.handleUserPromptedAgentActivity(prompted);
		expect(target.resume).toHaveBeenCalledOnce();
		expect(target.initialize).not.toHaveBeenCalled();
		expect(target.internal.parkedSessions.get("issue-1").phase).toBe(
			"starting",
		);
	});

	it("keeps parked context until a missing repository is configured again", async () => {
		const original = worker();
		park(original);
		const restored = await restart(original, []);
		await restored.internal.reconcileParkedSessions();
		expect(restored.initialize).not.toHaveBeenCalled();
		expect(
			restored.instance.serializeMappings().parkedSessions?.["issue-1"]
				?.repositoryIds,
		).toEqual(["repo-1"]);
		restored.internal.repositories.set(repo.id, repo);
		await restored.internal.reconcileParkedSessions();
		expect(restored.initialize).toHaveBeenCalledOnce();
	});

	it("does not start if its durable start claim cannot be saved", async () => {
		const original = worker();
		park(original);
		const restored = await restart(original);
		vi.spyOn(
			restored.internal.persistenceManager,
			"saveEdgeWorkerState",
		).mockRejectedValue(new Error("disk full"));
		await restored.internal.reconcileParkedSessions();
		expect(restored.initialize).not.toHaveBeenCalled();
		expect(restored.internal.parkedSessions.has("issue-1")).toBe(true);
	});

	it("loads old snapshots and rejects invalid parked records", () => {
		const target = worker();
		target.instance.restoreMappings({
			agentSessions: {},
			agentSessionEntries: {},
		});
		expect(target.internal.parkedSessions.size).toBe(0);
		park(target);
		const snapshot = target.instance.serializeMappings();
		const restored = worker();
		const bad = snapshot.parkedSessions!["issue-1"]!;
		for (const invalid of [
			{ phase: "unknown" },
			{ repositoryIds: [42] },
			{ agentSession: { ...agentSession, issue: { id: "different-issue" } } },
		]) {
			restored.instance.restoreMappings({
				parkedSessions: { "issue-1": { ...bad, ...invalid } },
			} as SerializableEdgeWorkerState);
		}
		expect(restored.internal.parkedSessions.size).toBe(0);
	});
});
