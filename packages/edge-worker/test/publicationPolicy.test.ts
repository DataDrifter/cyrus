import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePublicationPolicy } from "../src/publicationPolicy.js";

const directories: string[] = [];
function repository(url = "https://github.com/example/private.git"): string {
	const cwd = mkdtempSync(join(tmpdir(), "cyrus-publication-"));
	directories.push(cwd);
	execFileSync("git", ["init", "--quiet", cwd]);
	execFileSync("git", ["remote", "add", "origin", url], { cwd });
	return cwd;
}

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("publication destination validation", () => {
	it("leaves existing behavior unchanged unless configured", () => {
		expect(resolvePublicationPolicy("/does-not-exist")).toEqual({
			guidance: "",
			disallowedTools: [],
		});
	});
	it("allows a private destination through its equivalent SSH transport", () => {
		const result = resolvePublicationPolicy(
			repository("git@github.com:example/private.git"),
			{
				mode: "branch-only",
				repositoryUrl: "https://github.com/example/private",
			},
		);
		expect(result.disallowedTools).toContain("mcp__*__create_pull_request");
	});
	it("blocks a different push URL even when the fetch URL is approved", () => {
		const cwd = repository();
		execFileSync(
			"git",
			[
				"remote",
				"set-url",
				"--push",
				"origin",
				"https://github.com/team/shared.git",
			],
			{ cwd },
		);
		expect(() =>
			resolvePublicationPolicy(cwd, {
				mode: "branch-only",
				repositoryUrl: "https://github.com/example/private.git",
			}),
		).toThrow("unapproved origin");
	});
	it("blocks multiple push destinations", () => {
		const cwd = repository();
		execFileSync(
			"git",
			[
				"remote",
				"set-url",
				"--add",
				"--push",
				"origin",
				"https://github.com/example/private.git",
			],
			{ cwd },
		);
		execFileSync(
			"git",
			[
				"remote",
				"set-url",
				"--add",
				"--push",
				"origin",
				"https://github.com/team/shared.git",
			],
			{ cwd },
		);
		expect(() =>
			resolvePublicationPolicy(cwd, {
				mode: "branch-only",
				repositoryUrl: "https://github.com/example/private.git",
			}),
		).toThrow("unapproved origin");
	});
	it("fails when origin cannot be verified", () => {
		expect(() =>
			resolvePublicationPolicy("/does-not-exist", {
				mode: "branch-only",
				repositoryUrl: "https://github.com/example/private.git",
			}),
		).toThrow("could not verify");
	});
	it("rejects credential-bearing destinations without exposing the credential", () => {
		expect(() =>
			resolvePublicationPolicy(repository(), {
				mode: "branch-only",
				repositoryUrl: "https://private-token@github.com/example/private.git",
			}),
		).toThrow("credential-free");
	});
	it("allows local work without a remote and denies publishing commands", () => {
		const result = resolvePublicationPolicy("/does-not-exist", {
			mode: "local-only",
		});
		expect(result.disallowedTools).toContain("Bash(git:*push*)");
		expect(result.disallowedTools).toContain("Bash(glab:mr create*)");
	});
});
