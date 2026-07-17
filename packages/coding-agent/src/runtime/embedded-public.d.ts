import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";

export interface CapabilityCeiling {
	readonly toolNames: readonly string[];
	readonly hostToolNames: readonly string[];
	readonly spawn:
		| "deny"
		| {
				readonly agentNames: readonly string[];
				readonly maxDepth: number;
				readonly detached: boolean;
		  };
}

export interface EmbeddedAgentDefinition {
	readonly name: string;
	readonly description: string;
	readonly systemPrompt: string;
	readonly tools?: readonly string[];
	readonly spawns?: "*" | readonly string[];
	readonly model?: readonly string[];
	readonly thinkingLevel?: string;
	readonly output?: unknown;
	readonly autoloadSkills?: readonly string[];
	readonly source?: string;
}

export interface EmbeddedRuntimeOptions {
	readonly mode: "deterministic";
	readonly streamFn: StreamFn;
	readonly capabilityCeiling: CapabilityCeiling;
	readonly agentDefinitions?: readonly EmbeddedAgentDefinition[];
}

export interface SessionEntry {
	readonly type: string;
	readonly id: string;
	readonly parentId?: string | null;
	readonly [key: string]: unknown;
}

export interface CustomTool {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: unknown;
	execute(
		toolCallId: string,
		input: unknown,
		onUpdate: ((update: unknown) => void) | undefined,
		context: unknown,
		signal: AbortSignal,
	): Promise<unknown>;
}

export class SqliteAuthCredentialStore {
	constructor(database: unknown);
}

export class AuthStorage {
	constructor(
		store: SqliteAuthCredentialStore,
		options?: { configValueResolver?: (key: string) => Promise<string | undefined> },
	);
	close(): void;
}

export const kNoAuth: string;

export class ModelRegistry {
	constructor(authStorage: AuthStorage, modelsPath: string);
	registerProvider(
		provider: string,
		config: { api: string; apiKey: string; baseUrl?: string; models?: readonly unknown[] },
	): void;
}

export class Settings {
	static isolated(values?: Record<string, unknown>): Settings;
}

export class SessionManager {
	static inMemory(cwd: string): SessionManager;
	ingestReplicatedEntry(entry: SessionEntry): void;
}

export interface EmbeddedAgentSession {
	readonly sessionManager: SessionManager;
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(prompt: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
	waitForIdle(): Promise<void>;
	getLastAssistantMessage(): AssistantMessage | undefined;
	abort(options?: { goalReason?: string; reason?: string }): Promise<void>;
	dispose(options?: { mnemopiConsolidateTimeoutMs?: number }): Promise<void>;
}

export interface CreateEmbeddedAgentSessionOptions {
	readonly cwd: string;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly model: Model<string>;
	readonly settings: Settings;
	readonly sessionManager: SessionManager;
	readonly systemPrompt: string | readonly string[];
	readonly embeddedRuntime: EmbeddedRuntimeOptions;
	readonly thinkingLevel?: string;
	readonly customTools?: readonly CustomTool[];
	readonly toolNames?: readonly string[];
	readonly disableExtensionDiscovery?: boolean;
	readonly enableMCP?: boolean;
	readonly enableLsp?: boolean;
	readonly skipPythonPreflight?: boolean;
	readonly skills?: readonly unknown[];
	readonly rules?: readonly unknown[];
	readonly contextFiles?: readonly unknown[];
	readonly workspaceTree?: unknown;
	readonly promptTemplates?: readonly unknown[];
	readonly slashCommands?: readonly unknown[];
	readonly hasUI?: boolean;
}

export function createAgentSession(options: CreateEmbeddedAgentSessionOptions): Promise<{
	session: EmbeddedAgentSession;
	extensionsResult: { extensions: readonly unknown[]; errors: readonly unknown[] };
}>;
