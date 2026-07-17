import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { AgentDefinition } from "../task/types";

export type CapabilityCeiling = {
	readonly toolNames: readonly string[];
	readonly hostToolNames: readonly string[];
	readonly spawn:
		| "deny"
		| {
				readonly agentNames: readonly string[];
				readonly maxDepth: number;
				readonly detached: boolean;
		  };
};

export type EmbeddedRuntimeOptions = {
	readonly streamFn: StreamFn;
	readonly capabilityCeiling: CapabilityCeiling;
	/** Explicit host-owned task-agent definitions. Missing means no agents. */
	readonly agentDefinitions?: readonly AgentDefinition[];
	/**
	 * Host-owned custom tools carried down the in-process session tree so
	 * TaskTool children inherit the parent's brokered capabilities. Always
	 * filtered to the (derived) capability ceiling's hostToolNames.
	 */
	readonly hostTools?: readonly CustomTool[];
	readonly mode: "deterministic";
};

function normalizeNames(names: readonly string[], field: string): readonly string[] {
	if (!Array.isArray(names) || names.some(name => typeof name !== "string")) {
		throw new TypeError(`Embedded runtime capability ceiling ${field} must be an array of strings`);
	}
	return Object.freeze([...new Set(names.map(name => name.trim()).filter(name => name.length > 0))].sort());
}

export function normalizeCapabilityCeiling(ceiling: CapabilityCeiling): CapabilityCeiling {
	if (typeof ceiling !== "object" || ceiling === null || Array.isArray(ceiling)) {
		throw new TypeError("Embedded runtime capability ceiling must be an object");
	}
	const spawn = ceiling.spawn;
	if (spawn !== "deny") {
		if (typeof spawn !== "object" || spawn === null || Array.isArray(spawn)) {
			throw new TypeError('Embedded runtime capability ceiling spawn must be "deny" or an object');
		}
		if (!Number.isFinite(spawn.maxDepth) || !Number.isInteger(spawn.maxDepth) || spawn.maxDepth < 0) {
			throw new RangeError("Embedded runtime capability ceiling maxDepth must be a finite nonnegative integer");
		}
		if (typeof spawn.detached !== "boolean") {
			throw new TypeError("Embedded runtime capability ceiling detached must be a boolean");
		}
	}

	const normalized = Object.freeze({
		toolNames: normalizeNames(ceiling.toolNames, "toolNames"),
		hostToolNames: normalizeNames(ceiling.hostToolNames, "hostToolNames"),
		spawn:
			spawn === "deny"
				? "deny"
				: Object.freeze({
						agentNames: normalizeNames(spawn.agentNames, "spawn.agentNames"),
						maxDepth: spawn.maxDepth === 0 ? 0 : spawn.maxDepth,
						detached: spawn.detached,
					}),
	});
	return normalized;
}

export function normalizeEmbeddedRuntime(runtime: EmbeddedRuntimeOptions): EmbeddedRuntimeOptions {
	if (runtime.mode !== "deterministic") {
		throw new TypeError('Embedded runtime mode must be "deterministic"');
	}
	if (typeof runtime.streamFn !== "function") {
		throw new TypeError("Embedded runtime streamFn must be a function");
	}

	const capabilityCeiling = normalizeCapabilityCeiling(runtime.capabilityCeiling);
	const allowedAgentNames =
		capabilityCeiling.spawn === "deny" ? undefined : new Set(capabilityCeiling.spawn.agentNames);
	const agentDefinitions = Object.freeze(
		(runtime.agentDefinitions ?? [])
			.filter(agent => allowedAgentNames?.has(agent.name) === true)
			.map(agent => {
				const normalized: AgentDefinition = {
					...agent,
					tools: agent.tools ? [...agent.tools] : undefined,
					spawns: Array.isArray(agent.spawns) ? [...agent.spawns] : agent.spawns,
					model: agent.model ? [...agent.model] : undefined,
					autoloadSkills: agent.autoloadSkills ? [...agent.autoloadSkills] : undefined,
				};
				if (normalized.tools) Object.freeze(normalized.tools);
				if (Array.isArray(normalized.spawns)) Object.freeze(normalized.spawns);
				if (normalized.model) Object.freeze(normalized.model);
				if (normalized.autoloadSkills) Object.freeze(normalized.autoloadSkills);
				return Object.freeze(normalized);
			}),
	);
	const allowedHostToolNames = new Set(capabilityCeiling.hostToolNames);
	const hostTools = Object.freeze((runtime.hostTools ?? []).filter(tool => allowedHostToolNames.has(tool.name)));
	return Object.freeze({
		streamFn: runtime.streamFn,
		capabilityCeiling,
		agentDefinitions,
		hostTools,
		mode: "deterministic",
	});
}
