import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Archetype } from "./core/archetype.ts";
import type { RouteSample } from "./core/routing.ts";

export type TelemetryEventKind =
	| "boundary"
	| "classifier_attempt"
	| "route_decision"
	| "attempt_completed"
	| "fallback"
	| "outcome";

export interface RouterTelemetryEvent {
	version: 1;
	eventId: string;
	timestamp: string;
	kind: TelemetryEventKind;
	sessionId: string;
	taskId?: string;
	routeKey?: string;
	archetype?: Archetype;
	provider?: string;
	modelId?: string;
	effort?: string;
	promptProfileId?: string;
	policyVersion?: string;
	modelSnapshotId?: string;
	data: Record<string, unknown>;
}

export interface AttemptOutcome {
	provider: string;
	modelId: string;
	archetype: Archetype;
	accepted: boolean;
	modelAndToolCost: number;
	wallTimeMs: number;
	humanIntervention: boolean;
	retried: boolean;
}

export class JsonlTelemetryStore {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	async append(event: RouterTelemetryEvent): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await appendFile(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
	}

	async read(limit = 10_000): Promise<RouterTelemetryEvent[]> {
		let content: string;
		try {
			content = await readFile(this.path, "utf8");
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
			throw error;
		}
		const lines = content.trim().split("\n").filter(Boolean).slice(-Math.max(0, limit));
		const events: RouterTelemetryEvent[] = [];
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as RouterTelemetryEvent;
				if (parsed.version === 1 && typeof parsed.kind === "string" && parsed.data) events.push(parsed);
			} catch {
				// Ignore a torn final append while retaining every complete event before it.
			}
		}
		return events;
	}
}

export function percentile(values: readonly number[], quantile: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
	return sorted[index] ?? 0;
}

export function aggregateRouteSamples(outcomes: readonly AttemptOutcome[]): RouteSample[] {
	const groups = new Map<string, AttemptOutcome[]>();
	for (const outcome of outcomes) {
		const key = `${outcome.provider}/${outcome.modelId}/${outcome.archetype}`;
		groups.set(key, [...(groups.get(key) ?? []), outcome]);
	}
	return [...groups.values()].map((samples) => {
		const first = samples[0];
		if (!first) throw new Error("route sample group unexpectedly empty");
		const ratio = (predicate: (sample: AttemptOutcome) => boolean) =>
			samples.filter(predicate).length / Math.max(1, samples.length);
		return {
			provider: first.provider,
			modelId: first.modelId,
			archetype: first.archetype,
			comparableSamples: samples.length,
			acceptedRate: ratio((sample) => sample.accepted),
			p75ModelAndToolCost: percentile(
				samples.map((sample) => sample.modelAndToolCost),
				0.75,
			),
			p75WallTimeMs: percentile(
				samples.map((sample) => sample.wallTimeMs),
				0.75,
			),
			probabilityHumanIntervention: ratio((sample) => sample.humanIntervention),
			probabilityRetry: ratio((sample) => sample.retried),
		};
	});
}

interface SpanContextLike {
	traceId: string;
	spanId: string;
	traceFlags?: number;
	isRemote?: boolean;
}

interface SpanLike {
	setAttribute(name: string, value: string | number | boolean): SpanLike;
	addEvent(name: string, attributes?: Record<string, string | number | boolean>): SpanLike;
	recordException(error: unknown): void;
	setStatus(status: { code: number; message?: string }): SpanLike;
	end(): void;
}

interface TracerLike {
	startSpan(
		name: string,
		options?: { attributes?: Record<string, string | number | boolean> },
		context?: unknown,
	): SpanLike;
}

interface RuntimeRegistryValue {
	tracer: TracerLike;
}

const RUNTIME_REGISTRY = Symbol.for("pi.telemetry-otel.runtimeRegistry.v1");
const ACTIVE_CONTEXT_REGISTRY = Symbol.for("pi.telemetry-otel.activeSpanContextRegistry.v1");
const OTEL_API = Symbol.for("opentelemetry.js.api.1");
const OTEL_SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");

function symbolMap<T>(symbol: symbol): Map<string, T> | undefined {
	const globals = globalThis as unknown as Record<symbol, unknown>;
	const value = globals[symbol];
	return value instanceof Map ? (value as Map<string, T>) : undefined;
}

function parentContext(sessionId: string): unknown {
	const activeSpanContext = symbolMap<SpanContextLike>(ACTIVE_CONTEXT_REGISTRY)?.get(sessionId);
	if (!activeSpanContext) return undefined;
	const globals = globalThis as unknown as Record<symbol, unknown>;
	const api = globals[OTEL_API] as
		| { context?: { active?: () => { setValue?: (key: symbol, value: unknown) => unknown } } }
		| undefined;
	const active = api?.context?.active?.();
	if (!active?.setValue) return undefined;
	const nonRecordingSpan = {
		spanContext: () => activeSpanContext,
		setAttribute() {
			return this;
		},
		setAttributes() {
			return this;
		},
		addEvent() {
			return this;
		},
		addLink() {
			return this;
		},
		addLinks() {
			return this;
		},
		setStatus() {
			return this;
		},
		updateName() {
			return this;
		},
		end() {},
		isRecording: () => false,
		recordException() {},
	};
	return active.setValue(OTEL_SPAN_KEY, nonRecordingSpan);
}

export async function withRouterSpan<T>(
	sessionId: string,
	name: string,
	attributes: Record<string, string | number | boolean>,
	operation: (span: SpanLike | undefined) => Promise<T> | T,
): Promise<T> {
	const runtime = symbolMap<RuntimeRegistryValue>(RUNTIME_REGISTRY)?.get(sessionId);
	const span = runtime?.tracer.startSpan(name, { attributes }, parentContext(sessionId));
	try {
		return await operation(span);
	} catch (error) {
		span?.recordException(error);
		span?.setStatus({ code: 2, message: error instanceof Error ? error.message : String(error) });
		throw error;
	} finally {
		span?.end();
	}
}
