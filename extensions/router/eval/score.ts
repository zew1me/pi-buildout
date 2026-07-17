import type { TaskFeatures } from "../core/features.ts";

export interface ExpectedFeatureAxes {
	intent?: TaskFeatures["intent"];
	workflowType?: TaskFeatures["workflowType"];
	actionMode?: TaskFeatures["actionMode"];
	horizon?: TaskFeatures["horizon"];
	risk?: TaskFeatures["risk"];
	reviewIntent?: boolean;
}

export interface FeatureScore {
	correct: number;
	total: number;
	accuracy: number;
	mismatches: string[];
}

export function scoreFeatureAxes(actual: TaskFeatures, expected: ExpectedFeatureAxes): FeatureScore {
	const mismatches: string[] = [];
	let correct = 0;
	const pairs = Object.entries(expected) as [keyof ExpectedFeatureAxes, unknown][];
	for (const [axis, expectedValue] of pairs) {
		if (actual[axis] === expectedValue) correct++;
		else mismatches.push(`${axis}: expected ${String(expectedValue)}, received ${String(actual[axis])}`);
	}
	return { correct, total: pairs.length, accuracy: pairs.length > 0 ? correct / pairs.length : 1, mismatches };
}

export function calibrationError(results: readonly { confidence: number; correct: boolean }[]): number {
	if (results.length === 0) return 0;
	return (
		results.reduce((total, result) => total + Math.abs(result.confidence - (result.correct ? 1 : 0)), 0) /
		results.length
	);
}
