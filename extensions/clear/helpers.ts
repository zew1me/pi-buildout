export type ContextFile = { path: string; content: string };
export type SkillDisclosure = { name: string; description: string; filePath: string };

export function buildFreshContextDisclosure({
	contextFiles,
	skills,
	selectedTools,
}: {
	contextFiles: ContextFile[];
	skills: SkillDisclosure[];
	selectedTools: string[];
}): string {
	const instructionFiles = contextFiles.length
		? contextFiles
				.map((file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`)
				.join("\n\n")
		: "- (none found in the current working directory)";
	const skillList = skills.length
		? skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.filePath})`).join("\n")
		: "- (none active)";
	const toolList = selectedTools.length
		? selectedTools.map((tool) => `- ${tool}`).join("\n")
		: "- (none active; no MCP tools are configured)";

	return `# Fresh Context

Previous conversation context was discarded. The following resources were reloaded for this new session.

## Current-directory instructions

${instructionFiles}

## Active skills

${skillList}

## Active tools (including configured MCP tools)

${toolList}`;
}
