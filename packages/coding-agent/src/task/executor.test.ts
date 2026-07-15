import { afterEach, describe, expect, it } from "bun:test";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { finalizeSubagentLifecycle } from "./executor";

function makeSession(): AgentSession {
	return { dispose: async () => {} } as unknown as AgentSession;
}

describe("finalizeSubagentLifecycle registry scoping", () => {
	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("adopts kept-alive subagents into the injected registry/lifecycle pair, not the global one", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const session = makeSession();
		registry.register({ id: "Scoped", displayName: "Scoped", kind: "sub", session, status: "running" });

		await finalizeSubagentLifecycle({
			id: "Scoped",
			session,
			aborted: false,
			keepAlive: true,
			isolated: false,
			agentIdleTtlMs: 0,
			reviveSession: null,
			agentRegistry: registry,
			agentLifecycleManager: lifecycle,
		});

		expect(registry.get("Scoped")?.status).toBe("idle");
		expect(lifecycle.has("Scoped")).toBe(true);
		expect(AgentRegistry.global().get("Scoped")).toBeUndefined();
		expect(AgentLifecycleManager.global().has("Scoped")).toBe(false);
	});

	it("unregisters one-shot subagents from the injected registry only", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const session = makeSession();
		registry.register({ id: "OneShot", displayName: "OneShot", kind: "sub", session, status: "running" });
		AgentRegistry.global().register({
			id: "OneShot",
			displayName: "OneShot",
			kind: "sub",
			session: makeSession(),
			status: "idle",
		});

		await finalizeSubagentLifecycle({
			id: "OneShot",
			session,
			aborted: false,
			keepAlive: false,
			isolated: false,
			agentIdleTtlMs: 0,
			reviveSession: null,
			agentRegistry: registry,
			agentLifecycleManager: lifecycle,
		});

		expect(registry.get("OneShot")).toBeUndefined();
		// A same-id ref in a different registry (here: the global one) is untouched.
		expect(AgentRegistry.global().get("OneShot")?.status).toBe("idle");
	});

	it("defaults to the global registry/lifecycle when nothing is injected", async () => {
		const session = makeSession();
		AgentRegistry.global().register({ id: "Legacy", displayName: "Legacy", kind: "sub", session, status: "running" });

		await finalizeSubagentLifecycle({
			id: "Legacy",
			session,
			aborted: false,
			keepAlive: true,
			isolated: false,
			agentIdleTtlMs: 0,
			reviveSession: null,
		});

		expect(AgentRegistry.global().get("Legacy")?.status).toBe("idle");
		expect(AgentLifecycleManager.global().has("Legacy")).toBe(true);
	});
});
