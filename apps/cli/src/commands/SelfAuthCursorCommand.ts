import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { EdgeConfigSchema, migrateEdgeConfig } from "cyrus-core";
import { loginCyrusCursor } from "cyrus-edge-worker";
import { BaseCommand } from "./ICommand.js";

export class SelfAuthCursorCommand extends BaseCommand {
	async execute(args: string[]): Promise<void> {
		const [email, team] = args;
		const teamId = Number(team);
		if (!email || !Number.isSafeInteger(teamId) || teamId <= 0) {
			throw new Error("Provide --email and a positive --team-id.");
		}
		const configPath = this.app.config.getConfigPath();
		// Read strictly before authentication. Preserve unrelated configuration.
		const readConfig = () => {
			const config = existsSync(configPath)
				? JSON.parse(readFileSync(configPath, "utf8"))
				: { repositories: [] };
			if (!config || Array.isArray(config) || typeof config !== "object") {
				throw new Error("Cyrus config must be a JSON object.");
			}
			if (!EdgeConfigSchema.safeParse(migrateEdgeConfig(config)).success) {
				throw new Error(
					"Cyrus config is invalid. Fix it before Cursor authentication.",
				);
			}
			return config;
		};
		readConfig();
		this.logger.info(
			`Sign in to Cursor as ${email}. The personal SDK login will stay unchanged.`,
		);
		const result = await loginCyrusCursor({
			cyrusHome: this.app.cyrusHome,
			expectedEmail: email,
			teamId,
		});
		// Browser sign-in can take minutes. Preserve edits made while it was open.
		const config = readConfig();
		writeFileSync(
			configPath,
			`${JSON.stringify({ ...config, cursorAccountEmail: result.email, cursorTeamId: result.teamId }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		this.logSuccess(
			`Cyrus Cursor account verified: ${result.email}. Team ${result.teamId} selected.`,
		);
		this.logger.info(
			"Confirm Team billing with a bounded task before unattended processing. No issue was started.",
		);
	}
}
