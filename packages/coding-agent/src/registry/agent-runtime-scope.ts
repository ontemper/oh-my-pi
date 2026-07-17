import { IrcBus } from "../irc/bus";
import { AgentLifecycleManager } from "./agent-lifecycle";
import { AgentRegistry } from "./agent-registry";

/**
 * Cohesive ownership boundary for task agents in one top-level session.
 *
 * Registry identity, park/revive lifecycle, and IRC routing must share the
 * same registry. Construct scoped runtimes through {@link create}; use
 * {@link global} only for the single-session CLI compatibility path.
 */
export class AgentRuntimeScope {
	readonly registry: AgentRegistry;
	readonly lifecycle: AgentLifecycleManager;
	readonly irc: IrcBus;

	private constructor(registry: AgentRegistry, lifecycle: AgentLifecycleManager, irc: IrcBus) {
		this.registry = registry;
		this.lifecycle = lifecycle;
		this.irc = irc;
	}

	/** Create an isolated runtime scope for one embedded top-level session. */
	static create(registry: AgentRegistry = new AgentRegistry()): AgentRuntimeScope {
		const lifecycle = new AgentLifecycleManager(registry);
		return new AgentRuntimeScope(registry, lifecycle, new IrcBus(registry, lifecycle));
	}

	/** Process-global compatibility scope used by the CLI when no scope is injected. */
	static global(): AgentRuntimeScope {
		return new AgentRuntimeScope(AgentRegistry.global(), AgentLifecycleManager.global(), IrcBus.global());
	}
}
