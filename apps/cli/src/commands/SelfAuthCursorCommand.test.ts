import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Application } from "../Application.js";

const { login } = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock("cyrus-edge-worker", () => ({ loginCyrusCursor: login }));

import { SelfAuthCursorCommand } from "./SelfAuthCursorCommand.js";

const homes: string[] = [];
function fixture(contents?: string) {
	const home = mkdtempSync(join(tmpdir(), "cyrus-auth-command-"));
	homes.push(home);
	const file = join(home, "config.json");
	if (contents !== undefined) writeFileSync(file, contents);
	const logger = {
		info: vi.fn(),
		success: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
	};
	const app = {
		cyrusHome: home,
		config: { getConfigPath: () => file },
		logger,
	} as unknown as Application;
	return { home, file, logger, command: new SelfAuthCursorCommand(app) };
}
beforeEach(() => {
	vi.clearAllMocks();
	login.mockResolvedValue({
		email: "agent@example.com",
		teamId: 42,
		apiKeyExpiresAtMs: Date.now() + 60000,
	});
});
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});
describe("SelfAuthCursorCommand", () => {
	it("preserves unrelated config changes made while browser authentication is pending", async () => {
		const { file, command } = fixture(
			JSON.stringify({ repositories: [], cursorDefaultModel: "old-model" }),
		);
		const changed = {
			repositories: [],
			cursorDefaultModel: "new-model",
			anotherExtension: { preserve: true },
		};
		login.mockImplementation(async () => {
			writeFileSync(file, JSON.stringify(changed));
			return {
				email: "agent@example.com",
				teamId: 42,
				apiKeyExpiresAtMs: Date.now() + 60000,
			};
		});
		// Refusing to write or merging the latest valid config both preserve the other writer's changes.
		await command.execute(["agent@example.com", "42"]).catch(() => undefined);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject(changed);
	});
	it("does not overwrite configuration that becomes invalid while authentication is pending", async () => {
		const { file, command } = fixture('{"repositories":[]}');
		login.mockImplementation(async () => {
			writeFileSync(file, "{interrupted-edit");
			return {
				email: "agent@example.com",
				teamId: 42,
				apiKeyExpiresAtMs: Date.now() + 60000,
			};
		});
		await expect(
			command.execute(["agent@example.com", "42"]),
		).rejects.toThrow();
		expect(readFileSync(file, "utf8")).toBe("{interrupted-edit");
	});
	it("does not print or persist unexpected credential properties returned by authentication", async () => {
		const { file, logger, command } = fixture('{"repositories":[]}');
		login.mockResolvedValue({
			email: "agent@example.com",
			teamId: 42,
			apiKeyExpiresAtMs: Date.now() + 60000,
			apiKey: "fixture-secret-never-log",
		});
		await command.execute(["agent@example.com", "42"]);
		expect(readFileSync(file, "utf8")).not.toContain(
			"fixture-secret-never-log",
		);
		expect(
			JSON.stringify([
				logger.info.mock.calls,
				logger.success.mock.calls,
				logger.error.mock.calls,
			]),
		).not.toContain("fixture-secret-never-log");
	});
	it("preserves unrelated configuration and records only verified account fields", async () => {
		const original = {
			repositories: [],
			allowedRunners: ["cursor"],
			cursorDefaultModel: "composer-2",
			publicationPolicy: { mode: "local-only" },
			customExtension: { preserve: true },
		};
		const { home, file, logger, command } = fixture(JSON.stringify(original));
		await command.execute(["agent@example.com", "42"]);
		expect(login).toHaveBeenCalledWith({
			cyrusHome: home,
			expectedEmail: "agent@example.com",
			teamId: 42,
		});
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			...original,
			cursorAccountEmail: "agent@example.com",
			cursorTeamId: 42,
		});
		expect(JSON.stringify(logger.info.mock.calls)).toContain(
			"No issue was started",
		);
		expect(
			JSON.stringify([logger.info.mock.calls, logger.success.mock.calls]),
		).not.toContain("apiKey");
	});
	it("creates a minimal configuration after verified login when none exists", async () => {
		const { file, command } = fixture();
		await command.execute(["agent@example.com", "42"]);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			repositories: [],
			cursorAccountEmail: "agent@example.com",
			cursorTeamId: 42,
		});
	});
	it.each([
		"{broken",
		"null",
		"[]",
		'"text"',
		'{"repositories":"invalid"}',
	])("does not authenticate or overwrite invalid configuration %s", async (original) => {
		const { file, command } = fixture(original);
		await expect(
			command.execute(["agent@example.com", "42"]),
		).rejects.toThrow();
		expect(login).not.toHaveBeenCalled();
		expect(readFileSync(file, "utf8")).toBe(original);
	});
	it("preserves existing config when identity verification fails", async () => {
		const original = '{"repositories":[],"cursorTeamId":7}';
		const { file, command, logger } = fixture(original);
		login.mockRejectedValue(
			new Error("Cursor sign-in used a different account."),
		);
		await expect(command.execute(["agent@example.com", "42"])).rejects.toThrow(
			"different account",
		);
		expect(readFileSync(file, "utf8")).toBe(original);
		expect(logger.success).not.toHaveBeenCalled();
	});
	it("does not create config when login fails", async () => {
		const { file, command } = fixture();
		login.mockRejectedValue(new Error("Sign-in cancelled"));
		await expect(command.execute(["agent@example.com", "42"])).rejects.toThrow(
			"cancelled",
		);
		expect(existsSync(file)).toBe(false);
	});
	it.each([
		[],
		["agent@example.com", "0"],
		["agent@example.com", "wrong"],
		["agent@example.com", "1.5"],
	])("rejects invalid arguments before authentication: %j", async (...args) => {
		const { command, file } = fixture();
		await expect(command.execute(args as string[])).rejects.toThrow();
		expect(login).not.toHaveBeenCalled();
		expect(existsSync(file)).toBe(false);
	});
});
