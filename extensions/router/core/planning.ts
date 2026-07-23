import { Type } from "typebox";
import { Check, Errors } from "typebox/value";

const NonEmptyString = Type.String({ minLength: 1, maxLength: 2_000 });
const ShortString = Type.String({ minLength: 1, maxLength: 300 });

export const ProgramPlanSchema = Type.Object(
  {
    objective: NonEmptyString,
    assumptions: Type.Array(NonEmptyString, { maxItems: 100 }),
    unknowns: Type.Array(NonEmptyString, { maxItems: 100 }),
    pullRequests: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$" }),
          title: ShortString,
          goal: NonEmptyString,
          dependsOn: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 100 }),
          acceptanceCriteria: Type.Array(NonEmptyString, { minItems: 1, maxItems: 100 }),
          rollout: NonEmptyString,
          rollback: NonEmptyString,
          risks: Type.Array(NonEmptyString, { maxItems: 100 }),
          unknowns: Type.Array(NonEmptyString, { maxItems: 100 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);

export type ProgramPlanValidation = {
  success: boolean;
  errors: string[];
  topologicalOrder: string[];
};

function schemaErrors(value: unknown): string[] {
  return [...Errors(ProgramPlanSchema, value)].map((error) => `${error.instancePath || "/"}: ${error.message}`);
}

export function validateProgramPlan(value: unknown): ProgramPlanValidation {
  if (!Check(ProgramPlanSchema, value)) return { success: false, errors: schemaErrors(value), topologicalOrder: [] };
  const plan = value;
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const pr of plan.pullRequests) {
    if (ids.has(pr.id)) errors.push(`duplicate pull request id: ${pr.id}`);
    ids.add(pr.id);
  }
  for (const pr of plan.pullRequests) {
    const dependencies = new Set<string>();
    for (const dependency of pr.dependsOn) {
      if (dependencies.has(dependency)) errors.push(`${pr.id} repeats dependency ${dependency}`);
      dependencies.add(dependency);
      if (dependency === pr.id) errors.push(`${pr.id} depends on itself`);
      else if (!ids.has(dependency)) errors.push(`${pr.id} depends on unknown pull request ${dependency}`);
    }
  }
  if (errors.length > 0) return { success: false, errors, topologicalOrder: [] };

  const byId = new Map(plan.pullRequests.map((pr) => [pr.id, pr]));
  const temporary = new Set<string>();
  const permanent = new Set<string>();
  const order: string[] = [];
  function visit(id: string, path: string[]): void {
    if (permanent.has(id)) return;
    if (temporary.has(id)) {
      const cycleStart = path.indexOf(id);
      errors.push(`dependency cycle: ${[...path.slice(Math.max(0, cycleStart)), id].join(" -> ")}`);
      return;
    }
    temporary.add(id);
    const pr = byId.get(id);
    for (const dependency of pr?.dependsOn ?? []) visit(dependency, [...path, id]);
    temporary.delete(id);
    permanent.add(id);
    order.push(id);
  }
  for (const pr of plan.pullRequests) visit(pr.id, []);
  return { success: errors.length === 0, errors, topologicalOrder: errors.length === 0 ? order : [] };
}
