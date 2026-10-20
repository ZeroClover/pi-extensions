import { describe, expect, it } from "vitest";
import { BUILTIN_ADAPTERS, resolveTarget, type ToolAdapter } from "../src/adapters.ts";

const bash: ToolAdapter = { commandField: "command" };
const exec: ToolAdapter = { commandField: "cmd", shellField: "shell", ttyField: "tty", cwdField: "workdir" };

describe("BUILTIN_ADAPTERS", () => {
	it("covers Pi's bash and pi-unified-exec's exec_command", () => {
		expect(BUILTIN_ADAPTERS).toEqual({ bash, exec_command: exec });
	});
});

describe("resolveTarget", () => {
	it("returns the command and the session cwd", () => {
		expect(resolveTarget(bash, { command: "git status", timeout: 10 }, "/repo")).toEqual({
			kind: "target",
			command: "git status",
			cwd: "/repo",
		});
	});

	it("skips a missing, non-string, or blank command", () => {
		expect(resolveTarget(bash, {}, "/repo")).toEqual({ kind: "skip", reason: "no-command" });
		expect(resolveTarget(bash, { command: 42 }, "/repo")).toEqual({ kind: "skip", reason: "no-command" });
		expect(resolveTarget(bash, { command: "  " }, "/repo")).toEqual({ kind: "skip", reason: "no-command" });
	});

	it("skips commands that already run through rtk", () => {
		expect(resolveTarget(bash, { command: "rtk git status" }, "/repo")).toEqual({
			kind: "skip",
			reason: "already-rtk",
		});
		expect(resolveTarget(bash, { command: "  rtk\tgain" }, "/repo")).toMatchObject({ kind: "skip" });
		expect(resolveTarget(bash, { command: "rtkx" }, "/repo")).toMatchObject({ kind: "target" });
	});

	it("skips PTY sessions", () => {
		expect(resolveTarget(exec, { cmd: "ssh host", tty: true }, "/repo")).toEqual({ kind: "skip", reason: "tty" });
		expect(resolveTarget(exec, { cmd: "git status", tty: false }, "/repo")).toMatchObject({ kind: "target" });
	});

	it("rewrites only for POSIX shells", () => {
		for (const shell of ["bash", "/bin/zsh", "sh", "C:\\Program Files\\Git\\bin\\bash.exe", " dash "]) {
			expect(resolveTarget(exec, { cmd: "git status", shell }, "/repo")).toMatchObject({ kind: "target" });
		}
		for (const shell of ["powershell", "pwsh", "cmd", "fish", "nu", "C:\\Windows\\System32\\cmd.exe"]) {
			expect(resolveTarget(exec, { cmd: "git status", shell }, "/repo")).toEqual({
				kind: "skip",
				reason: "non-posix-shell",
			});
		}
		expect(resolveTarget(exec, { cmd: "git status", shell: false }, "/repo")).toEqual({
			kind: "skip",
			reason: "non-posix-shell",
		});
		expect(resolveTarget(exec, { cmd: "git status", shell: "" }, "/repo")).toMatchObject({ kind: "target" });
	});

	it("resolves the working directory field against the session cwd", () => {
		expect(resolveTarget(exec, { cmd: "ls", workdir: "packages" }, "/repo")).toMatchObject({ cwd: "/repo/packages" });
		expect(resolveTarget(exec, { cmd: "ls", workdir: "/tmp" }, "/repo")).toMatchObject({ cwd: "/tmp" });
		expect(resolveTarget(exec, { cmd: "ls", workdir: 7 }, "/repo")).toMatchObject({ cwd: "/repo" });
	});
});
