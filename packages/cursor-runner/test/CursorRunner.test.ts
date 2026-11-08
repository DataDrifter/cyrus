import crypto from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SDKResultMessage } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock for @cursor/sdk so we can drive Agent.create / Agent.resume
// from inside each test.
const sdkMock = vi.hoisted(() => {
	const create = vi.fn();
	const resume = vi.fn();
	const me = vi.fn();
	return {
		create,
		resume,
		me,
		// Helper for tests to install a stub agent + run.
		__install(opts: {
			agentId?: string;
			events: any[];
			deltas?: any[];
			throwOnSend?: Error | undefined;
		}) {
			const {
				agentId = "agent-test-1",
				events,
				deltas = [],
				throwOnSend,
			} = opts;
			const stubAgent = {
				agentId,
				model: undefined,
				close: vi.fn(),
				reload: vi.fn(),
				listArtifacts: vi.fn(),
				downloadArtifact: vi.fn(),
				[Symbol.asyncDispose]: vi.fn(),
				send: vi.fn().mockImplementation(async (_msg, options) => {
					if (throwOnSend) throw throwOnSend;
					if (options?.onDelta) {
						for (const update of deltas) {
							await options.onDelta({ update });
						}
					}
					const stubRun = {
						id: "run-1",
						agentId,
						supports: () => true,
						unsupportedReason: () => undefined,
						stream: async function* () {
							for (const ev of events) yield ev;
						},
						conversation: async () => [],
						wait: async () => ({
							id: "run-1",
							status: "finished" as const,
						}),
						cancel: vi.fn().mockResolvedValue(undefined),
						status: "finished" as const,
						onDidChangeStatus: () => () => {},
						result: undefined,
						model: undefined,
						durationMs: 0,
						git: undefined,
						createdAt: 0,
					};
					return stubRun;
				}),
			};
			create.mockResolvedValue(stubAgent);
			resume.mockResolvedValue(stubAgent);
			return stubAgent;
		},
	};
});

vi.mock("@cursor/sdk", () => ({
	Cursor: { me: sdkMock.me },
	Agent: {
		create: sdkMock.create,
		resume: sdkMock.resume,
	},
}));

const authMock = vi.hoisted(() => ({ loadCyrusCursorApiKey: vi.fn() }));
vi.mock("../src/authentication.js", () => authMock);

const sqliteMock = vi.hoisted(() => {
	const dispose = vi.fn().mockResolvedValue(undefined);
	const store = { dispose };
	return {
		dispose,
		store,
		open: vi.fn().mockResolvedValue(store),
	};
});

vi.mock("@cursor/sdk/sqlite", () => ({
	SqliteLocalAgentStore: { open: sqliteMock.open },
}));

let CursorRunner: typeof import("../src/CursorRunner.js").CursorRunner;
let tempDirs: string[];

beforeEach(async () => {
	sdkMock.create.mockReset();
	sdkMock.resume.mockReset();
	sdkMock.me.mockReset().mockResolvedValue({ userEmail: "member@example.com" });
	authMock.loadCyrusCursorApiKey.mockReset().mockResolvedValue(undefined);
	vi.stubEnv("CURSOR_API_KEY", undefined);
	sqliteMock.dispose.mockClear();
	sqliteMock.open.mockReset().mockResolvedValue(sqliteMock.store);
	tempDirs = [];
	({ CursorRunner } = await import("../src/CursorRunner.js"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempWorkspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-runner-"));
	tempDirs.push(dir);
	return dir;
}

describe("CursorRunner (SDK adapter)", () => {
	it("installs and uninstalls .cursor permission artifacts around a session", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-test-1",
					run_id: "run-1",
				},
				{
					type: "assistant",
					agent_id: "agent-test-1",
					run_id: "run-1",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
					},
				},
				{
					type: "status",
					agent_id: "agent-test-1",
					run_id: "run-1",
					status: "FINISHED",
				},
			],
		});

		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: workspace,
			allowedTools: ["Read(src/**)"],
		});

		// While running we expect the artifacts to be present, but since the
		// stream runs synchronously to completion we instead verify the cleanup.
		await runner.start("hello");

		expect(existsSync(join(workspace, ".cursor", "hooks.json"))).toBe(false);
		expect(
			existsSync(join(workspace, ".cursor", "cyrus-permissions.json")),
		).toBe(false);
		expect(
			existsSync(join(workspace, ".cursor", "cyrus-permission-check.mjs")),
		).toBe(false);
	});

	it("emits init, assistant text, and result messages", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			agentId: "agent-emit",
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-emit",
					run_id: "run-1",
				},
				{
					type: "assistant",
					agent_id: "agent-emit",
					run_id: "run-1",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Hello world" }],
					},
				},
				{
					type: "status",
					agent_id: "agent-emit",
					run_id: "run-1",
					status: "FINISHED",
				},
			],
		});

		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: workspace,
		});
		const session = await runner.start("hi");
		const messages = runner.getMessages();

		expect(session.sessionId).toBe("agent-emit");
		expect(messages[0]?.type).toBe("system");
		const assistant = messages.find((m) => m.type === "assistant");
		expect(assistant).toBeDefined();
		const result = messages[messages.length - 1];
		expect(result?.type).toBe("result");
	});

	it("uses a cyrusHome-scoped SQLite store for Agent.create", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({ events: [] });

		const runner = new CursorRunner({ cyrusHome, workingDirectory: workspace });
		await runner.start("hi");

		const stateKey = crypto
			.createHash("sha256")
			.update(workspace)
			.digest("hex");
		expect(sqliteMock.open).toHaveBeenCalledWith({
			workspaceRef: workspace,
			stateRoot: join(cyrusHome, "cursor-sdk-state", stateKey),
		});
		expect(sdkMock.create).toHaveBeenCalledWith(
			expect.objectContaining({
				local: expect.objectContaining({
					cwd: workspace,
					store: sqliteMock.store,
				}),
			}),
		);
		expect(sqliteMock.dispose).toHaveBeenCalledOnce();
	});

	it("accumulates token usage from turn-ended deltas into the result message", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			agentId: "agent-tokens",
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-tokens",
					run_id: "r",
				},
				{
					type: "status",
					agent_id: "agent-tokens",
					run_id: "r",
					status: "FINISHED",
				},
			],
			deltas: [
				{
					type: "turn-ended",
					usage: {
						inputTokens: 100,
						outputTokens: 50,
						cacheReadTokens: 10,
						cacheWriteTokens: 5,
					},
				},
				{
					type: "turn-ended",
					usage: {
						inputTokens: 200,
						outputTokens: 75,
						cacheReadTokens: 20,
						cacheWriteTokens: 0,
					},
				},
				// Non-token-bearing delta should not affect totals.
				{ type: "text-delta", text: "hello" },
			],
		});

		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: workspace,
		});
		await runner.start("hi");

		const resultMessage = runner
			.getMessages()
			.find((m): m is SDKResultMessage => m.type === "result");
		expect(resultMessage).toBeDefined();
		const usage = resultMessage!.usage;
		expect(usage.input_tokens).toBe(300);
		expect(usage.output_tokens).toBe(125);
		expect(usage.cache_read_input_tokens).toBe(30);
		expect(usage.cache_creation_input_tokens).toBe(5);
	});

	it("coalesces consecutive assistant text deltas into a single message", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			agentId: "agent-coalesce",
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-coalesce",
					run_id: "r",
				},
				{
					type: "assistant",
					agent_id: "agent-coalesce",
					run_id: "r",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Expl" }],
					},
				},
				{
					type: "assistant",
					agent_id: "agent-coalesce",
					run_id: "r",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "oring " }],
					},
				},
				{
					type: "assistant",
					agent_id: "agent-coalesce",
					run_id: "r",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "the codebase." }],
					},
				},
				{
					type: "tool_call",
					agent_id: "agent-coalesce",
					run_id: "r",
					call_id: "tc-1",
					name: "shell",
					status: "completed",
					args: { command: "ls" },
					result: "ok",
				},
				{
					type: "assistant",
					agent_id: "agent-coalesce",
					run_id: "r",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Found " }],
					},
				},
				{
					type: "assistant",
					agent_id: "agent-coalesce",
					run_id: "r",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "the file." }],
					},
				},
				{
					type: "status",
					agent_id: "agent-coalesce",
					run_id: "r",
					status: "FINISHED",
				},
			],
		});

		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: workspace,
		});
		await runner.start("hi");
		type Block = { type: string; text?: string };
		const assistantTexts: string[] = [];
		for (const m of runner.getMessages() as Array<{
			type: string;
			message?: { content?: unknown };
		}>) {
			if (m.type !== "assistant") continue;
			const content = m.message?.content;
			if (!Array.isArray(content)) continue;
			const text = (content as Block[])
				.filter((b) => b?.type === "text")
				.map((b) => b.text ?? "")
				.join("");
			if (text.length > 0) assistantTexts.push(text);
		}

		// Two assistant turns separated by a tool_use should produce exactly two
		// coalesced messages, not seven (one per delta).
		expect(assistantTexts).toHaveLength(2);
		expect(assistantTexts[0]).toBe("Exploring the codebase.");
		expect(assistantTexts[1]).toBe("Found the file.");
	});

	it("maps tool_call events with status=completed into tool_use + tool_result", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-tc",
					run_id: "r",
				},
				{
					type: "tool_call",
					agent_id: "agent-tc",
					run_id: "r",
					call_id: "tc-1",
					name: "shell",
					status: "completed",
					args: { command: "ls -la" },
					result: "file1\nfile2",
				},
				{
					type: "status",
					agent_id: "agent-tc",
					run_id: "r",
					status: "FINISHED",
				},
			],
		});

		const runner = new CursorRunner({ cyrusHome, workingDirectory: workspace });
		await runner.start("run a tool");

		const msgs = runner.getMessages();
		const toolUse = msgs.find(
			(m) =>
				m.type === "assistant" &&
				Array.isArray((m as any).message?.content) &&
				(m as any).message.content[0]?.type === "tool_use",
		);
		const toolResult = msgs.find(
			(m) =>
				m.type === "user" &&
				Array.isArray((m as any).message?.content) &&
				(m as any).message.content[0]?.type === "tool_result",
		);
		expect(toolUse).toBeDefined();
		expect(toolResult).toBeDefined();
		expect((toolUse as any).message.content[0].name).toBe("Bash");
		expect((toolResult as any).message.content[0].content).toBe("file1\nfile2");
	});

	it("maps mcp tool_use blocks into mcp__server__tool names", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-mcp",
					run_id: "r",
				},
				{
					type: "assistant",
					agent_id: "agent-mcp",
					run_id: "r",
					message: {
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tu-1",
								name: "mcp",
								input: {
									providerIdentifier: "linear",
									toolName: "list_issues",
									args: { teamId: "abc" },
								},
							},
						],
					},
				},
				{
					type: "status",
					agent_id: "agent-mcp",
					run_id: "r",
					status: "FINISHED",
				},
			],
		});

		const runner = new CursorRunner({ cyrusHome, workingDirectory: workspace });
		await runner.start("call mcp");
		const msgs = runner.getMessages();
		const tu = msgs.find(
			(m) =>
				m.type === "assistant" &&
				(m as any).message.content[0]?.type === "tool_use",
		) as any;
		expect(tu.message.content[0].name).toBe("mcp__linear__list_issues");
		expect(tu.message.content[0].input).toEqual({ teamId: "abc" });
	});

	it("uses Agent.resume when resumeSessionId is provided", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			agentId: "agent-resumed",
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-resumed",
					run_id: "r",
				},
				{
					type: "status",
					agent_id: "agent-resumed",
					run_id: "r",
					status: "FINISHED",
				},
			],
		});

		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: workspace,
			resumeSessionId: "agent-resumed",
		});
		await runner.start("continue");
		expect(sdkMock.resume).toHaveBeenCalledTimes(1);
		expect(sdkMock.create).not.toHaveBeenCalled();
		expect(sdkMock.resume).toHaveBeenCalledWith(
			"agent-resumed",
			expect.objectContaining({
				local: expect.objectContaining({
					cwd: workspace,
					store: sqliteMock.store,
				}),
			}),
		);
		expect(sqliteMock.dispose).toHaveBeenCalledOnce();
	});

	it("emits an error result when SDK send throws", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			events: [],
			throwOnSend: new Error("auth boom"),
		});

		const runner = new CursorRunner({ cyrusHome, workingDirectory: workspace });
		runner.on("error", () => {});
		await runner.start("hi");
		const msgs = runner.getMessages();
		const last = msgs[msgs.length - 1] as any;
		expect(last.type).toBe("result");
		expect(last.is_error).toBe(true);
	});

	it("writes Cyrus permission config file with translated patterns during run", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();

		// Capture the file contents during the stream by reading them in the
		// first event handler. We accomplish this with an SDK mock whose stream
		// reads the file before yielding.
		let capturedConfig: any = null;
		sdkMock.__install({
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-cap",
					run_id: "r",
				},
			],
		});
		// Override send to read the file before streaming.
		const installedAgent = await sdkMock.create.mock.results[0]?.value;
		void installedAgent;
		// Re-install with pre-stream file capture via a custom send.
		sdkMock.create.mockResolvedValueOnce({
			agentId: "agent-cap",
			model: undefined,
			close: () => {},
			reload: async () => {},
			listArtifacts: async () => [],
			downloadArtifact: async () => Buffer.alloc(0),
			[Symbol.asyncDispose]: async () => {},
			send: async () => {
				const hooks = JSON.parse(
					readFileSync(join(workspace, ".cursor", "hooks.json"), "utf8"),
				);
				const cfgPath = join(
					dirname(join(workspace, hooks.hooks.preToolUse[0].command)),
					"cyrus-permissions.json",
				);
				capturedConfig = JSON.parse(readFileSync(cfgPath, "utf8"));
				return {
					id: "run",
					agentId: "agent-cap",
					supports: () => true,
					unsupportedReason: () => undefined,
					stream: async function* () {
						yield {
							type: "status",
							agent_id: "agent-cap",
							run_id: "r",
							status: "FINISHED",
						};
					},
					conversation: async () => [],
					wait: async () => ({ id: "run", status: "finished" as const }),
					cancel: async () => {},
					status: "finished" as const,
					onDidChangeStatus: () => () => {},
				} as any;
			},
		});

		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: workspace,
			allowedTools: ["Read(src/**)", "Bash(git:*)"],
			disallowedTools: ["Bash(rm:*)"],
		});
		await runner.start("hi");

		expect(capturedConfig).toBeTruthy();
		expect(capturedConfig.allow).toEqual(
			expect.arrayContaining(["Read(src/**)", "Shell(git)", "Shell(git:*)"]),
		);
		expect(capturedConfig.deny).toEqual(
			expect.arrayContaining(["Shell(rm)", "Shell(rm:*)"]),
		);
	});

	it("writes .cursor/sandbox.json and passes sandboxOptions when sandbox enabled", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		let capturedAgentOpts: any = null;
		const realCreate = sdkMock.create.getMockImplementation();
		sdkMock.create.mockImplementationOnce(async (opts: any) => {
			capturedAgentOpts = opts;
			// Snapshot the sandbox.json that the runner just wrote (the SDK
			// would read it during startup).
			const fs = require("node:fs");
			const path = require("node:path");
			const sbPath = path.join(workspace, ".cursor", "sandbox.json");
			const sandboxJson = fs.existsSync(sbPath)
				? JSON.parse(fs.readFileSync(sbPath, "utf8"))
				: null;
			return realCreate
				? realCreate(opts)
				: {
						agentId: "agent-sandbox",
						model: undefined,
						send: async () => ({
							id: "r",
							agentId: "agent-sandbox",
							supports: () => true,
							unsupportedReason: () => undefined,
							stream: async function* () {},
							conversation: async () => [],
							wait: async () => ({ id: "r", status: "finished" as const }),
							cancel: async () => {},
							status: "finished" as const,
							onDidChangeStatus: () => () => {},
							result: undefined,
							model: undefined,
							durationMs: 0,
							git: undefined,
							createdAt: 0,
						}),
						close: () => {},
						reload: async () => {},
						listArtifacts: async () => [],
						downloadArtifact: async () => Buffer.alloc(0),
						[Symbol.asyncDispose]: async () => {},
						_sandboxJson: sandboxJson,
					};
		});
		sdkMock.__install({
			agentId: "agent-sandbox",
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-sandbox",
					run_id: "r",
				},
				{
					type: "status",
					agent_id: "agent-sandbox",
					run_id: "r",
					status: "FINISHED",
				},
			],
		});

		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: workspace,
			sandboxSettings: {
				enabled: true,
				network: {
					allowedDomains: ["api.linear.app"],
					httpProxyPort: 9876,
				},
				filesystem: {
					allowWrite: [workspace, "/tmp/extra-write"],
				},
			},
			egressCaCertPath: "/abs/ca.pem",
		});

		const prevHttpProxy = process.env.HTTP_PROXY;
		const prevNodeCa = process.env.NODE_EXTRA_CA_CERTS;
		try {
			await runner.start("hi");
		} finally {
			// Confirm env was restored after session
			expect(process.env.HTTP_PROXY).toBe(prevHttpProxy);
			expect(process.env.NODE_EXTRA_CA_CERTS).toBe(prevNodeCa);
		}

		expect(capturedAgentOpts.local.sandboxOptions).toEqual({ enabled: true });

		const fs = require("node:fs");
		const path = require("node:path");
		// sandbox.json should be removed at session end
		expect(fs.existsSync(path.join(workspace, ".cursor", "sandbox.json"))).toBe(
			false,
		);
	});

	it("does not pass sandboxOptions.enabled=true when sandbox is disabled", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		let capturedAgentOpts: any = null;
		sdkMock.create.mockImplementationOnce(async (opts: any) => {
			capturedAgentOpts = opts;
			return {
				agentId: "agent-no-sb",
				model: undefined,
				send: async () => ({
					id: "r",
					agentId: "agent-no-sb",
					supports: () => true,
					unsupportedReason: () => undefined,
					stream: async function* () {},
					conversation: async () => [],
					wait: async () => ({ id: "r", status: "finished" as const }),
					cancel: async () => {},
					status: "finished" as const,
					onDidChangeStatus: () => () => {},
					result: undefined,
					model: undefined,
					durationMs: 0,
					git: undefined,
					createdAt: 0,
				}),
				close: () => {},
				reload: async () => {},
				listArtifacts: async () => [],
				downloadArtifact: async () => Buffer.alloc(0),
				[Symbol.asyncDispose]: async () => {},
			};
		});

		const runner = new CursorRunner({ cyrusHome, workingDirectory: workspace });
		await runner.start("hi");

		expect(capturedAgentOpts.local.sandboxOptions).toEqual({ enabled: false });
	});
});

describe("Cursor cancellation during startup", () => {
	it.each([
		"account",
		"store",
		"create",
		"resume",
		"send",
	])("stops model work when cancellation arrives during %s", async (boundary) => {
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waitForStop = async () => {
			enter();
			await gate;
		};
		const agent = sdkMock.__install({ events: [] });
		let sentRun: any;
		if (boundary === "account")
			sdkMock.me.mockImplementation(async () => {
				await waitForStop();
				return { userEmail: "member@example.com" };
			});
		if (boundary === "store")
			sqliteMock.open.mockImplementation(async () => {
				await waitForStop();
				return sqliteMock.store;
			});
		if (boundary === "create")
			sdkMock.create.mockImplementation(async () => {
				await waitForStop();
				return agent;
			});
		if (boundary === "resume")
			sdkMock.resume.mockImplementation(async () => {
				await waitForStop();
				return agent;
			});
		if (boundary === "send") {
			const send = agent.send.getMockImplementation()!;
			agent.send.mockImplementation(async (...args) => {
				await waitForStop();
				sentRun = await send(...args);
				return sentRun;
			});
		}
		const runner = new CursorRunner({
			cyrusHome: tempWorkspace(),
			workingDirectory: tempWorkspace(),
			cursorAccountEmail: "member@example.com",
			resumeSessionId: boundary === "resume" ? "agent-existing" : undefined,
			onError: () => {},
		});
		const starting = runner.start("Read the brief.");
		await entered;
		runner.stop();
		await expect(
			runner.start("Do not restart while cleaning up."),
		).rejects.toThrow(/already running/);
		release();
		await starting;
		if (boundary === "send") expect(sentRun.cancel).toHaveBeenCalledOnce();
		else expect(agent.send).not.toHaveBeenCalled();
		if (boundary === "account" || boundary === "store") {
			expect(sdkMock.create).not.toHaveBeenCalled();
			expect(sdkMock.resume).not.toHaveBeenCalled();
		} else expect(agent.close).toHaveBeenCalled();
		expect(runner.isRunning()).toBe(false);
		expect(runner.getMessages().at(-1)).toMatchObject({
			type: "result",
			is_error: true,
			errors: ["Cursor session stopped"],
		});
	});
});

describe("Cursor workflow configuration", () => {
	it.each([
		undefined,
		"agent-existing",
	])("preserves harness and team attribution when resume ID is %s", async (resumeSessionId) => {
		const workspace = tempWorkspace();
		const agent = sdkMock.__install({ events: [] });
		const runner = new CursorRunner({
			cyrusHome: tempWorkspace(),
			workingDirectory: workspace,
			resumeSessionId,
			cursorTeamId: 42,
			cursorAccountEmail: "Member@Example.com",
			cursorSettingSources: ["user"],
			systemPrompt: "Use the selected workflow.",
			appendSystemPrompt: "Inspect the final rendered artifact.",
			additionalDirectories: [join(workspace, "support")],
		});
		await runner.start("Build the requested feature.");
		const options = resumeSessionId
			? sdkMock.resume.mock.calls[0]?.[1]
			: sdkMock.create.mock.calls[0]?.[0];
		expect(options.teamId).toBe(42);
		expect(sdkMock.me).toHaveBeenCalledWith({ apiKey: undefined, teamId: 42 });
		expect(sdkMock.me.mock.invocationCallOrder[0]).toBeLessThan(
			(resumeSessionId ? sdkMock.resume : sdkMock.create).mock
				.invocationCallOrder[0]!,
		);
		expect(options.systemPrompt).toBeUndefined();
		expect(options.local.settingSources).toEqual(["project", "user"]);
		expect(options.local.dirs).toEqual([join(workspace, "support")]);
		expect(agent.send.mock.calls[0]?.[0]).toBe(
			"Use the selected workflow.\n\nInspect the final rendered artifact.\n\nBuild the requested feature.",
		);
	});

	it.each([
		undefined,
		"agent-existing",
	])("refuses an unexpected account before create or resume %s", async (resumeSessionId) => {
		const agent = sdkMock.__install({ events: [] });
		sdkMock.me.mockResolvedValue({ userEmail: "another@example.com" });
		const errors: Error[] = [];
		const workspace = tempWorkspace();
		const runner = new CursorRunner({
			cyrusHome: tempWorkspace(),
			workingDirectory: workspace,
			resumeSessionId,
			cursorAccountEmail: "member@example.com",
			cursorTeamId: 42,
			onError: (error) => {
				errors.push(error);
			},
		});
		await runner.start("Read the brief.");
		expect(errors[0]?.message).toMatch(/does not match cursorAccountEmail/);
		expect(sdkMock.create).not.toHaveBeenCalled();
		expect(sdkMock.resume).not.toHaveBeenCalled();
		expect(agent.send).not.toHaveBeenCalled();
		expect(sqliteMock.open).not.toHaveBeenCalled();
		expect(existsSync(join(workspace, ".cursor", "hooks.json"))).toBe(false);
	});

	it.each([
		"missing",
		"unavailable",
		"blank",
	])("fails closed when configured account verification is %s", async (failure) => {
		if (failure === "unavailable")
			sdkMock.me.mockRejectedValue(new Error("private upstream error"));
		else sdkMock.me.mockResolvedValue({});
		const errors: Error[] = [];
		const runner = new CursorRunner({
			cyrusHome: tempWorkspace(),
			workingDirectory: tempWorkspace(),
			cursorAccountEmail: failure === "blank" ? " " : "member@example.com",
			onError: (error) => {
				errors.push(error);
			},
		});
		await runner.start("Read the brief.");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).not.toContain("private upstream error");
		expect(sdkMock.create).not.toHaveBeenCalled();
		expect(sdkMock.resume).not.toHaveBeenCalled();
	});

	it.each([
		{
			explicit: "explicit-key",
			env: "environment-key",
			expected: "explicit-key",
			loadsStore: false,
		},
		{
			explicit: undefined,
			env: "environment-key",
			expected: "environment-key",
			loadsStore: false,
		},
		{
			explicit: undefined,
			env: undefined,
			expected: "dedicated-key",
			loadsStore: true,
		},
	])("uses the same selected key for account verification and creation: $expected", async ({
		explicit,
		env,
		expected,
		loadsStore,
	}) => {
		vi.stubEnv("CURSOR_API_KEY", env);
		authMock.loadCyrusCursorApiKey.mockResolvedValue("dedicated-key");
		sdkMock.__install({ events: [] });
		const cyrusHome = tempWorkspace();
		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: tempWorkspace(),
			cursorApiKey: explicit,
			cursorAccountEmail: "member@example.com",
			cursorTeamId: 42,
		});
		await runner.start("Read the brief.");
		expect(sdkMock.me).toHaveBeenCalledWith({ apiKey: expected, teamId: 42 });
		expect(sdkMock.create.mock.calls[0]?.[0].apiKey).toBe(expected);
		if (loadsStore)
			expect(authMock.loadCyrusCursorApiKey).toHaveBeenCalledWith(cyrusHome);
		else expect(authMock.loadCyrusCursorApiKey).not.toHaveBeenCalled();
	});

	it("loads ordered MCP files and inline overrides without enabling disabled servers", async () => {
		const workspace = tempWorkspace();
		writeFileSync(
			join(workspace, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					linear: { type: "http", url: "https://first.example.com/mcp" },
					local: { command: "local-mcp", args: ["--stdio"] },
					disabled: { command: "do-not-start", disabled: true },
				},
			}),
		);
		writeFileSync(
			join(workspace, "override.json"),
			JSON.stringify({
				mcpServers: {
					linear: { type: "http", url: "https://second.example.com/mcp" },
				},
			}),
		);
		sdkMock.__install({ events: [] });
		const runner = new CursorRunner({
			cyrusHome: tempWorkspace(),
			workingDirectory: workspace,
			mcpConfigPath: ["mcp.json", "override.json"],
			mcpConfig: {
				linear: { type: "http", url: "https://session.example.com/mcp" },
			},
		});
		await runner.start("Read the brief.");
		expect(sdkMock.create.mock.calls[0]?.[0].mcpServers).toEqual({
			linear: { type: "http", url: "https://session.example.com/mcp" },
			local: { type: "stdio", command: "local-mcp", args: ["--stdio"] },
		});
	});

	it("fails before agent creation when required MCP configuration cannot be read", async () => {
		const workspace = tempWorkspace();
		const errors: Error[] = [];
		const runner = new CursorRunner({
			cyrusHome: tempWorkspace(),
			workingDirectory: workspace,
			mcpConfigPath: "missing.json",
			onError: (error) => {
				errors.push(error);
			},
		});
		await runner.start("Read the brief.");
		expect(sdkMock.create).not.toHaveBeenCalled();
		expect(errors[0]?.message).toMatch(/Cannot read Cursor MCP configuration/);
		expect(existsSync(join(workspace, ".cursor", "hooks.json"))).toBe(false);
	});

	it.each([
		0,
		-1,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects invalid explicit team ID %s instead of billing an ambient team", async (cursorTeamId) => {
		const runner = new CursorRunner({
			cyrusHome: tempWorkspace(),
			workingDirectory: tempWorkspace(),
			cursorTeamId,
			onError: () => {},
		});
		await runner.start("Read the brief.");
		expect(sdkMock.create).not.toHaveBeenCalled();
		expect(runner.getMessages().at(-1)).toMatchObject({
			type: "result",
			is_error: true,
		});
	});
});

describe("Cursor managed workflow and classification", () => {
	it("makes complete managed skill resources available before SDK startup and cleans only staged links", async () => {
		const workspace = tempWorkspace();
		const plugin = tempWorkspace();
		const skill = join(plugin, "skills", "build-feature");
		mkdirSync(join(plugin, "_bmad", "helpers"), { recursive: true });
		writeFileSync(
			join(plugin, "_bmad", "helpers", "build.py"),
			"print('ready')",
		);
		mkdirSync(join(skill, "scripts"), { recursive: true });
		mkdirSync(join(skill, "references"));
		writeFileSync(
			join(skill, "SKILL.md"),
			"Use scripts/build.mjs and references/rules.txt.",
		);
		writeFileSync(
			join(skill, "scripts", "build.mjs"),
			"export const version = 1;",
		);
		writeFileSync(
			join(skill, "references", "rules.txt"),
			"Inspect the finished artifact.",
		);
		const agent = sdkMock.__install({ events: [] });
		sdkMock.create.mockImplementationOnce(() => {
			const staged = join(workspace, ".agents", "skills", "build-feature");
			expect(
				readFileSync(join(workspace, "_bmad", "helpers", "build.py"), "utf8"),
			).toBe("print('ready')");
			expect(readFileSync(join(staged, "scripts", "build.mjs"), "utf8")).toBe(
				"export const version = 1;",
			);
			expect(
				readFileSync(join(staged, "references", "rules.txt"), "utf8"),
			).toBe("Inspect the finished artifact.");
			return agent;
		});
		const runner = new CursorRunner({
			cyrusHome: tempWorkspace(),
			workingDirectory: workspace,
			plugins: [{ type: "local", path: plugin }],
			skills: ["build-feature"],
			workspaceSupportSource: plugin,
			workspaceSupportPaths: ["_bmad"],
		});
		await runner.start("Build the feature.");
		expect(
			existsSync(join(workspace, ".agents", "skills", "build-feature")),
		).toBe(false);
		expect(existsSync(join(skill, "scripts", "build.mjs"))).toBe(true);
		expect(existsSync(join(workspace, "_bmad"))).toBe(false);
		expect(existsSync(join(plugin, "_bmad", "helpers", "build.py"))).toBe(true);
	});

	it("refuses classifier inference when the configured account does not match", async () => {
		const { SimpleCursorRunner } = await import("../src/SimpleCursorRunner.js");
		const agent = sdkMock.__install({ events: [] });
		sdkMock.me.mockResolvedValue({ userEmail: "another@example.com" });
		const runner = new SimpleCursorRunner({
			cyrusHome: tempWorkspace(),
			workingDirectory: tempWorkspace(),
			validResponses: ["code", "research"],
			cursorTeamId: 42,
			cursorAccountEmail: "member@example.com",
		});
		await expect(runner.query("Build a feature.")).rejects.toThrow(
			/does not match cursorAccountEmail/,
		);
		expect(sdkMock.create).not.toHaveBeenCalled();
		expect(sdkMock.resume).not.toHaveBeenCalled();
		expect(agent.send).not.toHaveBeenCalled();
	});

	it.each([
		false,
		true,
	])("keeps classifier account and tools restricted with file reading %s", async (allowFileReading) => {
		const { SimpleCursorRunner } = await import("../src/SimpleCursorRunner.js");
		const agent = sdkMock.__install({
			events: [
				{
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "code" }],
					},
				},
			],
		});
		const runner = new SimpleCursorRunner({
			cyrusHome: tempWorkspace(),
			workingDirectory: tempWorkspace(),
			validResponses: ["code", "research"],
			cursorTeamId: 42,
			cursorAccountEmail: "member@example.com",
			cursorSettingSources: ["user"],
			systemPrompt: "Classify the issue.",
		});
		const result = await runner.query("Build a feature.", {
			context: "Brief context.",
			allowFileReading,
		});
		expect(result.response).toBe("code");
		const options = sdkMock.create.mock.calls[0]?.[0];
		expect(options.teamId).toBe(42);
		expect(options.local.settingSources).toEqual(["project", "user"]);
		expect(sdkMock.me).toHaveBeenCalledWith({ apiKey: undefined, teamId: 42 });
		expect(options.tools).toEqual(
			allowFileReading ? ["read", "glob", "grep"] : [],
		);
		expect(options.disallowedTools).toEqual([
			"shell",
			"edit",
			"delete",
			"task",
			"mcp",
		]);
		expect(agent.send.mock.calls[0]?.[0]).toBe(`Classify the issue.


IMPORTANT: You must respond with EXACTLY one of the following values:
"code", "research"

Your final response MUST be one of these exact strings, with no additional text, explanation, or formatting.
Do not use markdown, code blocks, or quotes around your response.
Simply output the chosen value as your final answer.


Brief context.

Build a feature.`);
	});
});

describe("Cursor sandbox ownership", () => {
	it("refuses to replace a conflicting project sandbox policy", async () => {
		const workspace = tempWorkspace();
		mkdirSync(join(workspace, ".cursor"));
		const original = '{"networkPolicy":{"default":"deny"}}';
		writeFileSync(join(workspace, ".cursor", "sandbox.json"), original);
		const errors: Error[] = [];
		const runner = new CursorRunner({
			cyrusHome: tempWorkspace(),
			workingDirectory: workspace,
			sandboxSettings: { enabled: true },
			onError: (error) => {
				errors.push(error);
			},
		});
		await runner.start("Read the brief.");
		expect(sdkMock.create).not.toHaveBeenCalled();
		expect(errors[0]?.message).toMatch(
			/conflict with the existing Cursor sandbox/,
		);
		expect(
			readFileSync(join(workspace, ".cursor", "sandbox.json"), "utf8"),
		).toBe(original);
		expect(existsSync(join(workspace, ".cursor", "hooks.json"))).toBe(false);
	});

	it("reuses an equivalent existing sandbox policy without changing its bytes", async () => {
		const { buildCursorSandboxJson } = await import("../src/sandbox.js");
		const workspace = tempWorkspace();
		mkdirSync(join(workspace, ".cursor"));
		const policy = buildCursorSandboxJson({
			workspace,
			sandboxSettings: { enabled: true },
		});
		const original = JSON.stringify(policy, null, 4);
		const sandboxPath = join(workspace, ".cursor", "sandbox.json");
		writeFileSync(sandboxPath, original);
		const agent = sdkMock.__install({ events: [] });
		sdkMock.create.mockImplementationOnce(() => {
			expect(readFileSync(sandboxPath, "utf8")).toBe(original);
			return agent;
		});
		const runner = new CursorRunner({
			cyrusHome: tempWorkspace(),
			workingDirectory: workspace,
			sandboxSettings: { enabled: true },
		});
		await runner.start("Read the brief.");
		expect(sdkMock.create).toHaveBeenCalledOnce();
		expect(readFileSync(sandboxPath, "utf8")).toBe(original);
	});

	it("retains sandbox policy edits made while the agent was working", async () => {
		const workspace = tempWorkspace();
		const agent = sdkMock.__install({ events: [] });
		const edited = '{"networkPolicy":{"default":"deny"}}';
		sdkMock.create.mockImplementationOnce(() => {
			writeFileSync(join(workspace, ".cursor", "sandbox.json"), edited);
			return agent;
		});
		const runner = new CursorRunner({
			cyrusHome: tempWorkspace(),
			workingDirectory: workspace,
			sandboxSettings: { enabled: true },
		});
		await runner.start("Read the brief.");
		expect(
			readFileSync(join(workspace, ".cursor", "sandbox.json"), "utf8"),
		).toBe(edited);
	});

	it("prevents other workspaces from inheriting a live session's sandbox environment", async () => {
		const workspace = tempWorkspace();
		const agent = sdkMock.__install({ events: [] });
		const send = agent.send.getMockImplementation()!;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		agent.send.mockImplementation(async (...args) => {
			await gate;
			return send(...args);
		});
		const previous = process.env.HTTP_PROXY;
		const runner = new CursorRunner({
			cyrusHome: tempWorkspace(),
			workingDirectory: workspace,
			sandboxSettings: { enabled: true, network: { httpProxyPort: 12345 } },
		});
		const running = runner.start("Read the brief.");
		try {
			await vi.waitFor(() => expect(agent.send).toHaveBeenCalled());
			const errors: Error[] = [];
			const other = new CursorRunner({
				cyrusHome: tempWorkspace(),
				workingDirectory: tempWorkspace(),
				onError: (error) => {
					errors.push(error);
				},
			});
			await other.start("Read a different brief.");
			expect(sdkMock.create).toHaveBeenCalledTimes(1);
			expect(errors[0]?.message).toMatch(/process-wide sandbox environment/);
			process.env.HTTP_PROXY = "http://changed.example.com:8080";
		} finally {
			release();
			await running;
		}
		expect(process.env.HTTP_PROXY).toBe("http://changed.example.com:8080");
		if (previous === undefined) delete process.env.HTTP_PROXY;
		else process.env.HTTP_PROXY = previous;
	});
});
