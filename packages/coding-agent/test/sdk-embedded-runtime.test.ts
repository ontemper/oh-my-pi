import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { type Context, Effort, type Message } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as startupDiscoveryModule from "@oh-my-pi/pi-coding-agent/discovery";
import { runEvalCompletion } from "@oh-my-pi/pi-coding-agent/eval/completion-bridge";
import * as customToolsModule from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import * as extensionsModule from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { runGuidedGoalTurn } from "@oh-my-pi/pi-coding-agent/goals/guided-setup";
import type { EmbeddedRuntimeOptions } from "@oh-my-pi/pi-coding-agent/runtime/embedded-runtime";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { makeIsolationCommitMessage } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";
import * as toolsModule from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const CONTEXT_SENTINEL = "embedded-context-must-not-be-discovered";
const SYSTEM_PROMPT_SENTINEL = "embedded-system-prompt-must-not-be-discovered";
const SLASH_SENTINEL = "embedded-slash-must-not-expand";
const EXA_SENTINEL = "embedded-exa-must-not-leak";
const AMBIENT_AGENT_DESCRIPTION = "ambient malicious allowlisted agent";
const AMBIENT_AGENT_PROMPT = "ambient malicious prompt";
const HOST_AGENT_DESCRIPTION = "host-owned allowlisted agent";
const HOST_AGENT_PROMPT = "host-owned prompt";

function messageText(message: Message | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
}

async function writeAmbientSentinels(cwd: string): Promise<void> {
	await Promise.all([
		Bun.write(`${cwd}/AGENTS.md`, CONTEXT_SENTINEL),
		Bun.write(`${cwd}/.omp/SYSTEM.md`, SYSTEM_PROMPT_SENTINEL),
		Bun.write(
			`${cwd}/.omp/skills/embedded-sentinel/SKILL.md`,
			"---\nname: embedded-sentinel\ndescription: must stay ambient\n---\n\nAmbient skill sentinel.\n",
		),
		Bun.write(`${cwd}/.omp/prompts/embedded-sentinel.md`, "Ambient prompt sentinel.\n"),
		Bun.write(`${cwd}/.agents/commands/embedded-sentinel.md`, `${SLASH_SENTINEL}\n`),
		Bun.write(
			`${cwd}/.omp/agents/allowlisted.md`,
			`---\nname: allowlisted\ndescription: ${AMBIENT_AGENT_DESCRIPTION}\nblocking: true\n---\n\n${AMBIENT_AGENT_PROMPT}\n`,
		),
		Bun.write(
			`${cwd}/.mcp.json`,
			JSON.stringify({
				mcpServers: { exa: { type: "http", url: `https://mcp.exa.ai/mcp?exaApiKey=${EXA_SENTINEL}` } },
			}),
		),
	]);
}

interface ExplicitRuntimeOptions {
	responses?: MockResponse[];
	toolNames?: string[];
	reasoning?: boolean;
}

async function createExplicitRuntime(cwd: string, options: ExplicitRuntimeOptions = {}) {
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage, `${cwd}/models.yml`);
	const settings = Settings.isolated({
		includeWorkspaceTree: false,
		"secrets.enabled": false,
		"compaction.enabled": false,
		"autolearn.enabled": false,
		"async.enabled": false,
	});
	const model = createMockModel({
		id: "embedded-primary",
		reasoning: options.reasoning,
		responses: options.responses ?? [{ content: ["embedded transport reached"] }, { content: ["slash observed"] }],
	});
	authStorage.setRuntimeApiKey(model.provider, "embedded-test-key");
	const embeddedRuntime = {
		mode: "deterministic",
		streamFn: model.stream,
		capabilityCeiling: {
			toolNames: options.toolNames ?? ["read"],
			hostToolNames: [],
			spawn: "deny",
		},
	} satisfies EmbeddedRuntimeOptions;
	return { authStorage, modelRegistry, settings, model, embeddedRuntime };
}

describe("createAgentSession embedded runtime", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("routes the primary model turn through the injected transport and performs no ambient discovery or environment mutation", async () => {
		using tempDir = TempDir.createSync("@omp-sdk-embedded-");
		const cwd = tempDir.path();
		await writeAmbientSentinels(cwd);
		const runtime = await createExplicitRuntime(cwd);
		const previousExaKey = Bun.env.EXA_API_KEY;
		delete Bun.env.EXA_API_KEY;

		const ambientDiscovery = new Error("deterministic embedded runtime attempted ambient discovery");
		vi.spyOn(Settings, "init").mockRejectedValue(ambientDiscovery);
		vi.spyOn(sdkModule, "discoverAuthStorage").mockRejectedValue(ambientDiscovery);
		vi.spyOn(startupDiscoveryModule, "initializeWithSettings").mockImplementation(() => {
			throw ambientDiscovery;
		});
		vi.spyOn(runtime.modelRegistry, "refreshInBackground").mockImplementation(() => {
			throw ambientDiscovery;
		});
		vi.spyOn(runtime.modelRegistry, "refresh").mockRejectedValue(ambientDiscovery);
		vi.spyOn(customToolsModule, "discoverCustomToolPaths").mockRejectedValue(ambientDiscovery);
		vi.spyOn(extensionsModule, "discoverExtensionPaths").mockRejectedValue(ambientDiscovery);
		vi.spyOn(toolsModule, "discoverStartupLspServers").mockImplementation(() => {
			throw ambientDiscovery;
		});
		vi.spyOn(toolsModule, "setExcludedSearchProviders").mockImplementation(() => {
			throw ambientDiscovery;
		});
		vi.spyOn(toolsModule, "setPreferredSearchProvider").mockImplementation(() => {
			throw ambientDiscovery;
		});
		vi.spyOn(toolsModule, "setPreferredImageProvider").mockImplementation(() => {
			throw ambientDiscovery;
		});

		try {
			const { session, extensionsResult } = await sdkModule.createAgentSession({
				cwd,
				authStorage: runtime.authStorage,
				modelRegistry: runtime.modelRegistry,
				model: runtime.model,
				settings: runtime.settings,
				sessionManager: SessionManager.inMemory(cwd),
				systemPrompt: ["embedded host prompt"],
				embeddedRuntime: runtime.embeddedRuntime,
			});
			try {
				await session.prompt("reach the primary model?");
				await session.waitForIdle();
				await session.prompt("/embedded-sentinel");
				await session.waitForIdle();

				expect(runtime.model.calls).toHaveLength(2);
				expect(
					runtime.model.calls[0]?.context.messages.some(message =>
						messageText(message).includes("reach the primary model"),
					),
				).toBe(true);
				const slashContext: Context | undefined = runtime.model.calls[1]?.context;
				expect(slashContext?.messages.some(message => messageText(message).includes("/embedded-sentinel"))).toBe(
					true,
				);
				expect(slashContext?.messages.some(message => messageText(message).includes(SLASH_SENTINEL))).toBe(false);
				expect(session.getLastAssistantMessage()?.content).toEqual([{ type: "text", text: "slash observed" }]);
				expect(session.skills).toEqual([]);
				expect(session.promptTemplates).toEqual([]);
				expect(session.agent.state.systemPrompt).toEqual(["embedded host prompt"]);
				expect(session.agent.state.systemPrompt.join("\n")).not.toContain(CONTEXT_SENTINEL);
				expect(session.agent.state.systemPrompt.join("\n")).not.toContain(SYSTEM_PROMPT_SENTINEL);
				expect(extensionsResult.extensions).toEqual([]);
				expect(session.customCommands).toEqual([]);
				expect(Bun.env.EXA_API_KEY).toBeUndefined();
				expect(Settings.init).not.toHaveBeenCalled();
				expect(sdkModule.discoverAuthStorage).not.toHaveBeenCalled();
				expect(startupDiscoveryModule.initializeWithSettings).not.toHaveBeenCalled();
				expect(runtime.modelRegistry.refreshInBackground).not.toHaveBeenCalled();
				expect(runtime.modelRegistry.refresh).not.toHaveBeenCalled();
				expect(customToolsModule.discoverCustomToolPaths).not.toHaveBeenCalled();
				expect(extensionsModule.discoverExtensionPaths).not.toHaveBeenCalled();
				expect(toolsModule.discoverStartupLspServers).not.toHaveBeenCalled();
				expect(toolsModule.setExcludedSearchProviders).not.toHaveBeenCalled();
				expect(toolsModule.setPreferredSearchProvider).not.toHaveBeenCalled();
				expect(toolsModule.setPreferredImageProvider).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		} finally {
			runtime.authStorage.close();
			if (previousExaKey === undefined) delete Bun.env.EXA_API_KEY;
			else Bun.env.EXA_API_KEY = previousExaKey;
		}
	});

	it("uses only capability-clamped host agent definitions when ambient agents shadow an allowlisted name", async () => {
		using tempDir = TempDir.createSync("@omp-sdk-embedded-agents-");
		const cwd = tempDir.path();
		await writeAmbientSentinels(cwd);
		const runtime = await createExplicitRuntime(cwd);
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => ({
			index: options.index,
			id: options.id ?? "embedded-child",
			agent: options.agent.name,
			agentSource: options.agent.source,
			task: options.task,
			assignment: options.assignment,
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
		}));

		try {
			const embeddedRuntime = {
				...runtime.embeddedRuntime,
				agentDefinitions: [
					{
						name: "allowlisted",
						description: HOST_AGENT_DESCRIPTION,
						systemPrompt: HOST_AGENT_PROMPT,
						blocking: true,
						source: "bundled",
					},
					{
						name: "outside-ceiling",
						description: "must be capability-clamped",
						systemPrompt: "must not be available",
						source: "bundled",
					},
				],
				capabilityCeiling: {
					toolNames: ["task"],
					hostToolNames: [],
					spawn: { agentNames: ["allowlisted"], maxDepth: 1, detached: false },
				},
			} satisfies EmbeddedRuntimeOptions;
			const { session } = await sdkModule.createAgentSession({
				cwd,
				authStorage: runtime.authStorage,
				modelRegistry: runtime.modelRegistry,
				model: runtime.model,
				settings: runtime.settings,
				sessionManager: SessionManager.inMemory(cwd),
				systemPrompt: ["embedded host prompt"],
				embeddedRuntime,
				toolNames: ["task"],
			});
			try {
				const task = session.getToolByName("task");
				if (!task) throw new Error("Expected embedded task tool");
				expect(task.description).toContain(HOST_AGENT_DESCRIPTION);
				expect(task.description).not.toContain(AMBIENT_AGENT_DESCRIPTION);
				expect(task.description).not.toContain("outside-ceiling");

				await task.execute("embedded-task", {
					agent: "allowlisted",
					task: "Use the host definition.",
				});
				expect(runSubprocess).toHaveBeenCalledTimes(1);
				expect(runSubprocess.mock.calls[0]?.[0].agent.systemPrompt).toBe(HOST_AGENT_PROMPT);
			} finally {
				await session.dispose();
			}
		} finally {
			runtime.authStorage.close();
		}
	});

	it("keeps ceiling-authorized yield active for regular and schema-bearing embedded child sessions", async () => {
		using tempDir = TempDir.createSync("@omp-sdk-embedded-child-yield-");
		const cwd = tempDir.path();
		const runtime = await createExplicitRuntime(cwd, { toolNames: ["read", "yield"] });
		const outputSchemas: Array<CreateAgentSessionOptions["outputSchema"]> = [
			undefined,
			{ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		];

		try {
			for (const [index, outputSchema] of outputSchemas.entries()) {
				const { session } = await sdkModule.createAgentSession({
					cwd,
					authStorage: runtime.authStorage,
					modelRegistry: runtime.modelRegistry,
					model: runtime.model,
					settings: runtime.settings,
					sessionManager: SessionManager.inMemory(cwd),
					systemPrompt: ["embedded child prompt"],
					embeddedRuntime: runtime.embeddedRuntime,
					toolNames: ["read", "write"],
					taskDepth: 1,
					agentId: `embedded-child-yield-${index}`,
					outputSchema,
					requireYieldTool: true,
				});
				try {
					expect(session.getEnabledToolNames().sort()).toEqual(["read", "yield"]);
					expect(session.getToolByName("yield")).toBeDefined();
					expect(session.getToolByName("write")).toBeUndefined();
				} finally {
					await session.dispose();
				}
			}
		} finally {
			runtime.authStorage.close();
		}
	});

	it("rejects an embedded child that requires yield when the ceiling does not authorize it", async () => {
		using tempDir = TempDir.createSync("@omp-sdk-embedded-child-yield-denied-");
		const cwd = tempDir.path();
		const runtime = await createExplicitRuntime(cwd, { toolNames: ["read"] });
		try {
			await expect(
				sdkModule.createAgentSession({
					cwd,
					authStorage: runtime.authStorage,
					modelRegistry: runtime.modelRegistry,
					model: runtime.model,
					settings: runtime.settings,
					sessionManager: SessionManager.inMemory(cwd),
					systemPrompt: ["embedded child prompt"],
					embeddedRuntime: runtime.embeddedRuntime,
					toolNames: ["read"],
					taskDepth: 1,
					agentId: "embedded-child-yield-denied",
					requireYieldTool: true,
				}),
			).rejects.toThrow(/capabilityCeiling\.toolNames.*authorize "yield"/i);
		} finally {
			runtime.authStorage.close();
		}
	});

	it("suppresses auto-thinking, unexpected-stop, and todo-replan title side requests", async () => {
		using tempDir = TempDir.createSync("@omp-sdk-embedded-aux-");
		const cwd = tempDir.path();
		const runtime = await createExplicitRuntime(cwd, {
			reasoning: true,
			toolNames: ["todo"],
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "todo-init",
							name: "todo",
							arguments: { op: "init", list: [{ phase: "Work", items: ["finish"] }] },
						},
					],
				},
				{ content: ["I will continue with the next step."] },
			],
		});
		Object.defineProperty(runtime.model, "thinking", {
			value: { efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});
		runtime.settings.set("features.unexpectedStopDetection", true);
		runtime.settings.set("providers.unexpectedStopModel", "online");
		const ambientCompletion = vi
			.spyOn(ai, "completeSimple")
			.mockRejectedValue(new Error("embedded auxiliary model path escaped"));
		vi.spyOn(runtime.modelRegistry, "getAvailable").mockReturnValue([runtime.model]);
		vi.spyOn(runtime.modelRegistry, "getApiKey").mockResolvedValue("ambient-key");

		try {
			const { session } = await sdkModule.createAgentSession({
				cwd,
				authStorage: runtime.authStorage,
				modelRegistry: runtime.modelRegistry,
				model: runtime.model,
				settings: runtime.settings,
				sessionManager: SessionManager.inMemory(cwd),
				systemPrompt: ["embedded host prompt"],
				embeddedRuntime: runtime.embeddedRuntime,
				toolNames: ["todo"],
				thinkingLevel: AUTO_THINKING,
			});
			try {
				await session.prompt("Plan this work, then execute it.");
				await session.waitForIdle();

				expect(runtime.model.calls.length).toBeGreaterThanOrEqual(2);
				expect(
					runtime.model.calls.every(call => call.context.systemPrompt?.includes("embedded host prompt") === true),
				).toBe(true);
				expect(ambientCompletion).not.toHaveBeenCalled();
				expect(session.sessionManager.getSessionName()).toBeUndefined();
			} finally {
				await session.dispose();
			}
		} finally {
			runtime.authStorage.close();
		}
	});

	it("fails closed for model-backed embedded tools and commands", async () => {
		using tempDir = TempDir.createSync("@omp-sdk-embedded-tools-");
		const cwd = tempDir.path();
		const runtime = await createExplicitRuntime(cwd, { toolNames: ["inspect_image"] });
		runtime.settings.set("inspect_image.enabled", true);
		runtime.settings.set("task.isolation.commits", "ai");
		const ambientCompletion = vi
			.spyOn(ai, "completeSimple")
			.mockRejectedValue(new Error("embedded auxiliary model path escaped"));
		const auxiliaryKeyLookup = vi.spyOn(runtime.modelRegistry, "getApiKey").mockResolvedValue("ambient-key");

		try {
			const { session } = await sdkModule.createAgentSession({
				cwd,
				authStorage: runtime.authStorage,
				modelRegistry: runtime.modelRegistry,
				model: runtime.model,
				settings: runtime.settings,
				sessionManager: SessionManager.inMemory(cwd),
				systemPrompt: ["embedded host prompt"],
				embeddedRuntime: runtime.embeddedRuntime,
				toolNames: ["inspect_image"],
			});
			try {
				const inspectImage = session.getToolByName("inspect_image");
				if (!inspectImage) throw new Error("Expected embedded inspect_image tool");
				await expect(
					inspectImage.execute("inspect", { path: "missing.png", question: "What is shown?" }),
				).rejects.toThrow("unavailable in deterministic embedded runtime");
				await expect(runEvalCompletion({ prompt: "side request" }, { session: session as never })).rejects.toThrow(
					"unavailable in deterministic embedded runtime",
				);
				await expect(runGuidedGoalTurn(session, { messages: [] })).rejects.toThrow(
					"unavailable in deterministic embedded runtime",
				);
				expect(makeIsolationCommitMessage(session as never)()).toBeUndefined();
				expect(auxiliaryKeyLookup).not.toHaveBeenCalled();
				expect(runtime.model.calls).toHaveLength(0);
				expect(ambientCompletion).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		} finally {
			runtime.authStorage.close();
		}
	});

	it("does not use a vision side model for text-only embedded image turns", async () => {
		using tempDir = TempDir.createSync("@omp-sdk-embedded-image-");
		const cwd = tempDir.path();
		const runtime = await createExplicitRuntime(cwd, { responses: [{ content: ["image received"] }] });
		runtime.settings.set("images.describeForTextModels", true);
		const visionModel = createMockModel({ id: "ambient-vision" });
		visionModel.input.push("image");
		const ambientCompletion = vi
			.spyOn(ai, "completeSimple")
			.mockRejectedValue(new Error("embedded auxiliary model path escaped"));
		vi.spyOn(runtime.modelRegistry, "getAvailable").mockReturnValue([visionModel]);
		vi.spyOn(runtime.modelRegistry, "getApiKey").mockResolvedValue("ambient-key");
		try {
			const { session } = await sdkModule.createAgentSession({
				cwd,
				authStorage: runtime.authStorage,
				modelRegistry: runtime.modelRegistry,
				model: runtime.model,
				settings: runtime.settings,
				sessionManager: SessionManager.inMemory(cwd),
				systemPrompt: ["embedded host prompt"],
				embeddedRuntime: runtime.embeddedRuntime,
			});
			try {
				await session.prompt("Inspect this image.", {
					images: [
						{
							type: "image",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
							mimeType: "image/png",
						},
					],
				});
				await session.waitForIdle();

				expect(runtime.model.calls).toHaveLength(1);
				expect(runtime.model.calls[0]?.context.messages.map(messageText).join("\n")).toContain(
					"No vision-capable model is configured",
				);
				expect(ambientCompletion).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		} finally {
			runtime.authStorage.close();
		}
	});

	it("requires every host-owned runtime dependency instead of falling back to ambient state", async () => {
		using tempDir = TempDir.createSync("@omp-sdk-embedded-required-");
		const runtime = await createExplicitRuntime(tempDir.path());
		try {
			const required = ["settings", "authStorage", "modelRegistry", "model", "systemPrompt"] as const;
			for (const missing of required) {
				const options: CreateAgentSessionOptions = {
					cwd: tempDir.path(),
					authStorage: runtime.authStorage,
					modelRegistry: runtime.modelRegistry,
					model: runtime.model,
					settings: runtime.settings,
					sessionManager: SessionManager.inMemory(tempDir.path()),
					systemPrompt: ["embedded host prompt"],
					embeddedRuntime: runtime.embeddedRuntime,
				};
				delete options[missing];
				await expect(sdkModule.createAgentSession(options)).rejects.toThrow(new RegExp(missing, "i"));
			}
		} finally {
			runtime.authStorage.close();
		}
	});

	it("preserves legacy SDK discovery defaults when embeddedRuntime is absent", async () => {
		using tempDir = TempDir.createSync("@omp-sdk-legacy-");
		const cwd = tempDir.path();
		await writeAmbientSentinels(cwd);
		const refresh = vi.spyOn(ModelRegistry.prototype, "refreshInBackground").mockImplementation(() => {});
		const { session } = await sdkModule.createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: SessionManager.inMemory(cwd),
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
		});
		try {
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(session.skills.some(skill => skill.name === "embedded-sentinel")).toBe(true);
			expect(session.promptTemplates.some(prompt => prompt.name === "embedded-sentinel")).toBe(true);
			expect(session.agent.state.systemPrompt.join("\n")).toContain(CONTEXT_SENTINEL);
			const task = session.getToolByName("task");
			if (!task) throw new Error("Expected legacy task tool");
			expect(task.description).toContain(AMBIENT_AGENT_DESCRIPTION);
		} finally {
			await session.dispose();
		}
	});
});
