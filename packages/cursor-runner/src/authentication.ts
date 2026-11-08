import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SdkCredentialStore, SdkLoginOptions } from "@cursor/sdk";

const credentialFilename = "cursor-sdk-auth.json";

/** Use the SDK's supported store without changing its global login. */
export async function loadCyrusCursorApiKey(
	cyrusHome: string,
): Promise<string | undefined> {
	const path = join(cyrusHome, credentialFilename);
	if (!existsSync(path)) return undefined;
	const { FileCredentialStore } = await import("@cursor/sdk");
	const credentials = await new FileCredentialStore(path).load();
	if (
		!credentials ||
		(credentials.apiKeyExpiresAtMs !== undefined &&
			credentials.apiKeyExpiresAtMs <= Date.now())
	) {
		throw new Error(
			"Cyrus Cursor sign-in is invalid or expired. Use self-auth-cursor again.",
		);
	}
	return credentials.apiKey;
}

export interface CyrusCursorLoginOptions {
	cyrusHome: string;
	expectedEmail: string;
	teamId: number;
	openBrowser?: SdkLoginOptions["openBrowser"];
	onLoginUrl?: SdkLoginOptions["onLoginUrl"];
	signal?: AbortSignal;
}

/** Verify identity before saving credentials. Never return credentials to CLI output. */
export async function loginCyrusCursor(
	options: CyrusCursorLoginOptions,
): Promise<{
	email: string;
	teamId: number;
	apiKeyExpiresAtMs: number;
}> {
	const expectedEmail = options.expectedEmail.trim().toLowerCase();
	if (
		!expectedEmail.includes("@") ||
		!Number.isSafeInteger(options.teamId) ||
		options.teamId <= 0
	) {
		throw new Error(
			"Provide the intended Cursor email and a positive Team ID.",
		);
	}
	const { Cursor, FileCredentialStore } = await import("@cursor/sdk");
	const destination = new FileCredentialStore(
		join(options.cyrusHome, credentialFilename),
	);
	let verifiedEmail: string | undefined;
	const guardedStore: SdkCredentialStore = {
		// A failed login must not read or clear the prior working credential.
		load: async () => undefined,
		clear: async () => {},
		async save(credentials) {
			let email: string | undefined;
			try {
				const account = await Cursor.me({
					apiKey: credentials.apiKey,
					teamId: options.teamId,
				});
				email = account.userEmail?.trim().toLowerCase();
			} catch {
				throw new Error(
					"Could not verify the intended Cursor account. Cyrus credentials were not changed.",
				);
			}
			if (email !== expectedEmail) {
				throw new Error(
					"Cursor sign-in used a different account. Select the requested account and try again.",
				);
			}
			await destination.save({ ...credentials, email });
			verifiedEmail = email;
		},
	};
	const result = await Cursor.auth.login({
		store: guardedStore,
		apiKeyName: "Cyrus local Cursor",
		openBrowser: options.openBrowser ?? true,
		onLoginUrl: options.onLoginUrl,
		signal: options.signal,
	});
	if (!verifiedEmail)
		throw new Error("Cursor sign-in was not verified or saved.");
	return {
		email: verifiedEmail,
		teamId: options.teamId,
		apiKeyExpiresAtMs: result.apiKeyExpiresAtMs,
	};
}
