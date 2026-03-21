#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.resolve(__dirname, "../package.json");
const validReleaseTypes = new Set(["patch", "minor", "major"]);
const explicitVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const execFileAsync = promisify(execFile);

function printUsage() {
	console.log("Usage: pnpm run bump [patch|minor|major|x.y.z] [--dry-run]");
}

function parseVersion(version) {
	const match = version.match(versionPattern);
	if (!match) {
		throw new Error(`Unsupported version format: ${version}`);
	}

	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ?? "",
	};
}

function resolveNextVersion(currentVersion, target) {
	if (explicitVersionPattern.test(target)) {
		return target;
	}

	if (!validReleaseTypes.has(target)) {
		throw new Error(`Unsupported bump type: ${target}`);
	}

	const parsed = parseVersion(currentVersion);
	if (target === "major") {
		return `${parsed.major + 1}.0.0`;
	}

	if (target === "minor") {
		return `${parsed.major}.${parsed.minor + 1}.0`;
	}

	return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

async function runGit(args) {
	return execFileAsync("git", args, { cwd: repoRoot });
}

async function inspectGitState() {
	try {
		await runGit(["rev-parse", "--is-inside-work-tree"]);
		const { stdout } = await runGit(["status", "--porcelain"]);
		return {
			available: true,
			clean: stdout.trim().length === 0,
		};
	}
	catch {
		return {
			available: false,
			clean: false,
		};
	}
}

async function ensureTagDoesNotExist(tagName) {
	const { stdout } = await runGit(["tag", "--list", tagName]);
	if (stdout.trim() === tagName) {
		throw new Error(`Git tag already exists: ${tagName}`);
	}
}

async function createCommitAndTag(nextVersion) {
	const message = `chore: bump version to ${nextVersion}`;
	const tagName = `v${nextVersion}`;

	await ensureTagDoesNotExist(tagName);
	await runGit(["add", "package.json"]);
	await runGit(["commit", "-m", message]);
	await runGit(["tag", tagName]);

	console.log(`Created git commit: ${message}`);
	console.log(`Created git tag: ${tagName}`);
}

async function main() {
	const rawArgs = process.argv.slice(2).filter(arg => arg !== "--");
	if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
		printUsage();
		return;
	}

	const dryRun = rawArgs.includes("--dry-run");
	const args = rawArgs.filter(arg => arg !== "--dry-run");
	const target = args[0] ?? "patch";

	const packageJsonText = await readFile(packageJsonPath, "utf8");
	const versionLineMatch = packageJsonText.match(/^(\s*"version"\s*:\s*")([^"]+)(",?)$/m);
	if (!versionLineMatch) {
		throw new Error("Cannot find version field in package.json");
	}

	const currentVersion = versionLineMatch[2];
	const nextVersion = resolveNextVersion(currentVersion, target);
	const gitState = await inspectGitState();
	const shouldAutoCommit = gitState.available && gitState.clean;

	if (nextVersion === currentVersion) {
		console.log(`Version unchanged: ${currentVersion}`);
		return;
	}

	if (dryRun) {
		console.log(`[dry-run] ${currentVersion} -> ${nextVersion}`);
		if (shouldAutoCommit) {
			console.log(`[dry-run] would create git commit and tag v${nextVersion}`);
		}
		else {
			console.log("[dry-run] skip git commit/tag because worktree is not clean before bump");
		}
		return;
	}

	const nextPackageJsonText = packageJsonText.replace(
		versionLineMatch[0],
		`${versionLineMatch[1]}${nextVersion}${versionLineMatch[3]}`,
	);

	await writeFile(packageJsonPath, nextPackageJsonText, "utf8");
	console.log(`Version bumped: ${currentVersion} -> ${nextVersion}`);

	if (shouldAutoCommit) {
		await createCommitAndTag(nextVersion);
	}
	else {
		console.log("Skipped git commit/tag because worktree was not clean before bump.");
	}
}

main().catch(error => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	printUsage();
	process.exitCode = 1;
});
