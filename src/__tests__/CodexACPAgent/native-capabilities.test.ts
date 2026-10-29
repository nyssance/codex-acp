import { describe, expect, it } from "vitest";
import {
    connectSession,
    sessionId,
    settle,
    turnStarted,
    turnCompleted,
    userMessageItem,
    itemStarted,
    itemCompleted,
} from "./v2-prompt-harness";
import {
    goalSessionInfoUpdate,
    sameThreadGoalSnapshot,
    toThreadGoalSnapshot,
} from "../../ThreadGoalSnapshot";
import { realtimeUpdate } from "../../CodexNativeExtensions";

describe("native capabilities through ACP", () => {
    it("registers hook reads and trust for both protocol versions", async () => {
        for (const version of [1, 2] as const) {
            const client = await connectSession(version);
            try {
                client.setCodexResponse("hooks/list", async () => ({
                    data: [
                        { cwd: "/work", hooks: [], warnings: [], errors: [] },
                    ],
                }));
                await expect(
                    client.request("_codex/hooks/list", { cwd: "/work" }),
                ).resolves.toEqual({
                    cwd: "/work",
                    hooks: [],
                    warnings: [],
                    errors: [],
                });
                await expect(
                    client.request("_codex/hooks/trust", {
                        cwd: "/work",
                        hooks: [],
                    }),
                ).rejects.toMatchObject({ code: -32602 });
            } finally {
                client.connection.close();
            }
        }
    });

    it("executes user shell commands on the owning writable session without starting a prompt", async () => {
        for (const version of [1, 2] as const) {
            const client = await connectSession(version);
            try {
                let request: unknown;
                client.setCodexResponse(
                    "thread/shellCommand",
                    async (params) => {
                        request = params;
                        return {};
                    },
                );
                await expect(
                    client.request("_codex/shell/execute", {
                        sessionId,
                        command: "printf 'a b' | cat",
                        timeoutMs: 1000,
                    }),
                ).resolves.toEqual({});
                expect(request).toEqual({
                    threadId: sessionId,
                    command: "printf 'a b' | cat",
                    timeoutMs: 1000,
                });
                expect(client.turnStartParams).toHaveLength(0);
                await expect(
                    client.request("_codex/shell/execute", {
                        sessionId,
                        threadId: "other",
                        command: "pwd",
                    }),
                ).rejects.toMatchObject({ code: -32602 });
                await expect(
                    client.request("_codex/shell/execute", {
                        sessionId: "unknown",
                        command: "pwd",
                    }),
                ).rejects.toThrow();
            } finally {
                client.connection.close();
            }
        }
    });

    it("uses the ACP session and rejects a caller-supplied native thread id", async () => {
        for (const version of [1, 2] as const) {
            const client = await connectSession(version);
            try {
                let request: unknown;
                client.setCodexResponse(
                    "thread/realtime/start",
                    async (params) => {
                        request = params;
                        return {};
                    },
                );
                await expect(
                    client.request("_codex/realtime/start", {
                        sessionId,
                        outputModality: "audio",
                        transport: { type: "websocket" },
                    }),
                ).resolves.toEqual({});
                expect(request).toEqual({
                    threadId: sessionId,
                    outputModality: "audio",
                    transport: { type: "websocket" },
                });
                await expect(
                    client.request("_codex/realtime/start", {
                        sessionId,
                        threadId: "other",
                    }),
                ).rejects.toMatchObject({ code: -32602 });
                await expect(
                    client.request("_codex/realtime/start", {
                        sessionId: "unknown",
                    }),
                ).rejects.toThrow();
            } finally {
                client.connection.close();
            }
        }
    });

    it("preserves native errors instead of claiming Bedrock setup succeeded", async () => {
        const client = await connectSession();
        try {
            client.setCodexResponse("account/bedrock/setup", async () => {
                throw new Error("AWS profile unavailable");
            });
            await expect(
                client.request("_codex/bedrock/setup", {
                    type: "profile",
                    profile: "work",
                    region: "us-west-2",
                }),
            ).rejects.toMatchObject({
                data: { details: "AWS profile unavailable" },
            });
        } finally {
            client.connection.close();
        }
    });

    it("selects an allowed native profile across pages and does not overwrite it on the next prompt", async () => {
        const client = await connectSession();
        try {
            client.setCodexResponse("permissionProfile/list", async (params) =>
                (params as { cursor: string | null }).cursor === null
                    ? { data: [], nextCursor: "next" }
                    : {
                          data: [
                              {
                                  id: "work",
                                  description: "Work policy",
                                  allowed: true,
                              },
                          ],
                          nextCursor: null,
                      },
            );
            let settings: unknown;
            client.setCodexResponse(
                "thread/settings/update",
                async (params) => {
                    settings = params;
                    return {};
                },
            );
            const response = await client.request("session/set_config_option", {
                sessionId,
                configId: "mode",
                type: "id",
                value: "profile:work",
            });
            expect(settings).toEqual({
                threadId: sessionId,
                permissions: "work",
            });
            expect(response.configOptions[0].currentValue).toBe("profile:work");
            const accepted = client.sendPrompt([
                { type: "text", text: "hello" },
            ]);
            await settle();
            expect(client.turnStartParams[0]).toMatchObject({
                permissions: "work",
            });
            expect(client.turnStartParams[0]).not.toHaveProperty(
                "sandboxPolicy",
            );
            expect(client.turnStartParams[0]).not.toHaveProperty(
                "approvalPolicy",
            );
            client.emit(turnStarted());
            client.emit(
                itemCompleted(
                    userMessageItem(
                        client.turnStartParams[0]![
                            "clientUserMessageId"
                        ] as string,
                        "hello",
                    ),
                ),
            );
            await settle();
            client.emit(turnCompleted());
            await accepted;
            await settle();
        } finally {
            client.connection.close();
        }
    });

    it("rejects disallowed profiles without changing thread settings", async () => {
        const client = await connectSession();
        try {
            client.setCodexResponse("permissionProfile/list", async () => ({
                data: [{ id: "locked", description: null, allowed: false }],
                nextCursor: null,
            }));
            let wrote = false;
            client.setCodexResponse("thread/settings/update", async () => {
                wrote = true;
                return {};
            });
            await expect(
                client.request("session/set_config_option", {
                    sessionId,
                    configId: "mode",
                    type: "id",
                    value: "profile:locked",
                }),
            ).rejects.toThrow("disallowed");
            expect(wrote).toBe(false);
        } finally {
            client.connection.close();
        }
    });

    it("publishes goal progress to ordinary v2 clients and distinguishes usage-only changes", () => {
        const goal = toThreadGoalSnapshot({
            threadId: sessionId,
            objective: "Test",
            status: "paused",
            tokenBudget: 100,
            tokensUsed: 5,
            timeUsedSeconds: 2,
            createdAt: 1,
            updatedAt: 2,
        });
        expect(goalSessionInfoUpdate(goal, false, true)).toEqual({
            sessionUpdate: "session_info_update",
            _meta: { codex: { goal } },
        });
        expect(goalSessionInfoUpdate(null, false, true)).toEqual({
            sessionUpdate: "session_info_update",
            _meta: { codex: { goal: null } },
        });
        expect(sameThreadGoalSnapshot(goal, { ...goal, tokensUsed: 6 })).toBe(
            false,
        );
    });

    it("routes realtime events by explicit session and preserves audio metadata", () => {
        const event = {
            method: "thread/realtime/closed" as const,
            params: { threadId: sessionId, reason: null },
        };
        expect(realtimeUpdate(event)).toEqual({
            sessionId,
            event: "closed",
            data: { reason: null },
        });
    });
});
