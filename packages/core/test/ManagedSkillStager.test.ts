import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedSkillStager } from "../src/ManagedSkillStager.js";

const roots: string[] = [];
const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "cyrus-managed-skills-"));
	roots.push(root);
	const cwd = join(root, "workspace");
	const plugin = join(root, "package");
	mkdirSync(cwd);
	return { root, cwd, plugin };
};
const skill = (root: string, name: string) => {
	const path = join(root, "skills", name);
	mkdirSync(join(path, "scripts"), { recursive: true });
	mkdirSync(join(path, "references"));
	writeFileSync(join(path, "SKILL.md"), `# ${name}`);
	writeFileSync(
		join(path, "scripts", "helper.py"),
		"print('complete package')\n",
	);
	writeFileSync(join(path, "references", "guide.txt"), "Reference contents");
};
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("ManagedSkillStager", () => {
	it("keeps shared managed links until the final same-process session releases them", () => {
		const { cwd, plugin } = fixture();
		skill(plugin, "build-auto");
		const config = {
			workingDirectory: cwd,
			plugins: [{ type: "local", path: plugin }],
		};
		const first = new ManagedSkillStager(config),
			second = new ManagedSkillStager(config);
		first.stage();
		second.stage();
		first.cleanup();
		expect(existsSync(join(cwd, ".agents/skills/build-auto/SKILL.md"))).toBe(
			true,
		);
		second.cleanup();
		expect(existsSync(join(cwd, ".agents/skills/build-auto"))).toBe(false);
	});
	it("makes supporting scripts and references available and preserves package contents on cleanup", () => {
		const { cwd, plugin } = fixture();
		skill(plugin, "build-auto");
		skill(plugin, "disabled");
		const stager = new ManagedSkillStager({
			workingDirectory: cwd,
			plugins: [{ type: "local", path: plugin }],
			skills: ["build-auto"],
		});
		stager.stage();
		const target = join(cwd, ".agents", "skills", "build-auto");
		expect(readFileSync(join(target, "scripts", "helper.py"), "utf8")).toBe(
			"print('complete package')\n",
		);
		expect(readFileSync(join(target, "references", "guide.txt"), "utf8")).toBe(
			"Reference contents",
		);
		expect(stager.getStagedSkillNames()).toEqual(["build-auto"]);
		expect(existsSync(join(cwd, ".agents", "skills", "disabled"))).toBe(false);
		stager.cleanup();
		expect(existsSync(target)).toBe(false);
		expect(
			existsSync(join(plugin, "skills", "build-auto", "scripts", "helper.py")),
		).toBe(true);
	});

	it("preserves a project directory that replaces an owned link during a session", () => {
		const { cwd, plugin } = fixture();
		skill(plugin, "build-auto");
		const stager = new ManagedSkillStager({
			workingDirectory: cwd,
			plugins: [{ type: "local", path: plugin }],
		});
		stager.stage();
		const target = join(cwd, ".agents", "skills", "build-auto");
		unlinkSync(target);
		mkdirSync(target);
		writeFileSync(join(target, "SKILL.md"), "User replacement");
		stager.cleanup();
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(
			"User replacement",
		);
	});

	it("fails before substituting a conflicting native project skill", () => {
		const { cwd, plugin } = fixture();
		skill(plugin, "build-auto");
		skill(join(cwd, ".cursor"), "build-auto");
		const stager = new ManagedSkillStager({
			workingDirectory: cwd,
			plugins: [{ type: "local", path: plugin }],
		});
		expect(() => stager.stage()).toThrow("conflicts with existing");
		expect(existsSync(join(cwd, ".agents", "skills", "build-auto"))).toBe(
			false,
		);
	});

	it("discovers native repository skills without removing existing directories", () => {
		const { cwd } = fixture();
		skill(join(cwd, ".agents"), "research");
		const stager = new ManagedSkillStager({
			workingDirectory: cwd,
			skills: ["research"],
		});
		stager.stage();
		expect(stager.getStagedSkillNames()).toEqual(["research"]);
		stager.cleanup();
		expect(
			existsSync(join(cwd, ".agents", "skills", "research", "SKILL.md")),
		).toBe(true);
	});
});
