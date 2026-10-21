import { appendFile, mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { assertOutside } from "./artifact.ts";
import {
	authorize,
	checkCoverage,
	type Deps,
	type Plan,
	planDispatch,
	planPush,
	preflightRelease,
	publishRelease,
	verifyRelease,
} from "./commands.ts";
import { errorMessage, ReleaseError } from "./errors.ts";
import { runCommand } from "./exec.ts";
import { Git } from "./git.ts";
import { ghGitHub } from "./github.ts";
import { batchComplete, type MemberReport, type PublishEffects } from "./publish.ts";
import { fetchHttp, lookupVersion, NPM_REGISTRY, tarballAvailable } from "./registry.ts";
import { ReleaseRepository } from "./repository.ts";

const USAGE = `usage: node tools/release/src/cli.ts <command> [options]

  coverage  --base <rev> --head <rev>
  plan      --event push --before <sha> --after <sha> --forced <true|false> --repo <owner/name> --default-branch <name>
  plan      --event dispatch --source <sha> --repo <owner/name> --default-branch <name>
  authorize --source <sha> --default-branch <name>
  verify    --source <sha> --source-dir <dir> --out <dir> --work-dir <dir>
  preflight --base <rev> --head <rev> --work-dir <dir>   (run in the checkout of --head)
  publish   --source <sha> --artifacts <dir> --repo <owner/name> --default-branch <name>

See docs/releases.md.`;

/** How long pnpm waits for an accepted upload to become installable (its native availability check). */
const PUBLISH_WAIT_MS = 600_000;

const OPTIONS = {
	base: { type: "string" },
	head: { type: "string" },
	event: { type: "string" },
	before: { type: "string" },
	after: { type: "string" },
	forced: { type: "string" },
	source: { type: "string" },
	repo: { type: "string" },
	"default-branch": { type: "string" },
	"source-dir": { type: "string" },
	out: { type: "string" },
	"work-dir": { type: "string" },
	artifacts: { type: "string" },
	remote: { type: "string", default: "origin" },
	registry: { type: "string", default: NPM_REGISTRY },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; strict: true }>>["values"];

function required(values: Values, name: keyof typeof OPTIONS): string {
	const value = values[name];
	if (typeof value !== "string" || value === "") {
		throw new ReleaseError(`missing --${name}\n\n${USAGE}`);
	}
	return value;
}

function write(text: string): void {
	process.stdout.write(`${text}\n`);
}

async function output(entries: Record<string, string>): Promise<void> {
	const { GITHUB_OUTPUT: file } = process.env;
	if (file !== undefined && file !== "") {
		await appendFile(
			file,
			Object.entries(entries)
				.map(([key, value]) => `${key}=${value}\n`)
				.join(""),
		);
	}
}

async function summary(markdown: string): Promise<void> {
	const { GITHUB_STEP_SUMMARY: file } = process.env;
	if (file !== undefined && file !== "") {
		await appendFile(file, `${markdown}\n`);
	}
}

function deps(values: Values, repo: ReleaseRepository): Deps {
	const registry = required(values, "registry");
	return {
		repo,
		github: ghGitHub(runCommand, required(values, "repo")),
		lookupVersion: (name, version) => lookupVersion(fetchHttp, registry, name, version),
	};
}

async function reportPlan(plan: Plan): Promise<void> {
	if (plan.kind === "no-op") {
		write(`release no-op: ${plan.reason}`);
		await output({ publish: "false", source_sha: "" });
		await summary(`### Release\n\nNo publication: ${plan.reason}.`);
		return;
	}
	const members = plan.members.map((member) => member.key);
	write(`release batch of ${plan.source} (first parent ${plan.parent}, pull request #${plan.pull}):`);
	for (const key of members) {
		write(`  ${key}`);
	}
	await output({ publish: "true", source_sha: plan.source });
	await summary(
		`### Release batch\n\nSource \`${plan.source}\`, first parent \`${plan.parent}\`, pull request #${plan.pull}.\n\n${members.map((key) => `- \`${key}\``).join("\n")}`,
	);
}

function formatReports(reports: readonly MemberReport[]): string {
	return reports
		.map(
			(report) =>
				`| \`${report.key}\` | ${report.upload} | ${report.tag} | ${report.release} | ${report.problems.join("; ").replaceAll("|", "\\|")} |`,
		)
		.join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	const { values } = parseArgs({ args: [...rest], options: OPTIONS, strict: true });
	const cwd = process.cwd();
	const repo = new ReleaseRepository(new Git(runCommand, cwd));
	switch (command) {
		case "coverage": {
			const report = await checkCoverage(repo, required(values, "base"), required(values, "head"));
			write(`release-impact gate: ${report.mergeBase}..${report.head}`);
			for (const plugin of report.plugins) {
				write(`  ${plugin.name}: ${plugin.decision ?? "NO DECISION"}`);
			}
			for (const notice of report.notices) {
				write(`notice: ${notice}`);
			}
			for (const problem of report.problems) {
				write(`error: ${problem}`);
			}
			return report.problems.length === 0 ? 0 : 1;
		}
		case "plan": {
			const event = required(values, "event");
			const defaultBranch = required(values, "default-branch");
			let plan: Plan;
			if (event === "push") {
				const forced = required(values, "forced");
				if (forced !== "true" && forced !== "false") {
					throw new ReleaseError(`--forced must be true or false, not "${forced}"`);
				}
				plan = await planPush(deps(values, repo), {
					before: required(values, "before"),
					after: required(values, "after"),
					forced: forced === "true",
					defaultBranch,
				});
			} else if (event === "dispatch") {
				plan = await planDispatch(deps(values, repo), {
					sourceSha: required(values, "source"),
					defaultBranch,
					remote: required(values, "remote"),
				});
			} else {
				throw new ReleaseError(`--event must be push or dispatch, not "${event}"`);
			}
			await reportPlan(plan);
			return 0;
		}
		case "authorize": {
			const result = await authorize(repo, {
				sourceSha: required(values, "source"),
				defaultBranch: required(values, "default-branch"),
				remote: required(values, "remote"),
			});
			write(`authorized ${result.source} (first parent ${result.parent}) through default-branch head ${result.head}:`);
			for (const member of result.members) {
				write(`  ${member.key}`);
			}
			return 0;
		}
		case "verify": {
			const sourceDir = resolve(required(values, "source-dir"));
			const result = await verifyRelease(
				repo,
				{
					run: runCommand,
					sourceDir,
					outDir: resolve(required(values, "out")),
					workDir: resolve(required(values, "work-dir")),
					hostBin: resolve(sourceDir, "node_modules/.bin/pi"),
				},
				required(values, "source"),
			);
			for (const artifact of result.artifacts) {
				write(
					`verified ${artifact.key}: ${artifact.file} sha256 ${artifact.sha256}, commands [${artifact.commands.join(", ")}]`,
				);
			}
			return 0;
		}
		case "preflight": {
			const workDir = resolve(required(values, "work-dir"));
			assertOutside(cwd, workDir);
			await mkdir(workDir, { recursive: true });
			const result = await preflightRelease(
				repo,
				{
					run: runCommand,
					sourceDir: cwd,
					outDir: await mkdtemp(join(workDir, "artifacts-")),
					workDir,
					hostBin: resolve(cwd, "node_modules/.bin/pi"),
				},
				{ baseRev: required(values, "base"), headRev: required(values, "head") },
			);
			if (result === undefined) {
				write("artifact preflight: no new release records; nothing to pack");
				return 0;
			}
			write(`artifact preflight against merge base ${result.mergeBase}:`);
			for (const artifact of result.artifacts) {
				write(`  ${artifact.key}: ${artifact.file}, commands [${artifact.commands.join(", ")}]`);
			}
			return 0;
		}
		case "publish": {
			const registry = required(values, "registry");
			const github = ghGitHub(runCommand, required(values, "repo"));
			const effects: PublishEffects = {
				lookupVersion: (name, version) => lookupVersion(fetchHttp, registry, name, version),
				tarballAvailable: (url) => tarballAvailable(fetchHttp, url),
				upload: async (tarball) => {
					const args = ["publish", tarball, "--access", "public", "--no-git-checks"];
					const result = await runCommand("pnpm", [...args, "--publish-wait-timeout", String(PUBLISH_WAIT_MS)], {
						cwd,
					});
					if (result.code === 0) {
						return;
					}
					const log = `${result.stdout}\n${result.stderr}`;
					const accepted = log.includes("ERR_PNPM_PUBLISH_AVAILABILITY_TIMEOUT");
					throw new ReleaseError(
						accepted
							? "the registry accepted the upload but it is not installable yet; do not upload again: rerun this workflow later to confirm availability and announce"
							: `pnpm publish failed: ${log.trim().slice(-2000)}`,
					);
				},
				tagTarget: (tag) => github.tagTarget(tag),
				createTag: (tag, sha) => github.createTag(tag, sha),
				releaseExists: (tag) => github.releaseExists(tag),
				createRelease: (tag, notes) => github.createRelease(tag, notes),
			};
			const { authorization, reports } = await publishRelease(repo, effects, {
				sourceSha: required(values, "source"),
				defaultBranch: required(values, "default-branch"),
				remote: required(values, "remote"),
				artifactsDir: resolve(required(values, "artifacts")),
			});
			const table = `| package | upload | tag | release | problems |\n|---|---|---|---|---|\n${formatReports(reports)}`;
			write(
				`source ${authorization.source}, first parent ${authorization.parent}, authorization head ${authorization.head}\n${table}`,
			);
			await summary(
				`### Publication\n\nSource \`${authorization.source}\`, first parent \`${authorization.parent}\`, authorization head \`${authorization.head}\`.\n\n${table}`,
			);
			return batchComplete(reports) ? 0 : 1;
		}
		default:
			write(USAGE);
			return command === undefined || command === "help" ? 0 : 1;
	}
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`error: ${errorMessage(error)}\n`);
		process.exitCode = 1;
	},
);
