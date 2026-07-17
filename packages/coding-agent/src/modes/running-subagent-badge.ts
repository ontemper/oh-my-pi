import type { AgentRegistry } from "../registry/agent-registry";

export interface RunningSubagentRegistrySource {
	agentRegistry: AgentRegistry;
}

export function getRunningSubagentBadgeRegistry(
	collabGuest: RunningSubagentRegistrySource | undefined,
	localRegistry: AgentRegistry,
): AgentRegistry {
	return collabGuest?.agentRegistry ?? localRegistry;
}

export function countRunningSubagentBadgeAgents(registry: AgentRegistry): number {
	return registry.list().filter(ref => ref.kind === "sub" && ref.status === "running").length;
}
