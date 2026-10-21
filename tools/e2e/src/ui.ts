import {
	type ExtensionUIContext,
	type TerminalInputHandler,
	Theme,
	type ThemeBg,
	type ThemeColor,
	type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

export type NoticeLevel = "info" | "warning" | "error";

export type WorkingCall =
	| { kind: "message"; message: string | undefined }
	| { kind: "visible"; visible: boolean }
	| { kind: "indicator"; options: WorkingIndicatorOptions | undefined };

export interface Notice {
	level: NoticeLevel;
	message: string;
}

/** A recording `ExtensionUIContext`, plus what the test reads back and the input it feeds in. */
export interface RecordingUI {
	/** Bound into the session; every member is an own property because Pi spreads the context. */
	readonly context: ExtensionUIContext;
	/** Every `notify` call in order. */
	readonly notices: Notice[];
	/** Every text written with `setStatus(key, …)`, `undefined` for a clear. */
	status(key: string): (string | undefined)[];
	/** The last text written under `key`, or undefined when it was never set or was cleared. */
	currentStatus(key: string): string | undefined;
	/** Every working-indicator call in order: `setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`. */
	readonly working: WorkingCall[];
	/** Every `setWidget` call with string lines, by key. */
	widget(key: string): (string[] | undefined)[];
	/** Feeds raw terminal input to the `onTerminalInput` handlers, as a key press in the TUI would. */
	press(data: string): void;
	/** Queues the answer of the next dialog (`select`, `confirm`, `input`, `editor`); dialogs default to no answer. */
	answer(value: string | boolean | undefined): void;
}

/** Distinct concrete colours, so that a test can tell tokens apart when colour is the behavior under test. */
function color(index: number): string {
	return `#${(0x102030 + index * 0x050301).toString(16).padStart(6, "0").slice(-6)}`;
}

const FG: Record<ThemeColor, string> = {
	accent: color(1),
	border: color(2),
	borderAccent: color(3),
	borderMuted: color(4),
	success: color(5),
	error: color(6),
	warning: color(7),
	muted: color(8),
	dim: color(9),
	text: color(10),
	thinkingText: color(11),
	scrollbarTrack: color(12),
	scrollbarThumb: color(13),
	searchMatchText: color(14),
	userMessageText: color(15),
	customMessageText: color(16),
	customMessageLabel: color(17),
	toolTitle: color(18),
	toolOutput: color(19),
	mdHeading: color(20),
	mdLink: color(21),
	mdLinkUrl: color(22),
	mdCode: color(23),
	mdCodeBlock: color(24),
	mdCodeBlockBorder: color(25),
	mdQuote: color(26),
	mdQuoteBorder: color(27),
	mdHr: color(28),
	mdListBullet: color(29),
	toolDiffAdded: color(30),
	toolDiffRemoved: color(31),
	toolDiffContext: color(32),
	syntaxComment: color(33),
	syntaxKeyword: color(34),
	syntaxFunction: color(35),
	syntaxVariable: color(36),
	syntaxString: color(37),
	syntaxNumber: color(38),
	syntaxType: color(39),
	syntaxOperator: color(40),
	syntaxPunctuation: color(41),
	thinkingOff: color(42),
	thinkingMinimal: color(43),
	thinkingLow: color(44),
	thinkingMedium: color(45),
	thinkingHigh: color(46),
	thinkingXhigh: color(47),
	thinkingMax: color(48),
	bashMode: color(49),
};

const BG: Record<ThemeBg, string> = {
	selectedBg: color(50),
	searchMatchBg: color(51),
	userMessageBg: color(52),
	customMessageBg: color(53),
	toolPendingBg: color(54),
	toolSuccessBg: color(55),
	toolErrorBg: color(56),
};

/** A concrete theme: `ctx.ui.theme` must be a real `Theme`, and Pi exports only its constructor. */
export function testTheme(): Theme {
	return new Theme(FG, BG, "truecolor", { name: "e2e" });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with the ESC control character.
const ANSI = /\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** The text as a terminal shows it, without colour and style codes. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

/** Lines written under `key`, without ANSI codes and without clears. */
export function plainStatus(ui: RecordingUI, key: string): string[] {
	return ui.status(key).flatMap((text) => (text === undefined ? [] : [stripAnsi(text)]));
}

export function createRecordingUI(): RecordingUI {
	const notices: Notice[] = [];
	const working: WorkingCall[] = [];
	const statuses = new Map<string, (string | undefined)[]>();
	const widgets = new Map<string, (string[] | undefined)[]>();
	const inputHandlers = new Set<TerminalInputHandler>();
	const answers: (string | boolean | undefined)[] = [];
	let theme = testTheme();
	let editorText = "";
	let toolsExpanded = false;

	const nextAnswer = (): string | boolean | undefined => answers.shift();
	const textAnswer = async (): Promise<string | undefined> => {
		const value = nextAnswer();
		return typeof value === "string" ? value : undefined;
	};

	const context: ExtensionUIContext = {
		select: textAnswer,
		confirm: async () => nextAnswer() === true,
		input: textAnswer,
		editor: textAnswer,
		notify: (message, type = "info") => {
			notices.push({ level: type, message });
		},
		onTerminalInput: (handler) => {
			inputHandlers.add(handler);
			return () => {
				inputHandlers.delete(handler);
			};
		},
		setStatus: (key, text) => {
			const history = statuses.get(key) ?? [];
			history.push(text);
			statuses.set(key, history);
		},
		setWorkingMessage: (message) => {
			working.push({ kind: "message", message });
		},
		setWorkingVisible: (visible) => {
			working.push({ kind: "visible", visible });
		},
		setWorkingIndicator: (options) => {
			working.push({ kind: "indicator", options });
		},
		setHiddenThinkingLabel: () => {},
		setWidget: (key: string, content: unknown) => {
			const history = widgets.get(key) ?? [];
			history.push(Array.isArray(content) ? content.map(String) : undefined);
			widgets.set(key, history);
		},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => {
			throw new Error("the recording UI shows no custom components");
		},
		pasteToEditor: (text) => {
			editorText += text;
		},
		setEditorText: (text) => {
			editorText = text;
		},
		getEditorText: () => editorText,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme,
		getAllThemes: () => [{ name: "e2e", path: undefined }],
		getTheme: (name) => (name === "e2e" ? theme : undefined),
		setTheme: (next) => {
			if (typeof next === "string") return next === "e2e" ? { success: true } : { success: false, error: "unknown" };
			theme = next;
			return { success: true };
		},
		getToolsExpanded: () => toolsExpanded,
		setToolsExpanded: (expanded) => {
			toolsExpanded = expanded;
		},
	};

	return {
		context,
		notices,
		working,
		status: (key) => [...(statuses.get(key) ?? [])],
		currentStatus: (key) => statuses.get(key)?.at(-1),
		widget: (key) => [...(widgets.get(key) ?? [])],
		press: (data) => {
			for (const handler of [...inputHandlers]) handler(data);
		},
		answer: (value) => {
			answers.push(value);
		},
	};
}
