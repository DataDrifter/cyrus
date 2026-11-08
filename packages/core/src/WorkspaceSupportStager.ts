import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	cpSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface WorkspaceSupportStagingInput {
	workingDirectory?: string;
	workspaceSupportSource?: string;
	workspaceSupportPaths?: string[];
}

type OwnedCopy = {
	path: string;
	digest: string;
	ino: number;
	dev: number;
	leases: number;
};
const activeCopies = new Map<string, OwnedCopy>();

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function digestTree(path: string): string {
	const hash = createHash("sha256");
	const ancestors = new Set<string>();
	const walk = (current: string, name: string) => {
		const canonical = realpathSync(current);
		if (ancestors.has(canonical))
			throw new Error("Workspace support contains a symbolic link cycle.");
		const stat = statSync(current);
		hash.update(
			JSON.stringify([
				name,
				stat.isDirectory() ? "directory" : "file",
				stat.mode & 0o777,
			]),
		);
		if (stat.isDirectory()) {
			ancestors.add(canonical);
			for (const child of readdirSync(current).sort())
				walk(join(current, child), join(name, child));
			ancestors.delete(canonical);
		} else if (stat.isFile()) hash.update(readFileSync(current));
		else
			throw new Error(
				"Workspace support can contain only files and directories.",
			);
	};
	walk(path, "");
	return hash.digest("hex");
}

function copyModes(source: string, target: string): void {
	const sourceStat = statSync(source);
	chmodSync(target, sourceStat.mode & 0o777);
	if (sourceStat.isDirectory()) {
		for (const child of readdirSync(source))
			copyModes(join(source, child), join(target, child));
	}
}

/** Copies installed workflow support files into a worktree without sharing mutable helper state. */
export class WorkspaceSupportStager {
	private copies: OwnedCopy[] = [];
	constructor(private readonly input: WorkspaceSupportStagingInput) {}

	stage(): void {
		this.cleanup();
		const paths = this.input.workspaceSupportPaths ?? [];
		if (!paths.length) return;
		if (!this.input.workingDirectory || !this.input.workspaceSupportSource) {
			throw new Error(
				"Workspace support requires a working directory and an installed package source.",
			);
		}
		const cwd = realpathSync(this.input.workingDirectory);
		const sourceRoot = realpathSync(this.input.workspaceSupportSource);
		const entries = paths.map((path) => {
			const parts = path.split(/[\\/]/);
			if (
				isAbsolute(path) ||
				path.includes("\\") ||
				parts.some(
					(part) =>
						!part ||
						part === "." ||
						part === ".." ||
						part === ".git" ||
						/[\r\n]/.test(part),
				)
			) {
				throw new Error(
					`Workspace support path must be relative and stay outside Git metadata: ${path}`,
				);
			}
			const source = resolve(sourceRoot, path);
			if (!existsSync(source))
				throw new Error(
					`Required workspace support '${path}' is missing. Install the complete workflow package in the source checkout before starting.`,
				);
			const target = resolve(cwd, path);
			let ancestor = dirname(target);
			while (!existsSync(ancestor)) ancestor = dirname(ancestor);
			const resolvedAncestor = realpathSync(ancestor);
			if (
				resolvedAncestor !== cwd &&
				relative(cwd, resolvedAncestor).startsWith("..")
			) {
				throw new Error(
					`Workspace support target escapes its worktree: ${path}`,
				);
			}
			return { path, source, target, digest: digestTree(source) };
		});
		for (const entry of entries) {
			if (
				entries.some(
					(other) =>
						other !== entry &&
						(entry.path === other.path ||
							entry.path.startsWith(`${other.path}/`)),
				)
			) {
				throw new Error("Workspace support paths must not overlap.");
			}
			if (entry.source === entry.target) continue;
			if (
				pathExists(entry.target) &&
				(lstatSync(entry.target).isSymbolicLink() ||
					digestTree(entry.target) !== entry.digest)
			) {
				throw new Error(
					`Workspace support '${entry.path}' conflicts with existing worktree files. Resolve the difference before starting.`,
				);
			}
		}
		try {
			for (const entry of entries) {
				if (entry.source === entry.target) continue;
				if (pathExists(entry.target)) {
					const lease = activeCopies.get(entry.target);
					const stat = lstatSync(entry.target);
					if (
						lease &&
						lease.ino === stat.ino &&
						lease.dev === stat.dev &&
						lease.digest === entry.digest
					) {
						lease.leases += 1;
						this.copies.push(lease);
					}
					continue;
				}
				mkdirSync(dirname(entry.target), { recursive: true });
				const temporary = mkdtempSync(
					join(dirname(entry.target), ".cyrus-support-"),
				);
				const prepared = join(temporary, "entry");
				try {
					cpSync(entry.source, prepared, {
						recursive: true,
						dereference: true,
						errorOnExist: true,
						force: false,
					});
					copyModes(entry.source, prepared);
					if (digestTree(prepared) !== entry.digest)
						throw new Error(
							`Workspace support '${entry.path}' changed during staging. Try again after the package installation finishes.`,
						);
					if (statSync(prepared).isDirectory()) {
						// Exclusive creation prevents overwriting a concurrently created target.
						mkdirSync(entry.target, { mode: statSync(prepared).mode });
						chmodSync(entry.target, statSync(prepared).mode & 0o777);
						try {
							for (const child of readdirSync(prepared))
								renameSync(join(prepared, child), join(entry.target, child));
						} catch (error) {
							// Leave any partially moved files for inspection. Never recursively delete an incomplete copy.
							try {
								rmdirSync(entry.target);
							} catch {
								/* A nonempty target is preserved. */
							}
							throw error;
						}
					} else {
						// A hard link publishes the prepared file exclusively, then temporary cleanup removes its other name.
						linkSync(prepared, entry.target);
					}
					const stat = lstatSync(entry.target);
					const copy = {
						path: entry.target,
						digest: entry.digest,
						ino: stat.ino,
						dev: stat.dev,
						leases: 1,
					};
					activeCopies.set(entry.target, copy);
					this.copies.push(copy);
					this.ignoreCopy(cwd, entry.path);
				} finally {
					rmSync(temporary, { recursive: true, force: true });
				}
			}
		} catch (error) {
			this.cleanup();
			throw error;
		}
	}

	cleanup(): void {
		for (const copy of this.copies) {
			copy.leases -= 1;
			if (copy.leases > 0) continue;
			if (activeCopies.get(copy.path) === copy) activeCopies.delete(copy.path);
			try {
				const stat = lstatSync(copy.path);
				if (
					stat.ino === copy.ino &&
					stat.dev === copy.dev &&
					!stat.isSymbolicLink() &&
					digestTree(copy.path) === copy.digest
				)
					rmSync(copy.path, { recursive: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					console.warn(
						`Could not clean workspace support ${copy.path}: ${String(error)}`,
					);
			}
		}
		this.copies = [];
	}

	private ignoreCopy(cwd: string, path: string): void {
		try {
			const raw = execFileSync(
				"git",
				["rev-parse", "--git-path", "info/exclude"],
				{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
			).trim();
			const file = isAbsolute(raw) ? raw : join(cwd, raw);
			const pattern = `/${path}`;
			const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
			if (existing.split(/\r?\n/).includes(pattern)) return;
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(
				file,
				`${existing && !existing.endsWith("\n") ? "\n" : ""}${pattern}\n`,
			);
		} catch {
			// Non-Git workspaces still receive support files and ownership-safe cleanup.
		}
	}
}
