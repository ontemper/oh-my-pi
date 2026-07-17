import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { Type } from "@oh-my-pi/pi-coding-agent/extensibility/typebox";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	type CapabilityCeiling,
	type EmbeddedRuntimeOptions,
	normalizeCapabilityCeiling,
} from "@oh-my-pi/pi-coding-agent/runtime/embedded-runtime";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose test agent",
	systemPrompt: "Complete the task.",
	source: "bundled",
};

function customTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `Host tool ${name}`,
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}
function hasExplicitSystemPrompt(value: CreateAgentSessionOptions["systemPrompt"]): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	return Array.isArray(value) && value.length > 0 && value.every(block => block.trim().length > 0);
}

function makeRuntime(
	streamFn: EmbeddedRuntimeOptions["streamFn"],
	capabilityCeiling: CapabilityCeiling,
): EmbeddedRuntimeOptions {
	return Object.freeze({
		mode: "deterministic",
		streamFn,
		capabilityCeiling: normalizeCapabilityCeiling(capabilityCeiling),
	});
}

function createYieldingSession(toolNames: string[] = ["read", "yield"]): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const sessionManager = SessionManager.inMemory("/tmp");
	return {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager,
		getActiveToolNames: () => toolNames,
		getEnabledToolNames: () => toolNames,
		getMountedXdevToolNames: () => [],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "capability-yield",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {
			await sessionManager.close();
		},
	} as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {
			extensions: [],
			errors: [],
			runtime: {} as unknown,
		} as CreateAgentSessionResult["extensionsResult"],
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

function makeResult(id: string, agent = "task"): SingleResult {
	return {
		index: 0,
		id,
		agent,
		agentSource: "bundled",
		task: "do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function executorOptions(
	settings: Settings,
	agent: AgentDefinition,
	overrides: Partial<executorModule.ExecutorOptions> = {},
) {
	return {
		cwd: "/tmp",
		agent,
		task: "do work",
		index: 0,
		id: `${agent.name}-child`,
		settings,
		modelRegistry: { authStorage: {}, refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
		...overrides,
	} satisfies executorModule.ExecutorOptions;
}

function taskToolSession(settings: Settings): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

describe("embedded capability ceiling", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("filters built-in and host-provided tools through their distinct root allowlists", async () => {
		using tempDir = TempDir.createSync("@omp-capability-root-");
		const cwd = tempDir.path();
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage, `${cwd}/models.yml`);
		const settings = Settings.isolated({ includeWorkspaceTree: false, "secrets.enabled": false });
		const model = createMockModel();
		const requestedBuiltins = ["read", "read"];
		const requestedHostTools = ["host_allowed", "host_allowed"];
		const embeddedRuntime = {
			mode: "deterministic",
			streamFn: model.stream,
			capabilityCeiling: {
				toolNames: requestedBuiltins,
				hostToolNames: requestedHostTools,
				spawn: "deny",
			},
		} satisfies EmbeddedRuntimeOptions;
		try {
			const { session } = await sdkModule.createAgentSession({
				cwd,
				authStorage,
				modelRegistry,
				model,
				settings,
				sessionManager: SessionManager.inMemory(cwd),
				systemPrompt: ["embedded host prompt"],
				embeddedRuntime,
				toolNames: ["read", "write"],
				customTools: [customTool("host_allowed"), customTool("host_denied")],
			});
			try {
				requestedBuiltins.push("write");
				requestedHostTools.push("host_denied");
				expect(session.getEnabledToolNames()).toContain("read");
				expect(session.getEnabledToolNames()).toContain("host_allowed");
				expect(session.getEnabledToolNames()).not.toContain("write");
				expect(session.getEnabledToolNames()).not.toContain("host_denied");
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
		}
	});

	it("fails closed for empty and unknown root tool allowlists", async () => {
		for (const toolNames of [[], ["not_a_real_builtin"]]) {
			using tempDir = TempDir.createSync("@omp-capability-empty-");
			const cwd = tempDir.path();
			const authStorage = await AuthStorage.create(":memory:");
			const modelRegistry = new ModelRegistry(authStorage, `${cwd}/models.yml`);
			const settings = Settings.isolated({ includeWorkspaceTree: false, "secrets.enabled": false });
			const model = createMockModel();
			try {
				const { session } = await sdkModule.createAgentSession({
					cwd,
					authStorage,
					modelRegistry,
					model,
					settings,
					sessionManager: SessionManager.inMemory(cwd),
					systemPrompt: ["embedded host prompt"],
					embeddedRuntime: makeRuntime(model.stream, { toolNames, hostToolNames: [], spawn: "deny" }),
				});
				try {
					expect(session.getEnabledToolNames()).toEqual([]);
				} finally {
					await session.dispose();
				}
			} finally {
				authStorage.close();
			}
		}
	});

	it("intersects capabilities monotonically across parent, child, and grandchild", async () => {
		const stream = createMockModel().stream;
		const parentSettings = Settings.isolated({ "task.maxRecursionDepth": 3 });
		const parentRuntime = makeRuntime(stream, {
			toolNames: ["read", "write", "task", "hub"],
			hostToolNames: ["host_parent"],
			spawn: { agentNames: ["scout", "task"], maxDepth: 3, detached: true },
		});
		const captured: CreateAgentSessionOptions[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			captured.push(options ?? {});
			return createSessionResult(createYieldingSession());
		});

		const childAgent: AgentDefinition = {
			name: "scout",
			description: "child",
			systemPrompt: "child",
			tools: ["read", "write", "bash"],
			spawns: ["task"],
			source: "bundled",
		};
		await executorModule.runSubprocess(
			executorOptions(parentSettings, childAgent, { embeddedRuntime: parentRuntime }),
		);
		const childOptions = captured[0];
		const childRuntime = childOptions?.embeddedRuntime;
		expect(childRuntime?.capabilityCeiling).toEqual({
			toolNames: ["hub", "read", "task", "write"],
			hostToolNames: ["host_parent"],
			spawn: { agentNames: ["task"], maxDepth: 3, detached: true },
		});
		expect(Object.isFrozen(childRuntime)).toBe(true);
		expect(Object.isFrozen(childRuntime?.capabilityCeiling)).toBe(true);
		expect(Object.isFrozen(childRuntime?.capabilityCeiling.toolNames)).toBe(true);
		expect(childRuntime?.streamFn).toBe(stream);
		expect(hasExplicitSystemPrompt(childOptions?.systemPrompt)).toBe(true);
		if (!childOptions?.settings || !childRuntime) throw new Error("Expected child embedded runtime");

		const grandchildAgent: AgentDefinition = {
			name: "task",
			description: "grandchild",
			systemPrompt: "grandchild",
			tools: ["read", "bash"],
			spawns: ["scout", "task"],
			source: "bundled",
		};
		await executorModule.runSubprocess(
			executorOptions(childOptions.settings, grandchildAgent, {
				taskDepth: 1,
				embeddedRuntime: childRuntime,
			}),
		);
		const grandchildRuntime = captured[1]?.embeddedRuntime;
		expect(grandchildRuntime?.capabilityCeiling).toEqual({
			toolNames: ["hub", "read", "task"],
			hostToolNames: ["host_parent"],
			spawn: { agentNames: ["task"], maxDepth: 3, detached: true },
		});
		expect(grandchildRuntime?.streamFn).toBe(stream);
		expect(hasExplicitSystemPrompt(captured[1]?.systemPrompt)).toBe(true);
	});

	it("treats undefined and empty child tool declarations as no authority", async () => {
		const stream = createMockModel().stream;
		const settings = Settings.isolated();
		const embeddedRuntime = makeRuntime(stream, {
			toolNames: ["read", "task"],
			hostToolNames: [],
			spawn: { agentNames: ["task"], maxDepth: 2, detached: false },
		});
		const captured: CreateAgentSessionOptions[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			captured.push(options ?? {});
			return createSessionResult(createYieldingSession());
		});

		const toolDeclarations: Array<AgentDefinition["tools"]> = [undefined, []];
		for (const tools of toolDeclarations) {
			await executorModule.runSubprocess(
				executorOptions(
					settings,
					{
						...taskAgent,
						tools,
					},
					{ embeddedRuntime },
				),
			);
		}

		expect(captured).toHaveLength(2);
		for (const options of captured) {
			expect(options.embeddedRuntime?.capabilityCeiling).toEqual({
				toolNames: [],
				hostToolNames: [],
				spawn: "deny",
			});
		}
	});

	it("rejects disallowed agent, depth, and detached spawns before creating a child session", async () => {
		const stream = createMockModel().stream;
		const settings = Settings.isolated();
		const embeddedRuntime = makeRuntime(stream, {
			toolNames: ["read", "task"],
			hostToolNames: [],
			spawn: { agentNames: ["task"], maxDepth: 2, detached: false },
		});
		const createSpy = vi.spyOn(sdkModule, "createAgentSession");
		const cases = [
			{ agent: { ...taskAgent, name: "scout" }, overrides: {}, error: /does not allow agent/i },
			{ agent: taskAgent, overrides: { taskDepth: 2 }, error: /maximum spawn depth/i },
			{ agent: taskAgent, overrides: { detached: true }, error: /detached/i },
		] satisfies Array<{
			agent: AgentDefinition;
			overrides: Partial<executorModule.ExecutorOptions>;
			error: RegExp;
		}>;

		for (const testCase of cases) {
			const result = await executorModule.runSubprocess(
				executorOptions(settings, testCase.agent, {
					...testCase.overrides,
					embeddedRuntime,
				}),
			);
			expect(result.exitCode).toBe(1);
			expect(result.error).toMatch(testCase.error);
		}
		expect(createSpy).not.toHaveBeenCalled();
	});

	it("revives with the intersection of the persisted ceiling and the host's current ceiling", async () => {
		using tempDir = TempDir.createSync("@omp-capability-revive-");
		const cwd = tempDir.path();
		const persisted = normalizeCapabilityCeiling({
			toolNames: ["read", "write", "task"],
			hostToolNames: ["host_a", "host_b"],
			spawn: { agentNames: ["scout", "task"], maxDepth: 4, detached: true },
		});
		const model = createMockModel({ id: "revived-model" });
		const manager = SessionManager.create(cwd, `${cwd}/sessions`);
		const persistedInit = {
			systemPrompt: "persisted subagent",
			task: "continue",
			tools: ["read", "write", "task"],
			spawns: "scout,task",
			model: { provider: model.provider, id: model.id },
			capabilityCeiling: persisted,
		};
		manager.appendSessionInit(persistedInit);
		await manager.ensureOnDisk();
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await manager.close();

		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage, `${cwd}/models.yml`);
		vi.spyOn(modelRegistry, "find").mockReturnValue(model);
		const settings = Settings.isolated();
		const hostRuntime = makeRuntime(model.stream, {
			toolNames: ["read", "task", "bash"],
			hostToolNames: ["host_b", "host_c"],
			spawn: { agentNames: ["task", "reviewer"], maxDepth: 2, detached: false },
		});
		const revivedSession = createYieldingSession(["read", "task"]);
		const createSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(revivedSession));
		const parentSession = {
			sessionManager: {
				getCwd: () => cwd,
				getArtifactManager: () => undefined,
			},
		} as unknown as AgentSession;
		const lifecycle = AgentLifecycleManager.global();
		lifecycle.setPersistedSubagentReviverFactory(
			createPersistedSubagentReviverFactory({
				session: parentSession,
				authStorage,
				modelRegistry,
				settings,
				enableLsp: false,
				embeddedRuntime: hostRuntime,
			}),
			0,
		);
		AgentRegistry.global().register({
			id: "RevivedChild",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "parked",
			sessionFile,
		});
		try {
			const revived = await lifecycle.ensureLive("RevivedChild");
			expect(revived).toBe(revivedSession);
			expect(createSpy).toHaveBeenCalledTimes(1);
			const revivedRuntime = createSpy.mock.calls[0]?.[0]?.embeddedRuntime;
			expect(revivedRuntime?.streamFn).toBe(hostRuntime.streamFn);
			expect(revivedRuntime?.capabilityCeiling).toEqual({
				toolNames: ["read", "task"],
				hostToolNames: ["host_b"],
				spawn: { agentNames: ["task"], maxDepth: 2, detached: false },
			});
			expect(hasExplicitSystemPrompt(createSpy.mock.calls[0]?.[0]?.systemPrompt)).toBe(true);
		} finally {
			authStorage.close();
			await revivedSession.dispose();
			const reopened = createSpy.mock.calls[0]?.[0]?.sessionManager;
			await reopened?.close();
		}
	});

	it("keeps concurrent runtimes isolated when sessions share one Settings instance", async () => {
		const settings = Settings.isolated();
		const stream = createMockModel().stream;
		const restrictiveRuntime = makeRuntime(stream, {
			toolNames: ["read", "task"],
			hostToolNames: [],
			spawn: { agentNames: ["scout"], maxDepth: 2, detached: false },
		});
		const permissiveRuntime = makeRuntime(stream, {
			toolNames: ["read", "task"],
			hostToolNames: [],
			spawn: { agentNames: ["task"], maxDepth: 2, detached: false },
		});
		const spawnedAgent = { ...taskAgent, tools: ["read"] };
		const captured = new Map<string, CreateAgentSessionOptions>();
		const sessions: AgentSession[] = [];
		const sessionManagers = new Map<string, SessionManager>();
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const agentId = options?.agentId;
			const session = createYieldingSession();
			if (agentId) {
				captured.set(agentId, options ?? {});
				sessionManagers.set(agentId, session.sessionManager);
			}
			sessions.push(session);
			return createSessionResult(session);
		});

		const [restrictive, permissive, legacy] = await Promise.all([
			executorModule.runSubprocess(
				executorOptions(settings, spawnedAgent, {
					id: "restrictive-child",
					embeddedRuntime: restrictiveRuntime,
				}),
			),
			executorModule.runSubprocess(
				executorOptions(settings, spawnedAgent, {
					id: "permissive-child",
					embeddedRuntime: permissiveRuntime,
				}),
			),
			executorModule.runSubprocess(executorOptions(settings, spawnedAgent, { id: "legacy-child" })),
		]);

		expect(restrictive.exitCode).toBe(1);
		expect(restrictive.error).toMatch(/does not allow agent/i);
		expect(permissive.exitCode).toBe(0);
		expect(legacy.exitCode).toBe(0);
		expect(captured.has("restrictive-child")).toBe(false);
		expect(captured.get("permissive-child")?.embeddedRuntime?.capabilityCeiling).toEqual({
			toolNames: ["read"],
			hostToolNames: [],
			spawn: "deny",
		});
		expect(captured.get("legacy-child")?.embeddedRuntime).toBeUndefined();
		for (const agentId of ["permissive-child", "legacy-child"]) {
			const initEntries = sessionManagers
				.get(agentId)
				?.getEntries()
				.filter(entry => entry.type === "session_init");
			expect(initEntries).toHaveLength(1);
		}
		const embeddedInit = sessionManagers
			.get("permissive-child")
			?.getEntries()
			.find(entry => entry.type === "session_init");
		const legacyInit = sessionManagers
			.get("legacy-child")
			?.getEntries()
			.find(entry => entry.type === "session_init");
		expect(embeddedInit?.capabilityCeiling).toEqual({
			toolNames: ["read"],
			hostToolNames: [],
			spawn: "deny",
		});
		expect(legacyInit?.capabilityCeiling).toBeUndefined();
		await Promise.all(sessions.map(session => session.dispose()));
	});

	it("keeps legacy TaskTool spawning permissive when no embedded runtime is provided", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("LegacyChild"));
		const settings = Settings.isolated({ "async.enabled": false });
		const tool = await TaskTool.create(taskToolSession(settings));

		const result = await tool.execute("legacy-task", {
			agent: "task",
			name: "LegacyChild",
			task: "do work",
		} as TaskParams);

		expect(result.details?.results?.[0]?.exitCode).toBe(0);
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy.mock.calls[0]?.[0]?.embeddedRuntime).toBeUndefined();
	});
});
