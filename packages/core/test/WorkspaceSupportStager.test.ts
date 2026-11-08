import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedSkillStager } from "../src/ManagedSkillStager.js";
import { WorkspaceSupportStager } from "../src/WorkspaceSupportStager.js";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "cyrus-workflow-support-"));
	roots.push(root);
	const source = join(root, "source"),
		cwd = join(root, "worktree");
	mkdirSync(join(source, "_workflow", "scripts"), { recursive: true });
	mkdirSync(cwd);
	writeFileSync(
		join(source, "_workflow", "scripts", "render.py"),
		"print('complete workflow')\n",
	);
	mkdirSync(join(source, ".agents", "skills", "build", "assets"), {
		recursive: true,
	});
	writeFileSync(
		join(source, ".agents", "skills", "build", "SKILL.md"),
		"Use {project-root}/_workflow/scripts/render.py",
	);
	writeFileSync(
		join(source, ".agents", "skills", "build", "assets", "template.txt"),
		"Template",
	);
	const config = {
		workingDirectory: cwd,
		workspaceSupportSource: source,
		workspaceSupportPaths: ["_workflow", ".agents/skills"],
	};
	return {
		root,
		source,
		cwd,
		config,
		stager: new WorkspaceSupportStager(config),
	};
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("WorkspaceSupportStager", () => {
	it("preserves executable package permissions and supports individual configuration files", () => {
		const { source, cwd, config } = fixture();
		chmodSync(join(source, "_workflow"), 0o775);
		chmodSync(join(source, "_workflow/scripts/render.py"), 0o755);
		writeFileSync(join(source, "workflow.yaml"), "complete: true\n");
		const stager = new WorkspaceSupportStager({
			...config,
			workspaceSupportPaths: ["_workflow", "workflow.yaml"],
		});
		stager.stage();
		expect(lstatSync(join(cwd, "_workflow")).mode & 0o777).toBe(0o775);
		expect(
			lstatSync(join(cwd, "_workflow/scripts/render.py")).mode & 0o777,
		).toBe(0o755);
		expect(readFileSync(join(cwd, "workflow.yaml"), "utf8")).toBe(
			"complete: true\n",
		);
		stager.cleanup();
		expect(existsSync(join(cwd, "_workflow"))).toBe(false);
		expect(existsSync(join(cwd, "workflow.yaml"))).toBe(false);
	});
	it("copies complete project-relative helper and skill directories before native discovery", () => {
		const { source, cwd, stager } = fixture();
		stager.stage();
		const skills = new ManagedSkillStager({
			workingDirectory: cwd,
			skills: ["build"],
		});
		skills.stage();
		expect(skills.getStagedSkillNames()).toEqual(["build"]);
		expect(lstatSync(join(cwd, "_workflow")).isSymbolicLink()).toBe(false);
		expect(
			readFileSync(join(cwd, "_workflow/scripts/render.py"), "utf8"),
		).toContain("complete workflow");
		expect(
			readFileSync(
				join(cwd, ".agents/skills/build/assets/template.txt"),
				"utf8",
			),
		).toBe("Template");
		skills.cleanup();
		stager.cleanup();
		expect(existsSync(join(cwd, "_workflow"))).toBe(false);
		expect(existsSync(join(cwd, ".agents/skills"))).toBe(false);
		expect(existsSync(join(source, "_workflow/scripts/render.py"))).toBe(true);
	});
	it("preflights all required support and refuses incomplete installations before copying", () => {
		const { cwd, config } = fixture();
		expect(() =>
			new WorkspaceSupportStager({
				...config,
				workspaceSupportPaths: ["_workflow", "missing"],
			}).stage(),
		).toThrow("complete workflow package");
		expect(existsSync(join(cwd, "_workflow"))).toBe(false);
	});
	it("preserves differing worktree support and rejects collisions", () => {
		const { cwd, stager } = fixture();
		mkdirSync(join(cwd, "_workflow"));
		writeFileSync(join(cwd, "_workflow/user.txt"), "User work");
		expect(() => stager.stage()).toThrow("conflicts with existing");
		expect(readFileSync(join(cwd, "_workflow/user.txt"), "utf8")).toBe(
			"User work",
		);
		expect(existsSync(join(cwd, ".agents/skills"))).toBe(false);
	});
	it("preserves edited copies without mutating the installed source", () => {
		const { source, cwd, stager } = fixture();
		stager.stage();
		writeFileSync(
			join(cwd, "_workflow/scripts/render.py"),
			"Edited in worktree",
		);
		stager.cleanup();
		expect(readFileSync(join(cwd, "_workflow/scripts/render.py"), "utf8")).toBe(
			"Edited in worktree",
		);
		expect(
			readFileSync(join(source, "_workflow/scripts/render.py"), "utf8"),
		).toContain("complete workflow");
	});
	it("retains shared support until every same-process session releases its copy", () => {
		const { cwd, config, stager } = fixture();
		const second = new WorkspaceSupportStager(config);
		stager.stage();
		second.stage();
		stager.cleanup();
		expect(existsSync(join(cwd, "_workflow"))).toBe(true);
		second.cleanup();
		expect(existsSync(join(cwd, "_workflow"))).toBe(false);
	});
	it("only preflights source checkouts and never removes their installed support", () => {
		const { source, config } = fixture();
		const stager = new WorkspaceSupportStager({
			...config,
			workingDirectory: source,
		});
		stager.stage();
		stager.cleanup();
		expect(existsSync(join(source, "_workflow/scripts/render.py"))).toBe(true);
	});
	it("rejects traversal, overlapping entries, escaping targets and dangling symlinks", () => {
		const { root, cwd, config } = fixture();
		for (const path of [
			"../outside",
			".git/config",
			"/tmp/outside",
			"_workflow/../x",
			"_workflow\\scripts",
		]) {
			expect(() =>
				new WorkspaceSupportStager({
					...config,
					workspaceSupportPaths: [path],
				}).stage(),
			).toThrow("must be relative");
		}
		expect(() =>
			new WorkspaceSupportStager({
				...config,
				workspaceSupportPaths: ["_workflow", "_workflow/scripts"],
			}).stage(),
		).toThrow("must not overlap");
		symlinkSync(join(root, "absent"), join(cwd, "_workflow"));
		expect(() => new WorkspaceSupportStager(config).stage()).toThrow(
			"conflicts with existing",
		);
		rmSync(join(cwd, "_workflow"));
		symlinkSync(root, join(cwd, ".agents"));
		expect(() => new WorkspaceSupportStager(config).stage()).toThrow(
			"escapes its worktree",
		);
	});
});
