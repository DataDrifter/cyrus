import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface ManagedSkillStagingInput {
	workingDirectory?: string;
	additionalDirectories?: string[];
	skills?: string[] | "all";
	plugins?: Array<{ type?: string; path?: unknown }>;
}

type StagedLink = {
	path: string;
	source: string;
	ino: number;
	dev: number;
	leases: number;
};
const activeLinks = new Map<string, StagedLink>();

/** Links complete skill directories into native discovery without replacing project files. */
export class ManagedSkillStager {
	private links: StagedLink[] = [];
	private names: string[] = [];

	constructor(private readonly input: ManagedSkillStagingInput) {}

	getStagedSkillNames(): string[] {
		return [...this.names];
	}

	stage(): void {
		this.cleanup();
		const cwd = this.input.workingDirectory;
		if (!cwd || this.input.skills?.length === 0) return;
		const allowed = Array.isArray(this.input.skills)
			? new Set(this.input.skills)
			: undefined;
		const sources = new Map<string, string>();
		const add = (root: string) => {
			if (!existsSync(root)) return;
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				if (!/^[a-zA-Z0-9_.-]+$/.test(entry.name)) {
					throw new Error(
						`Invalid managed skill directory name: ${entry.name}`,
					);
				}
				if (allowed && !allowed.has(entry.name)) continue;
				const source = join(root, entry.name);
				if (!existsSync(join(source, "SKILL.md"))) continue;
				if (!sources.has(entry.name))
					sources.set(entry.name, realpathSync(source));
			}
		};
		for (const plugin of this.input.plugins ?? []) {
			if (plugin.type === "local" && typeof plugin.path === "string") {
				add(join(resolve(plugin.path), "skills"));
			}
		}
		for (const root of [cwd, ...(this.input.additionalDirectories ?? [])]) {
			for (const harness of [".agents", ".cursor", ".claude"]) {
				add(join(root, harness, "skills"));
			}
		}
		try {
			for (const [name, source] of sources) {
				const target = join(cwd, ".agents", "skills", name);
				for (const existing of [target, join(cwd, ".cursor", "skills", name)]) {
					try {
						lstatSync(existing);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
						throw error;
					}
					if (realpathSync(existing) !== source) {
						throw new Error(
							`Managed skill '${name}' conflicts with existing ${existing}. Resolve the duplicate before starting.`,
						);
					}
				}
				if (!existsSync(target)) {
					mkdirSync(dirname(target), { recursive: true });
					symlinkSync(source, target, "dir");
					const stat = lstatSync(target);
					const link = {
						path: target,
						source,
						ino: stat.ino,
						dev: stat.dev,
						leases: 1,
					};
					activeLinks.set(target, link);
					this.links.push(link);
					this.ignoreLink(cwd, name);
				} else {
					const link = activeLinks.get(target);
					const stat = lstatSync(target);
					if (
						link &&
						link.ino === stat.ino &&
						link.dev === stat.dev &&
						link.source === source
					) {
						link.leases += 1;
						this.links.push(link);
					}
				}
				this.names.push(name);
			}
		} catch (error) {
			this.cleanup();
			throw error;
		}
	}

	cleanup(): void {
		for (const link of this.links) {
			link.leases -= 1;
			if (link.leases > 0) continue;
			if (activeLinks.get(link.path) === link) activeLinks.delete(link.path);
			try {
				const stat = lstatSync(link.path);
				if (
					stat.isSymbolicLink() &&
					stat.ino === link.ino &&
					stat.dev === link.dev &&
					readlinkSync(link.path) === link.source
				) {
					unlinkSync(link.path);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					console.warn(
						`Could not remove managed skill link ${link.path}: ${String(error)}`,
					);
				}
			}
		}
		this.links = [];
		this.names = [];
	}

	private ignoreLink(cwd: string, name: string): void {
		try {
			const raw = execFileSync(
				"git",
				["rev-parse", "--git-path", "info/exclude"],
				{
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			).trim();
			const file = isAbsolute(raw) ? raw : join(cwd, raw);
			const pattern = `/.agents/skills/${name}`;
			const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
			if (existing.split(/\r?\n/).includes(pattern)) return;
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(
				file,
				`${existing && !existing.endsWith("\n") ? "\n" : ""}${pattern}\n`,
			);
		} catch {
			// Chat workspaces may have no Git metadata. Link cleanup still applies.
		}
	}
}
