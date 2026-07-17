import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "../config/settings";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { AgentRuntimeScope } from "../registry/agent-runtime-scope";
import type { AgentSession } from "../session/agent-session";
import type { ToolSession } from "../tools";
import { type CoordinationDetails, HubTool } from "../tools/hub";
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
		const runtimeScope = AgentRuntimeScope.create();
		const { registry, lifecycle } = runtimeScope;
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
			agentRuntimeScope: runtimeScope,
		});

		expect(registry.get("Scoped")?.status).toBe("idle");
		expect(lifecycle.has("Scoped")).toBe(true);
		expect(AgentRegistry.global().get("Scoped")).toBeUndefined();
		expect(AgentLifecycleManager.global().has("Scoped")).toBe(false);
	});

	it("unregisters one-shot subagents from the injected registry only", async () => {
		const runtimeScope = AgentRuntimeScope.create();
		const { registry } = runtimeScope;
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
			agentRuntimeScope: runtimeScope,
		});

		expect(registry.get("OneShot")).toBeUndefined();
		// A same-id ref in a different registry (here: the global one) is untouched.
		expect(AgentRegistry.global().get("OneShot")?.status).toBe("idle");
	});

	it("keeps same-id agents, hub routing, and lifecycle ownership isolated across two scopes", async () => {
		const first = AgentRuntimeScope.create();
		const second = AgentRuntimeScope.create();
		const firstInbox: string[] = [];
		const secondInbox: string[] = [];
		const firstWorker = {
			dispose: async () => {},
			deliverIrcMessage: async (message: { body: string }) => {
				firstInbox.push(message.body);
				return "injected" as const;
			},
		} as unknown as AgentSession;
		const secondWorker = {
			dispose: async () => {},
			deliverIrcMessage: async (message: { body: string }) => {
				secondInbox.push(message.body);
				return "injected" as const;
			},
		} as unknown as AgentSession;
		const firstMain = makeSession();
		const secondMain = makeSession();
		first.registry.register({ id: "Main", displayName: "first main", kind: "main", session: firstMain });
		first.registry.register({ id: "Worker", displayName: "first worker", kind: "sub", session: firstWorker });
		second.registry.register({ id: "Main", displayName: "second main", kind: "main", session: secondMain });
		second.registry.register({ id: "Worker", displayName: "second worker", kind: "sub", session: secondWorker });

		const baseToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getAgentId: () => "Main",
		};
		const firstHub = new HubTool({ ...baseToolSession, agentRuntimeScope: first } satisfies ToolSession);
		const secondHub = new HubTool({ ...baseToolSession, agentRuntimeScope: second } satisfies ToolSession);
		const firstList = await firstHub.execute("first-list", { op: "list" });
		const secondList = await secondHub.execute("second-list", { op: "list" });
		expect((firstList.details as CoordinationDetails).peers?.map(peer => peer.displayName)).toEqual(["first worker"]);
		expect((secondList.details as CoordinationDetails).peers?.map(peer => peer.displayName)).toEqual([
			"second worker",
		]);

		await firstHub.execute("first-send", { op: "send", to: "Worker", message: "first only" });
		expect(firstInbox).toEqual(["first only"]);
		expect(secondInbox).toEqual([]);

		await finalizeSubagentLifecycle({
			id: "Worker",
			session: firstWorker,
			aborted: false,
			keepAlive: true,
			isolated: false,
			agentIdleTtlMs: 0,
			reviveSession: null,
			agentRuntimeScope: first,
		});
		await finalizeSubagentLifecycle({
			id: "Worker",
			session: secondWorker,
			aborted: false,
			keepAlive: true,
			isolated: false,
			agentIdleTtlMs: 0,
			reviveSession: null,
			agentRuntimeScope: second,
		});
		await first.lifecycle.release("Worker");
		expect(first.registry.get("Worker")).toBeUndefined();
		expect(second.registry.get("Worker")?.status).toBe("idle");
		expect(second.lifecycle.has("Worker")).toBe(true);
		await second.lifecycle.release("Worker");
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
