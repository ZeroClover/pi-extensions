import { describe, expect, it } from "vitest";
import type { Clock } from "../src/clock.ts";
import { formatSnapshot, plainText } from "../src/format.ts";
import { Measurement } from "../src/measurement.ts";
import { StatusWriter } from "../src/render.ts";
import { type ScheduleInterval, Ticker } from "../src/ticker.ts";

/** A clock and interval scheduler advanced by hand. */
class FakeTime implements Clock {
	t = 0;
	private timers: { callback: () => void; intervalMs: number; next: number }[] = [];

	now(): number {
		return this.t;
	}

	readonly schedule: ScheduleInterval = (callback, intervalMs) => {
		const timer = { callback, intervalMs, next: this.t + intervalMs };
		this.timers.push(timer);
		return () => {
			this.timers = this.timers.filter((other) => other !== timer);
		};
	};

	get pending(): number {
		return this.timers.length;
	}

	advanceTo(target: number): void {
		for (;;) {
			const due = this.timers.filter((timer) => timer.next <= target).sort((a, b) => a.next - b.next)[0];
			if (!due) break;
			this.t = due.next;
			due.next += due.intervalMs;
			due.callback();
		}
		this.t = target;
	}
}

const FRAMES = ["⠋", "⠙", "⠹"];

function setup(animated: boolean) {
	const time = new FakeTime();
	const meter = new Measurement(time, () => ({ add: (_stream, delta) => delta.length }));
	const written: (string | undefined)[] = [];
	const writer = new StatusWriter();
	const write = (text: string | undefined) => written.push(text);
	const ticker = new Ticker(time.schedule, 100, (frame) => {
		const snapshot = meter.snapshot();
		if (!snapshot) return;
		const indicator = animated ? (FRAMES[frame % FRAMES.length] ?? "") : (FRAMES[0] ?? "");
		writer.set(plainText(formatSnapshot(snapshot, "text", indicator), "text"), write);
	});
	return { time, meter, written, ticker };
}

describe("Ticker", () => {
	it("renders about once per interval regardless of the delta rate", () => {
		const { time, meter, written, ticker } = setup(true);
		meter.turnStart();
		meter.requestStart({ provider: "p", model: "m", wallTime: 0 });
		ticker.start();
		for (let i = 1; i <= 500; i++) {
			time.advanceTo(i * 2);
			meter.delta("text", "x");
		}
		expect(written).toHaveLength(10);
	});

	it("renders only on value changes when animation is disabled", () => {
		const { time, meter, written, ticker } = setup(false);
		meter.turnStart();
		meter.requestStart({ provider: "p", model: "m", wallTime: 0 });
		meter.messageStart();
		time.advanceTo(50);
		meter.delta("text", "x");
		ticker.start();
		// TTFT is locked, live TPS is in warm-up and the token count does not change: nothing to redraw.
		time.advanceTo(1000);
		expect(written).toHaveLength(1);
		meter.delta("text", "xx");
		time.advanceTo(1100);
		expect(written).toHaveLength(2);
	});

	it("runs no timer while idle and stops cleanly", () => {
		const { time, ticker } = setup(true);
		expect(ticker.running).toBe(false);
		expect(time.pending).toBe(0);
		ticker.start();
		ticker.start();
		expect(time.pending).toBe(1);
		ticker.stop();
		ticker.stop();
		expect(ticker.running).toBe(false);
		expect(time.pending).toBe(0);
	});
});
