import { execFileSync, spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildCyrusPermissionsConfig } from "../src/permissions.js";
import { ProjectPermissionHooks } from "../src/project-hooks.js";

const workspaces: string[] = [];
const helper = fileURLToPath(
	new URL("../src/permission-check.mjs", import.meta.url),
);
function workspace() {
	const dir = mkdtempSync(join(tmpdir(), "cursor-project-hooks-"));
	workspaces.push(dir);
	mkdirSync(join(dir, ".cursor"));
	return dir;
}
function install(dir: string) {
	return ProjectPermissionHooks.install(
		dir,
		buildCyrusPermissionsConfig({
			workspace: dir,
			allowedTools: ["Read"],
			disallowedTools: ["Bash"],
		}),
		helper,
	);
}
function readHooks(dir: string) {
	return JSON.parse(readFileSync(join(dir, ".cursor/hooks.json"), "utf8"));
}
afterEach(() => {
	for (const dir of workspaces.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("Project permission hooks", () => {
	it("keeps existing hook events active and restores their exact original contents", () => {
		const dir = workspace();
		const original = JSON.stringify({
			version: 1,
			hooks: {
				beforeShellExecution: [
					{ command: "./existing-permissions.sh", failClosed: true },
				],
				stop: [{ command: "./existing-completion.sh" }],
			},
		});
		writeFileSync(join(dir, ".cursor/hooks.json"), original);
		const session = install(dir);
		const hooks = readHooks(dir).hooks;
		expect(hooks.beforeShellExecution[1]).toEqual({
			command: "./existing-permissions.sh",
			failClosed: true,
		});
		expect(hooks.stop).toEqual([{ command: "./existing-completion.sh" }]);
		const command = join(dir, hooks.beforeShellExecution[0].command);
		const logPath = join(dir, "permission-log.jsonl");
		const check = spawnSync(process.execPath, [command], {
			env: { ...process.env, CYRUS_PERM_LOG: logPath },
			input: JSON.stringify({
				hook_event_name: "beforeShellExecution",
				command: "git push upstream main",
			}),
			encoding: "utf8",
		});
		expect(JSON.parse(check.stdout).permission).toBe("deny");
		expect(JSON.parse(readFileSync(logPath, "utf8"))).toEqual({
			ts: expect.any(Number),
			event: "beforeShellExecution",
			permission: "deny",
		});
		session.dispose();
		expect(readFileSync(join(dir, ".cursor/hooks.json"), "utf8")).toBe(
			original,
		);
		expect(existsSync(dirname(command))).toBe(false);
	});

	it("keeps hooks edited during the session and removes only its own entries", () => {
		const dir = workspace();
		const session = install(dir);
		const hooks = readHooks(dir);
		hooks.hooks.stop = [{ command: "./new-review.sh" }];
		hooks.hooks.beforeReadFile.push({ command: "./new-read-policy.sh" });
		writeFileSync(join(dir, ".cursor/hooks.json"), JSON.stringify(hooks));
		session.dispose();
		expect(readHooks(dir)).toEqual({
			version: 1,
			hooks: {
				stop: [{ command: "./new-review.sh" }],
				beforeReadFile: [{ command: "./new-read-policy.sh" }],
			},
		});
	});

	it("rejects conflicting sessions without replacing the active permissions", () => {
		const dir = workspace();
		const session = install(dir);
		const original = readFileSync(join(dir, ".cursor/hooks.json"), "utf8");
		expect(() => install(dir)).toThrow(
			"Another Cursor session owns this workspace",
		);
		expect(readFileSync(join(dir, ".cursor/hooks.json"), "utf8")).toBe(
			original,
		);
		session.dispose();
	});

	it("recovers an interrupted process's hooks before starting the replacement", () => {
		const dir = workspace();
		const original = JSON.stringify({
			version: 1,
			hooks: { stop: [{ command: "./review.sh" }] },
		});
		writeFileSync(join(dir, ".cursor/hooks.json"), original);
		install(dir);
		const oldHooks = readHooks(dir);
		const leasePath = join(dir, ".cursor/cyrus-permission-session.json");
		const lease = JSON.parse(readFileSync(leasePath, "utf8"));
		const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		expect(exited.status).toBe(0);
		writeFileSync(leasePath, JSON.stringify({ ...lease, pid: exited.pid }));
		const replacement = install(dir);
		expect(readHooks(dir).hooks.beforeReadFile).toHaveLength(1);
		expect(readHooks(dir).hooks.stop).toEqual([{ command: "./review.sh" }]);
		expect(
			existsSync(dirname(join(dir, oldHooks.hooks.preToolUse[0].command))),
		).toBe(false);
		replacement.dispose();
		expect(readFileSync(join(dir, ".cursor/hooks.json"), "utf8")).toBe(
			original,
		);
	});

	it.each([
		false,
		true,
	])("excludes only temporary artifacts and preserves existing Git exclusions with native hooks %s", (hasNativeHooks) => {
		const dir = workspace();
		execFileSync("git", ["init", "--quiet"], { cwd: dir });
		const excludePath = join(dir, ".git", "info", "exclude");
		const original = "/local-secret.txt\n";
		writeFileSync(excludePath, original);
		if (hasNativeHooks)
			writeFileSync(
				join(dir, ".cursor", "hooks.json"),
				'{"version":1,"hooks":{}}',
			);
		const session = install(dir);
		const command = readHooks(dir).hooks.preToolUse[0].command;
		for (const file of [".cursor/cyrus-permission-session.json", command]) {
			expect(
				spawnSync("git", ["check-ignore", "--quiet", file], { cwd: dir })
					.status,
			).toBe(0);
		}
		expect(
			spawnSync("git", ["check-ignore", "--quiet", ".cursor/hooks.json"], {
				cwd: dir,
			}).status,
		).toBe(0);
		appendFileSync(excludePath, "/added-during-session.txt\n");
		session.dispose();
		expect(readFileSync(excludePath, "utf8")).toBe(
			`${original}/added-during-session.txt\n`,
		);
		expect(
			existsSync(join(dir, ".cursor", "cyrus-permission-session.json")),
		).toBe(false);
	});

	it.each([
		false,
		true,
	])("keeps temporary policies out of ordinary commits with preexisting skip-worktree %s", (alreadySkipped) => {
		const dir = workspace();
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: dir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		git("init", "--quiet");
		const original =
			'{"version":1,"hooks":{"stop":[{"command":"./review.sh"}]}}';
		writeFileSync(join(dir, ".cursor", "hooks.json"), original);
		git("add", "-A");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.com",
			"commit",
			"-qm",
			"Initial hooks",
		);
		if (alreadySkipped)
			git("update-index", "--skip-worktree", ".cursor/hooks.json");
		const session = install(dir);
		const edited = readHooks(dir);
		edited.hooks.stop.push({ command: "./additional-review.sh" });
		writeFileSync(join(dir, ".cursor", "hooks.json"), JSON.stringify(edited));
		writeFileSync(
			join(dir, ".cursor", "sandbox.json"),
			'{"type":"workspace_readwrite"}',
		);
		writeFileSync(join(dir, "feature.txt"), "Feature content.");
		git("add", "-A");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.com",
			"commit",
			"-qm",
			"Feature",
		);
		expect(git("show", "HEAD:.cursor/hooks.json")).toBe(original);
		expect(git("ls-tree", "-r", "--name-only", "HEAD").split("\n")).toEqual([
			".cursor/hooks.json",
			"feature.txt",
		]);
		session.dispose();
		expect(readHooks(dir).hooks.stop).toEqual([
			{ command: "./review.sh" },
			{ command: "./additional-review.sh" },
		]);
		expect(
			git("ls-files", "-v", "--", ".cursor/hooks.json").startsWith("S "),
		).toBe(alreadySkipped);
	});

	it("keeps preexisting untracked hooks out of commits until their original content is restored", () => {
		const dir = workspace();
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: dir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		git("init", "--quiet");
		const original =
			'{"version":1,"hooks":{"stop":[{"command":"./review.sh"}]}}';
		writeFileSync(join(dir, ".cursor", "hooks.json"), original);
		const session = install(dir);
		writeFileSync(join(dir, "feature.txt"), "Feature content.");
		git("add", "-A");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.com",
			"commit",
			"-qm",
			"Feature with untracked project hooks",
		);
		expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("feature.txt");
		session.dispose();
		expect(readFileSync(join(dir, ".cursor", "hooks.json"), "utf8")).toBe(
			original,
		);
		git("add", "-A");
		expect(git("show", ":.cursor/hooks.json")).toBe(original);
	});

	it("removes an unchanged generated sandbox after a crash before ordinary Git staging", () => {
		const dir = workspace();
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: dir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		git("init", "--quiet");
		const interrupted = install(dir);
		const policy =
			'{"type":"workspace_readwrite","additionalReadonlyPaths":["/machine-specific"]}';
		interrupted.installGeneratedSandbox(policy);
		const leasePath = join(dir, ".cursor", "cyrus-permission-session.json");
		const lease = JSON.parse(readFileSync(leasePath, "utf8"));
		expect(lease.sandboxArtifact.contents).toBe(policy);
		const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		writeFileSync(leasePath, JSON.stringify({ ...lease, pid: exited.pid }));
		const replacement = install(dir);
		expect(existsSync(join(dir, ".cursor", "sandbox.json"))).toBe(false);
		replacement.installGeneratedSandbox(policy);
		writeFileSync(join(dir, "feature.txt"), "Feature content.");
		git("add", "-A");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.com",
			"commit",
			"-qm",
			"Feature after recovery",
		);
		expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("feature.txt");
		replacement.dispose();
		expect(existsSync(join(dir, ".cursor", "sandbox.json"))).toBe(false);
		git("add", "-A");
		expect(git("status", "--porcelain")).toBe("");
	});

	it.each([
		"edited",
		"replaced",
	])("preserves a generated sandbox %s by another writer before recovery", (change) => {
		const dir = workspace();
		const interrupted = install(dir);
		const policy = '{"type":"workspace_readwrite"}';
		const sandboxPath = join(dir, ".cursor", "sandbox.json");
		interrupted.installGeneratedSandbox(policy);
		const preserved =
			change === "edited" ? '{"type":"workspace_readonly"}' : policy;
		if (change === "edited") writeFileSync(sandboxPath, preserved);
		else {
			const replacementPath = join(dir, ".cursor", "replacement.json");
			writeFileSync(replacementPath, preserved);
			renameSync(replacementPath, sandboxPath);
		}
		const leasePath = join(dir, ".cursor", "cyrus-permission-session.json");
		const lease = JSON.parse(readFileSync(leasePath, "utf8"));
		const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		writeFileSync(leasePath, JSON.stringify({ ...lease, pid: exited.pid }));
		const replacement = install(dir);
		expect(readFileSync(sandboxPath, "utf8")).toBe(preserved);
		replacement.dispose();
		expect(readFileSync(sandboxPath, "utf8")).toBe(preserved);
	});

	it("keeps an interrupted legacy sandbox excluded when ownership cannot be verified", () => {
		const dir = workspace();
		execFileSync("git", ["init", "--quiet"], { cwd: dir });
		install(dir);
		const sandboxPath = join(dir, ".cursor", "sandbox.json");
		const policy = '{"type":"workspace_readwrite"}';
		writeFileSync(sandboxPath, policy);
		const leasePath = join(dir, ".cursor", "cyrus-permission-session.json");
		const lease = JSON.parse(readFileSync(leasePath, "utf8"));
		const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		writeFileSync(leasePath, JSON.stringify({ ...lease, pid: exited.pid }));
		expect(() => install(dir)).toThrow(/Cannot establish ownership/);
		expect(readFileSync(sandboxPath, "utf8")).toBe(policy);
		expect(
			spawnSync("git", ["check-ignore", "--quiet", ".cursor/sandbox.json"], {
				cwd: dir,
			}).status,
		).toBe(0);
	});

	it("refuses competing recovery without touching another recovery's lease", () => {
		const dir = workspace();
		install(dir);
		const leasePath = join(dir, ".cursor", "cyrus-permission-session.json");
		const lease = JSON.parse(readFileSync(leasePath, "utf8"));
		const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		const stale = JSON.stringify({ ...lease, pid: exited.pid });
		writeFileSync(leasePath, stale);
		const marker = join(
			dir,
			".cursor",
			`cyrus-permission-recovery-${lease.id}`,
		);
		writeFileSync(marker, "recovery-owner");
		expect(() => install(dir)).toThrow(/Another process is recovering/);
		expect(readFileSync(leasePath, "utf8")).toBe(stale);
		expect(readFileSync(marker, "utf8")).toBe("recovery-owner");
		rmSync(marker);
		install(dir).dispose();
	});

	it("leaves malformed existing hook configuration intact and refuses startup", () => {
		const dir = workspace();
		writeFileSync(join(dir, ".cursor/hooks.json"), "{broken");
		expect(() => install(dir)).toThrow();
		expect(readFileSync(join(dir, ".cursor/hooks.json"), "utf8")).toBe(
			"{broken",
		);
		expect(existsSync(join(dir, ".cursor/cyrus-permission-session.json"))).toBe(
			false,
		);
	});
});
