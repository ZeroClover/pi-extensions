import { isAbsolute, resolve } from "node:path";

/** Where a shell-running tool keeps its command and the inputs that decide whether RTK may rewrite it. */
export interface ToolAdapter {
	/** Input field holding the shell command string. */
	commandField: string;
	/** Input field naming the shell binary, or `false` for no shell; other than a POSIX shell is never rewritten. */
	shellField?: string;
	/** Boolean input field requesting a PTY; interactive sessions are never rewritten. */
	ttyField?: string;
	/** Input field holding the working directory, resolved against the session cwd. */
	cwdField?: string;
}

/**
 * Pi's built-in `bash` tool and pi-unified-exec's `exec_command`. Tools whose input does not match
 * an adapter (for example another extension's `exec_command` with different fields) are left alone.
 */
export const BUILTIN_ADAPTERS: Readonly<Record<string, ToolAdapter>> = {
	bash: { commandField: "command" },
	exec_command: { commandField: "cmd", shellField: "shell", ttyField: "tty", cwdField: "workdir" },
};

/** Shells whose `-c` syntax RTK's rewrites are written for. */
const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

export type SkipReason = "no-command" | "already-rtk" | "non-posix-shell" | "tty";

export type Target = { kind: "target"; command: string; cwd: string } | { kind: "skip"; reason: SkipReason };

function shellName(shell: string): string {
	const base = shell.split(/[\\/]/).pop() ?? shell;
	return base.replace(/\.exe$/i, "").toLowerCase();
}

/** Decides from a tool call's input whether its command may go through `rtk rewrite`, and in which directory. */
export function resolveTarget(
	adapter: ToolAdapter,
	input: Record<string, unknown>,
	sessionCwd: string,
	platform: NodeJS.Platform = process.platform,
): Target {
	const command = input[adapter.commandField];
	if (typeof command !== "string" || command.trim() === "") return { kind: "skip", reason: "no-command" };
	if (/^\s*rtk(\s|$)/.test(command)) return { kind: "skip", reason: "already-rtk" };
	if (adapter.ttyField !== undefined && input[adapter.ttyField] === true) return { kind: "skip", reason: "tty" };
	if (adapter.shellField !== undefined) {
		const shell = input[adapter.shellField];
		// `shell: false` means the tool runs the command without a shell, where RTK's rewrites do not parse.
		if (shell === false) return { kind: "skip", reason: "non-posix-shell" };
		if (typeof shell === "string" && shell.trim() !== "") {
			if (!POSIX_SHELLS.has(shellName(shell.trim()))) return { kind: "skip", reason: "non-posix-shell" };
		} else if (platform === "win32") {
			// Exec tools choose their own default shell on Windows, which can be PowerShell (pi-unified-exec without Git Bash).
			return { kind: "skip", reason: "non-posix-shell" };
		}
	}
	let cwd = sessionCwd;
	if (adapter.cwdField !== undefined) {
		const dir = input[adapter.cwdField];
		if (typeof dir === "string" && dir.trim() !== "") cwd = isAbsolute(dir) ? dir : resolve(sessionCwd, dir);
	}
	return { kind: "target", command, cwd };
}
