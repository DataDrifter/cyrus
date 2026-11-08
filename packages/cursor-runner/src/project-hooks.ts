import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	copyFileSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { CyrusPermissionsConfig } from "./permissions.js";

const EVENTS = [
	"preToolUse",
	"beforeShellExecution",
	"beforeReadFile",
	"beforeMCPExecution",
] as const;

type HooksDocument = Record<string, unknown> & {
	hooks: Record<string, unknown[]>;
};

interface PermissionLease {
	version: 1;
	pid: number;
	id: string;
	original: string | null;
	installed: string;
	hooksSkipWorktreeAdded?: boolean;
	excludeHooks?: boolean;
	generatedSandbox?: boolean;
	sandboxArtifact?: { contents: string; ino: number; dev: number };
}

function parseHooks(contents: string | null): HooksDocument {
	const value =
		contents === null ? { version: 1, hooks: {} } : JSON.parse(contents);
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(value.version !== undefined && value.version !== 1) ||
		!value.hooks ||
		typeof value.hooks !== "object" ||
		Array.isArray(value.hooks) ||
		Object.values(value.hooks).some((entries) => !Array.isArray(entries))
	) {
		throw new Error(
			"Cannot preserve invalid Cursor project hooks configuration",
		);
	}
	return value as HooksDocument;
}

function writeHooks(path: string, contents: string): void {
	const temporary = `${path}.cyrus-${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}

function createLease(path: string, lease: PermissionLease): void {
	const temporary = `${path}.${lease.id}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(lease), {
			flag: "wx",
			mode: 0o600,
		});
		// Link creation is exclusive and exposes only a complete lease document.
		linkSync(temporary, path);
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}

function commandFor(id: string): string {
	return `./.cursor/cyrus-permission-sessions/${id}/cyrus-permission-check.mjs`;
}

function exclusionBlock(lease: PermissionLease): string {
	return `\n# Cyrus Cursor session ${lease.id}\n/.cursor/cyrus-permission-session.json\n/.cursor/cyrus-permission-sessions/${lease.id}/\n${(lease.excludeHooks ?? lease.original === null) ? "/.cursor/hooks.json\n" : ""}${lease.generatedSandbox ? "/.cursor/sandbox.json\n" : ""}# End Cyrus Cursor session ${lease.id}\n`;
}

function gitExcludePath(cursorDir: string): string | null {
	const workspace = dirname(cursorDir);
	try {
		const path = execFileSync(
			"git",
			["rev-parse", "--git-path", "info/exclude"],
			{
				cwd: workspace,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			},
		).trim();
		return isAbsolute(path) ? path : join(workspace, path);
	} catch {
		return null;
	}
}

function trackedHooksStatus(cursorDir: string): string {
	if (!gitExcludePath(cursorDir)) return "";
	return execFileSync("git", ["ls-files", "-v", "--", ".cursor/hooks.json"], {
		cwd: dirname(cursorDir),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

function setHooksSkipWorktree(cursorDir: string, enabled: boolean): void {
	execFileSync(
		"git",
		[
			"update-index",
			enabled ? "--skip-worktree" : "--no-skip-worktree",
			"--",
			".cursor/hooks.json",
		],
		{
			cwd: dirname(cursorDir),
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
}

function addSessionExclusions(cursorDir: string, lease: PermissionLease): void {
	const path = gitExcludePath(cursorDir);
	if (!path) return;
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, exclusionBlock(lease));
}

function removeSessionExclusions(
	cursorDir: string,
	lease: PermissionLease,
): void {
	const path = gitExcludePath(cursorDir);
	if (!path || !existsSync(path)) return;
	const current = readFileSync(path, "utf8");
	const block = exclusionBlock(lease);
	if (current.includes(block)) writeFileSync(path, current.replace(block, ""));
}

function cleanupGeneratedSandbox(
	cursorDir: string,
	lease: PermissionLease,
): void {
	const artifact = lease.sandboxArtifact;
	if (!artifact) return;
	const path = join(cursorDir, "sandbox.json");
	try {
		const stat = lstatSync(path);
		if (
			stat.isFile() &&
			stat.ino === artifact.ino &&
			stat.dev === artifact.dev &&
			readFileSync(path, "utf8") === artifact.contents
		) {
			unlinkSync(path);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Own only the added permission entries, retaining hooks edited during a session. */
function restoreHooks(cursorDir: string, lease: PermissionLease): void {
	const hooksPath = join(cursorDir, "hooks.json");
	if (!existsSync(hooksPath)) return;
	const current = readFileSync(hooksPath, "utf8");
	if (current === lease.original) return;
	if (current === lease.installed) {
		if (lease.original === null) unlinkSync(hooksPath);
		else writeHooks(hooksPath, lease.original);
		return;
	}
	const parsed = parseHooks(current);
	const original = parseHooks(lease.original);
	const ownedCommand = commandFor(lease.id);
	for (const event of EVENTS) {
		if (!parsed.hooks[event]) continue;
		parsed.hooks[event] = parsed.hooks[event].filter((entry) => {
			return !(
				entry &&
				typeof entry === "object" &&
				"command" in entry &&
				entry.command === ownedCommand
			);
		});
		if (parsed.hooks[event].length === 0 && !(event in original.hooks)) {
			delete parsed.hooks[event];
		}
	}
	writeHooks(hooksPath, `${JSON.stringify(parsed, null, "\t")}\n`);
}

export class ProjectPermissionHooks {
	private constructor(
		private readonly cursorDir: string,
		private readonly lease: PermissionLease,
	) {}

	static install(
		workspace: string,
		permissions: CyrusPermissionsConfig,
		helperSource: string,
	): ProjectPermissionHooks {
		const cursorDir = join(workspace, ".cursor");
		mkdirSync(cursorDir, { recursive: true });
		const leasePath = join(cursorDir, "cyrus-permission-session.json");
		if (existsSync(leasePath)) {
			const previous: PermissionLease = JSON.parse(
				readFileSync(leasePath, "utf8"),
			);
			if (
				previous.version !== 1 ||
				!Number.isSafeInteger(previous.pid) ||
				previous.pid <= 0 ||
				!/^[-a-f0-9]{36}$/.test(previous.id) ||
				typeof previous.installed !== "string" ||
				!(
					previous.original === null || typeof previous.original === "string"
				) ||
				(previous.sandboxArtifact !== undefined &&
					(!previous.sandboxArtifact ||
						typeof previous.sandboxArtifact.contents !== "string" ||
						!Number.isSafeInteger(previous.sandboxArtifact.ino) ||
						!Number.isSafeInteger(previous.sandboxArtifact.dev)))
			) {
				throw new Error(
					"Invalid Cursor permission lease. Inspect it before starting another session.",
				);
			}
			if (processIsAlive(previous.pid)) {
				throw new Error(
					"Another Cursor session owns this workspace's permission hooks",
				);
			}
			const recoveryPath = join(
				cursorDir,
				`cyrus-permission-recovery-${previous.id}`,
			);
			try {
				writeFileSync(recoveryPath, String(process.pid), {
					flag: "wx",
					mode: 0o600,
				});
			} catch {
				throw new Error(
					"Another process is recovering Cursor permission hooks. Inspect an interrupted recovery before retrying.",
				);
			}
			try {
				const current = JSON.parse(
					readFileSync(leasePath, "utf8"),
				) as PermissionLease;
				if (current.id !== previous.id || current.pid !== previous.pid) {
					throw new Error(
						"Cursor permission ownership changed during recovery. Retry after the active session finishes.",
					);
				}
				if (
					previous.generatedSandbox &&
					!previous.sandboxArtifact &&
					existsSync(join(cursorDir, "sandbox.json"))
				) {
					throw new Error(
						"Cannot establish ownership of an interrupted Cursor sandbox. Inspect sandbox.json before retrying. Its Git exclusion was preserved.",
					);
				}
				cleanupGeneratedSandbox(cursorDir, previous);
				restoreHooks(cursorDir, previous);
				if (previous.hooksSkipWorktreeAdded)
					setHooksSkipWorktree(cursorDir, false);
				removeSessionExclusions(cursorDir, previous);
				rmSync(join(cursorDir, "cyrus-permission-sessions", previous.id), {
					recursive: true,
					force: true,
				});
				unlinkSync(leasePath);
			} finally {
				unlinkSync(recoveryPath);
			}
		}
		const hooksPath = join(cursorDir, "hooks.json");
		const original = existsSync(hooksPath)
			? readFileSync(hooksPath, "utf8")
			: null;
		const hooks = parseHooks(original);
		const id = randomUUID();
		for (const event of EVENTS) {
			hooks.hooks[event] = [
				{ command: commandFor(id), failClosed: true },
				...(hooks.hooks[event] ?? []),
			];
		}
		const trackedStatus = trackedHooksStatus(cursorDir);
		const lease: PermissionLease = {
			version: 1,
			pid: process.pid,
			id,
			original,
			installed: `${JSON.stringify(hooks, null, "\t")}\n`,
			hooksSkipWorktreeAdded:
				Boolean(trackedStatus) && !/^s /i.test(trackedStatus),
			excludeHooks: !trackedStatus,
			generatedSandbox: !existsSync(join(cursorDir, "sandbox.json")),
		};
		createLease(leasePath, lease);
		const result = new ProjectPermissionHooks(cursorDir, lease);
		try {
			addSessionExclusions(cursorDir, lease);
			if (lease.hooksSkipWorktreeAdded) setHooksSkipWorktree(cursorDir, true);
			const directory = join(cursorDir, "cyrus-permission-sessions", id);
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			writeFileSync(
				join(directory, "cyrus-permissions.json"),
				JSON.stringify(permissions),
				{ mode: 0o600 },
			);
			copyFileSync(helperSource, join(directory, "cyrus-permission-check.mjs"));
			chmodSync(join(directory, "cyrus-permission-check.mjs"), 0o700);
			writeHooks(hooksPath, lease.installed);
			return result;
		} catch (error) {
			result.dispose();
			throw error;
		}
	}

	/** Persist ownership before the policy becomes visible to Cursor or Git. */
	installGeneratedSandbox(contents: string): void {
		if (!this.lease.generatedSandbox)
			throw new Error("Cannot replace an existing Cursor sandbox policy");
		const leasePath = join(this.cursorDir, "cyrus-permission-session.json");
		const current = JSON.parse(
			readFileSync(leasePath, "utf8"),
		) as PermissionLease;
		if (current.id !== this.lease.id)
			throw new Error(
				"Cursor permission ownership changed before sandbox installation",
			);
		const temporary = join(
			this.cursorDir,
			"cyrus-permission-sessions",
			this.lease.id,
			"sandbox.json",
		);
		writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
		const stat = lstatSync(temporary);
		this.lease.sandboxArtifact = { contents, ino: stat.ino, dev: stat.dev };
		writeHooks(leasePath, JSON.stringify(this.lease));
		// Hard-link creation preserves the recorded identity and refuses replacements.
		linkSync(temporary, join(this.cursorDir, "sandbox.json"));
		unlinkSync(temporary);
	}

	dispose(): void {
		cleanupGeneratedSandbox(this.cursorDir, this.lease);
		restoreHooks(this.cursorDir, this.lease);
		if (this.lease.hooksSkipWorktreeAdded)
			setHooksSkipWorktree(this.cursorDir, false);
		removeSessionExclusions(this.cursorDir, this.lease);
		rmSync(join(this.cursorDir, "cyrus-permission-sessions", this.lease.id), {
			recursive: true,
			force: true,
		});
		const leasePath = join(this.cursorDir, "cyrus-permission-session.json");
		if (existsSync(leasePath)) {
			const current = JSON.parse(
				readFileSync(leasePath, "utf8"),
			) as PermissionLease;
			if (current.id === this.lease.id) unlinkSync(leasePath);
		}
	}
}
