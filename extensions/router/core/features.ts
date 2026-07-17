import { type Static, type TUnsafe, Type } from "typebox";
import { Check, Errors } from "typebox/value";

function stringEnum<const TValues extends readonly string[]>(values: TValues): TUnsafe<TValues[number]> {
	return Type.Unsafe<TValues[number]>({ type: "string", enum: [...values] });
}

export const INTENTS = [
	"answer",
	"research",
	"plan",
	"implement",
	"review",
	"diagnose",
	"operate",
	"summarize",
	"transform",
	"continue",
] as const;
export const WORKFLOW_TYPES = [
	"coding_implementation",
	"implementation_planning",
	"code_review",
	"noncoding_tool_workflow",
	"research_or_analysis",
	"incident_or_operations",
] as const;
export const ACTION_MODES = [
	"information_only",
	"local_read",
	"reversible_mutation",
	"external_side_effect",
	"destructive",
] as const;
export const INSTRUCTION_STYLES = ["literal", "outcome_first", "exploratory", "procedural"] as const;
export const HORIZONS = [
	"one_response",
	"single_pr",
	"two_to_ten_prs",
	"eleven_to_hundred_prs",
	"program_unknown_size",
] as const;
export const TOOL_DEPENDENCIES = ["none", "light", "repository_agent", "terminal_heavy", "external_services"] as const;
export const CONTEXT_SHAPES = [
	"short",
	"conversation",
	"large_documents",
	"single_file",
	"multi_file_repository",
	"long_repository",
] as const;
export const OUTPUT_RIGIDITIES = ["freeform", "structured", "exact_schema", "patch_and_receipt"] as const;
export const INDEPENDENCE_REQUIREMENTS = ["none", "different_vendor_review"] as const;
export const CONTINUITY_CLASSES = [
	"clear_continuation",
	"possible_continuation",
	"new_task",
	"strong_discontinuity",
] as const;
export const RISKS = ["low", "medium", "high", "critical"] as const;
export const AMBIGUITIES = ["low", "medium", "high"] as const;
export const INTERACTIVITY_TYPES = ["single_response", "developer_loop", "autonomous", "human_checkpointed"] as const;
export const VERIFICATION_STRENGTHS = [
	"none",
	"self_check",
	"unit_tests",
	"integration_tests",
	"security_and_policy",
] as const;

export const TaskFeaturesSchema = Type.Object(
	{
		intent: stringEnum(INTENTS),
		workflowType: stringEnum(WORKFLOW_TYPES),
		actionMode: stringEnum(ACTION_MODES),
		instructionStyle: stringEnum(INSTRUCTION_STYLES),
		literalAdherenceRequired: Type.Boolean(),
		horizon: stringEnum(HORIZONS),
		toolDependence: stringEnum(TOOL_DEPENDENCIES),
		contextShape: stringEnum(CONTEXT_SHAPES),
		outputRigidity: stringEnum(OUTPUT_RIGIDITIES),
		independenceRequirement: stringEnum(INDEPENDENCE_REQUIREMENTS),
		taskContinuity: stringEnum(CONTINUITY_CLASSES),
		cacheValue: Type.Object(
			{
				cachedTokens: Type.Integer({ minimum: 0, maximum: 2_000_000 }),
				expectedReuseRatio: Type.Number({ minimum: 0, maximum: 1 }),
			},
			{ additionalProperties: false },
		),
		risk: stringEnum(RISKS),
		ambiguity: stringEnum(AMBIGUITIES),
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
		reviewIntent: Type.Boolean(),
		interactivity: stringEnum(INTERACTIVITY_TYPES),
		expectedAgentTurns: Type.Integer({ minimum: 1, maximum: 200 }),
		expectedFilesRead: Type.Integer({ minimum: 0, maximum: 10_000 }),
		expectedFilesChanged: Type.Integer({ minimum: 0, maximum: 10_000 }),
		expectedToolOutputTokens: Type.Integer({ minimum: 0, maximum: 2_000_000 }),
		verificationStrength: stringEnum(VERIFICATION_STRENGTHS),
		decompositionRecommended: Type.Boolean(),
		evidence: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), {
			minItems: 1,
			maxItems: 8,
		}),
	},
	{ additionalProperties: false },
);

export type TaskFeatures = Static<typeof TaskFeaturesSchema>;
export type Intent = (typeof INTENTS)[number];
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];
export type ActionMode = (typeof ACTION_MODES)[number];
export type Horizon = (typeof HORIZONS)[number];
export type Risk = (typeof RISKS)[number];
export type ContinuityClass = (typeof CONTINUITY_CLASSES)[number];

export interface ValidationResult<T> {
	success: boolean;
	value?: T;
	errors: string[];
}

export function validateTaskFeatures(value: unknown): ValidationResult<TaskFeatures> {
	if (Check(TaskFeaturesSchema, value)) return { success: true, value: value as TaskFeatures, errors: [] };
	return {
		success: false,
		errors: [...Errors(TaskFeaturesSchema, value)]
			.slice(0, 12)
			.map((error) => `${error.instancePath || "/"}: ${error.message}`),
	};
}

export function conservativeFeatures(evidence = "Classifier output was unavailable or invalid"): TaskFeatures {
	return {
		intent: "diagnose",
		workflowType: "research_or_analysis",
		actionMode: "information_only",
		instructionStyle: "literal",
		literalAdherenceRequired: true,
		horizon: "program_unknown_size",
		toolDependence: "repository_agent",
		contextShape: "long_repository",
		outputRigidity: "structured",
		independenceRequirement: "different_vendor_review",
		taskContinuity: "new_task",
		cacheValue: { cachedTokens: 0, expectedReuseRatio: 0 },
		risk: "high",
		ambiguity: "high",
		confidence: 0,
		reviewIntent: false,
		interactivity: "human_checkpointed",
		expectedAgentTurns: 20,
		expectedFilesRead: 50,
		expectedFilesChanged: 0,
		expectedToolOutputTokens: 50_000,
		verificationStrength: "security_and_policy",
		decompositionRecommended: true,
		evidence: [evidence.slice(0, 240)],
	};
}
