import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { CursorRunnerConfig } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Explicit files are merged in order, followed by inline session overrides. */
export function loadCursorMcpConfig(
	config: CursorRunnerConfig,
	workspace: string,
): NonNullable<CursorRunnerConfig["mcpConfig"]> {
	const merged: NonNullable<CursorRunnerConfig["mcpConfig"]> = {};
	const paths = config.mcpConfigPath
		? Array.isArray(config.mcpConfigPath)
			? config.mcpConfigPath
			: [config.mcpConfigPath]
		: [];
	for (const file of paths) {
		const path = resolve(
			workspace,
			file.startsWith("~/") ? resolve(homedir(), file.slice(2)) : file,
		);
		let document: unknown;
		try {
			document = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			throw new Error(`Cannot read Cursor MCP configuration: ${path}`);
		}
		if (!isRecord(document) || !isRecord(document.mcpServers)) {
			throw new Error(
				`Cursor MCP configuration must contain mcpServers: ${path}`,
			);
		}
		for (const [name, server] of Object.entries(document.mcpServers)) {
			if (!isRecord(server)) {
				throw new Error(`Invalid MCP server '${name}' in ${path}`);
			}
			merged[name] = server as NonNullable<
				CursorRunnerConfig["mcpConfig"]
			>[string];
		}
	}
	Object.assign(merged, config.mcpConfig);
	return merged;
}

/** Keep Cursor's harness intact. These instructions retain user-message priority. */
export function buildCursorPrompt(
	prompt: string,
	config: Pick<CursorRunnerConfig, "systemPrompt" | "appendSystemPrompt">,
): string {
	const guidance = [config.systemPrompt, config.appendSystemPrompt].filter(
		(value): value is string => Boolean(value?.trim()),
	);
	if (guidance.length === 0) return prompt;
	return `${guidance.join("\n\n")}\n\n${prompt}`;
}
