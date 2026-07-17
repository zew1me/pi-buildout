import type { TaskFeatures } from "./features.ts";

export const ARCHETYPES = [
	"fast_classification",
	"exact_extraction",
	"deliberate_tool_workflow",
	"median_repository_implementation",
	"terminal_heavy_implementation",
	"algorithmic_iterative_coding",
	"code_review",
	"implementation_planning",
	"large_program_planning",
	"long_context_synthesis",
	"highest_risk_advisory",
] as const;

export type Archetype = (typeof ARCHETYPES)[number];

export interface ArchetypeDecision {
	archetype: Archetype;
	reasons: string[];
	requiresIndependentReview: boolean;
}

export function deriveArchetype(features: TaskFeatures): ArchetypeDecision {
	const reasons: string[] = [];
	let archetype: Archetype;

	if (features.workflowType === "code_review" || features.intent === "review" || features.reviewIntent) {
		archetype = "code_review";
		reasons.push("explicit or inferred review intent");
	} else if (features.risk === "critical" || (features.risk === "high" && features.ambiguity === "high")) {
		archetype = "highest_risk_advisory";
		reasons.push(`${features.risk} risk with ${features.ambiguity} ambiguity`);
	} else if (
		features.workflowType === "implementation_planning" ||
		features.intent === "plan" ||
		features.horizon === "two_to_ten_prs" ||
		features.horizon === "eleven_to_hundred_prs" ||
		features.horizon === "program_unknown_size"
	) {
		if (features.horizon === "eleven_to_hundred_prs" || features.horizon === "program_unknown_size") {
			archetype = "large_program_planning";
			reasons.push(`planning horizon is ${features.horizon}`);
		} else {
			archetype = "implementation_planning";
			reasons.push(`planning workflow with ${features.horizon} horizon`);
		}
	} else if (features.outputRigidity === "exact_schema" || features.intent === "transform") {
		archetype = "exact_extraction";
		reasons.push(`output rigidity is ${features.outputRigidity}`);
	} else if (
		features.contextShape === "large_documents" ||
		features.contextShape === "long_repository" ||
		features.expectedToolOutputTokens >= 50_000
	) {
		archetype = "long_context_synthesis";
		reasons.push(`context shape is ${features.contextShape}`);
	} else if (features.workflowType === "noncoding_tool_workflow" || features.intent === "operate") {
		archetype = "deliberate_tool_workflow";
		reasons.push("non-coding procedural workflow");
	} else if (
		features.workflowType === "incident_or_operations" ||
		features.toolDependence === "terminal_heavy" ||
		features.intent === "diagnose"
	) {
		archetype = "terminal_heavy_implementation";
		reasons.push(`tool dependence is ${features.toolDependence}`);
	} else if (
		features.workflowType === "coding_implementation" ||
		features.intent === "implement" ||
		features.horizon === "single_pr"
	) {
		if (
			features.contextShape === "single_file" &&
			features.expectedFilesChanged <= 2 &&
			features.expectedAgentTurns <= 4
		) {
			archetype = "algorithmic_iterative_coding";
			reasons.push("small isolated implementation with short iteration horizon");
		} else {
			archetype = "median_repository_implementation";
			reasons.push("repository implementation route");
		}
	} else {
		archetype = "fast_classification";
		reasons.push("bounded information-only task");
	}

	const requiresIndependentReview =
		archetype === "code_review" ||
		((features.risk === "high" || features.risk === "critical") && features.actionMode !== "information_only");
	if (requiresIndependentReview) reasons.push("independent review required by risk/review policy");

	return { archetype, reasons, requiresIndependentReview };
}
