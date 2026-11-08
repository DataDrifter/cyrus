import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkLoginOptions, StoredSdkCredentials } from "@cursor/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ me: vi.fn(), login: vi.fn() }));
vi.mock("@cursor/sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cursor/sdk")>();
	return { ...actual, Cursor: { me: sdk.me, auth: { login: sdk.login } } };
});

import { FileCredentialStore } from "@cursor/sdk";
import {
	loadCyrusCursorApiKey,
	loginCyrusCursor,
} from "../src/authentication.js";

const homes: string[] = [];
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "cyrus-cursor-auth-"));
	homes.push(home);
	const file = join(home, "cursor-sdk-auth.json");
	return {
		home,
		file,
		store: new FileCredentialStore(file),
		options: {
			cyrusHome: home,
			expectedEmail: "agent@example.com",
			teamId: 42,
			openBrowser: false as const,
		},
	};
}
const credentials = (): StoredSdkCredentials => ({
	version: 1,
	backendUrl: "https://api.cursor.com",
	apiKey: "fixture-secret-never-log",
	apiKeyExpiresAtMs: Date.now() + 60000,
	createdAtMs: Date.now(),
	email: "unverified@example.com",
});
beforeEach(() => {
	vi.clearAllMocks();
	sdk.me.mockResolvedValue({ userEmail: "agent@example.com" });
	sdk.login.mockImplementation(async (options: SdkLoginOptions) => {
		const value = credentials();
		await options.store!.save(value);
		return { apiKeyExpiresAtMs: value.apiKeyExpiresAtMs };
	});
});
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("Cyrus Cursor credential isolation", () => {
	it("verifies the selected account and team before saving only to the Cyrus store", async () => {
		const { home, file, options } = fixture();
		const personalFile = join(home, "personal-sdk.json");
		const personalStore = new FileCredentialStore(personalFile);
		await personalStore.save({
			...credentials(),
			apiKey: "personal-fixture-key",
		});
		const personalBefore = readFileSync(personalFile, "utf8");
		sdk.me.mockResolvedValue({ userEmail: "  AGENT@EXAMPLE.COM " });
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const result = await loginCyrusCursor({
			...options,
			expectedEmail: " Agent@Example.com ",
		});
		expect(sdk.me).toHaveBeenCalledWith({
			apiKey: "fixture-secret-never-log",
			teamId: 42,
		});
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			apiKey: "fixture-secret-never-log",
			email: "agent@example.com",
		});
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readFileSync(personalFile, "utf8")).toBe(personalBefore);
		expect(result).toEqual({
			email: "agent@example.com",
			teamId: 42,
			apiKeyExpiresAtMs: expect.any(Number),
		});
		expect(JSON.stringify(result)).not.toContain("fixture-secret-never-log");
		expect(output).not.toHaveBeenCalled();
	});
	it.each([
		"different-account",
		"unverified-account",
	])("leaves existing credentials unchanged after %s", async (kind) => {
		const { file, store, options } = fixture();
		await store.save({ ...credentials(), apiKey: "previous-fixture-key" });
		const before = readFileSync(file, "utf8");
		if (kind === "different-account")
			sdk.me.mockResolvedValue({ userEmail: "other@example.com" });
		else sdk.me.mockRejectedValue(new Error("fixture-secret-never-log"));
		const error = await loginCyrusCursor(options).catch(
			(value: Error) => value,
		);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain("fixture-secret-never-log");
		expect(readFileSync(file, "utf8")).toBe(before);
	});
	it("does not save or claim success when SDK login never verifies credentials", async () => {
		const { file, options } = fixture();
		sdk.login.mockResolvedValue({ apiKeyExpiresAtMs: Date.now() + 60000 });
		await expect(loginCyrusCursor(options)).rejects.toThrow(
			"not verified or saved",
		);
		expect(existsSync(file)).toBe(false);
	});
	it("keeps existing credentials if an unsuccessful SDK flow requests clear", async () => {
		const { file, store, options } = fixture();
		await store.save({ ...credentials(), apiKey: "previous-fixture-key" });
		const before = readFileSync(file, "utf8");
		sdk.login.mockImplementation(async (options: SdkLoginOptions) => {
			await options.store!.clear();
			throw new Error("Sign-in cancelled");
		});
		await expect(loginCyrusCursor(options)).rejects.toThrow("cancelled");
		expect(readFileSync(file, "utf8")).toBe(before);
	});
	it.each([
		0,
		-1,
		1.5,
		Number.NaN,
	])("rejects invalid team %s before SDK authentication", async (teamId) => {
		const { options } = fixture();
		await expect(loginCyrusCursor({ ...options, teamId })).rejects.toThrow(
			"positive Team ID",
		);
		expect(sdk.login).not.toHaveBeenCalled();
	});
	it("returns undefined when the Cyrus store is absent without using any account", async () => {
		const { home } = fixture();
		expect(await loadCyrusCursorApiKey(home)).toBeUndefined();
		expect(sdk.me).not.toHaveBeenCalled();
		expect(sdk.login).not.toHaveBeenCalled();
	});
	it("loads valid isolated credentials", async () => {
		const { home, store } = fixture();
		await store.save(credentials());
		expect(await loadCyrusCursorApiKey(home)).toBe("fixture-secret-never-log");
	});
	it.each([
		"expired",
		"corrupt",
		"foreign-schema",
	])("rejects a present %s store instead of allowing fallback", async (kind) => {
		const { home, file, store } = fixture();
		if (kind === "expired")
			await store.save({ ...credentials(), apiKeyExpiresAtMs: Date.now() - 1 });
		else
			writeFileSync(
				file,
				kind === "corrupt"
					? "{broken json"
					: JSON.stringify({ apiKey: "foreign-fixture-key" }),
			);
		const before = readFileSync(file, "utf8");
		await expect(loadCyrusCursorApiKey(home)).rejects.toThrow(
			"invalid or expired",
		);
		expect(readFileSync(file, "utf8")).toBe(before);
	});
});
