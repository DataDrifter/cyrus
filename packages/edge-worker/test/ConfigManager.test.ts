import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EdgeWorkerConfig, ILogger, RepositoryConfig } from "cyrus-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../src/ConfigManager.js";

const logger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

const repo: RepositoryConfig = {
	id: "repo-1",
	name: "Repo 1",
	repositoryPath: "/tmp/repo-1",
	baseBranch: "main",
};

describe("ConfigManager", () => {
	it("reloads the Codex mode and restores the default when the field is removed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cyrus-codex-mode-"));
		const path = join(dir, "config.json");
		const manager = new ConfigManager(
			{ repositories: [repo] },
			logger,
			path,
			new Map([[repo.id, repo]]),
		);
		const changed = vi.fn();
		manager.on("configChanged", (event) => {
			changed(event);
			manager.setConfig(event.newConfig);
		});
		try {
			for (const mode of ["danger-full-access", "read-only", undefined]) {
				await writeFile(
					path,
					JSON.stringify({ repositories: [repo], codexSandboxMode: mode }),
				);
				await (manager as any).handleConfigChange();
				expect(changed.mock.lastCall?.[0].newConfig.codexSandboxMode).toBe(
					mode,
				);
			}
			expect(changed).toHaveBeenCalledTimes(3);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reloads and removes provider, Cursor account, and publication policies", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cyrus-provider-policy-"));
		const path = join(dir, "config.json");
		const manager = new ConfigManager(
			{ repositories: [repo] },
			logger,
			path,
			new Map([[repo.id, repo]]),
		);
		const changed = vi.fn();
		manager.on("configChanged", (event) => {
			changed(event);
			manager.setConfig(event.newConfig);
		});
		const policy = {
			allowedRunners: ["cursor"],
			cursorTeamId: 42,
			cursorAccountEmail: "agent@example.com",
			workspaceSupportPaths: ["_workflow", ".agents/skills"],
			cursorSettingSources: ["user", "project"],
			publicationPolicy: { mode: "local-only" },
		};
		try {
			await writeFile(
				path,
				JSON.stringify({ repositories: [repo], ...policy }),
			);
			await (
				manager as unknown as { handleConfigChange(): Promise<void> }
			).handleConfigChange();
			expect(changed.mock.lastCall?.[0].newConfig).toMatchObject(policy);
			await writeFile(path, JSON.stringify({ repositories: [repo] }));
			await (
				manager as unknown as { handleConfigChange(): Promise<void> }
			).handleConfigChange();
			for (const key of Object.keys(policy))
				expect(changed.mock.lastCall?.[0].newConfig[key]).toBeUndefined();
			expect(changed).toHaveBeenCalledTimes(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	let tempDir: string | undefined;

	afterEach(async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("reloads top-level OpenCode config and emits it as a global config change", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "cyrus-config-manager-"));
		const configPath = join(tempDir, "config.json");
		const opencode = {
			config: {
				provider: {
					anthropic: { options: { baseURL: "https://opencode.test" } },
				},
			},
		};

		const initialConfig: EdgeWorkerConfig = {
			repositories: [repo],
			opencode: { config: { model: "opencode" } },
		};
		const manager = new ConfigManager(
			initialConfig,
			logger,
			configPath,
			new Map([[repo.id, repo]]),
		);
		const onConfigChanged = vi.fn();
		manager.on("configChanged", onConfigChanged);

		await writeFile(
			configPath,
			JSON.stringify({ repositories: [repo], opencode }),
		);
		await (manager as any).handleConfigChange();

		expect(onConfigChanged).toHaveBeenCalledOnce();
		expect(onConfigChanged.mock.calls[0][0].newConfig.opencode).toEqual(
			opencode,
		);
	});

	it("reloads strictMcpConfig=false and emits it as a global config change", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "cyrus-config-manager-"));
		const configPath = join(tempDir, "config.json");
		const initialConfig: EdgeWorkerConfig = {
			repositories: [repo],
			strictMcpConfig: true,
		};
		const manager = new ConfigManager(
			initialConfig,
			logger,
			configPath,
			new Map([[repo.id, repo]]),
		);
		const onConfigChanged = vi.fn();
		manager.on("configChanged", onConfigChanged);

		await writeFile(
			configPath,
			JSON.stringify({ repositories: [repo], strictMcpConfig: false }),
		);
		await (manager as any).handleConfigChange();

		expect(onConfigChanged).toHaveBeenCalledOnce();
		expect(onConfigChanged.mock.calls[0][0].newConfig.strictMcpConfig).toBe(
			false,
		);
	});
});
