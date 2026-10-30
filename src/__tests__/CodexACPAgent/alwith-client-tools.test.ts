import { afterEach, describe, expect, it, vi } from "vitest";
import {
    connectSession,
    createTurn,
    turnId,
    sessionId,
    turnStarted,
    turnCompleted,
    itemCompleted,
    userMessageItem,
    type PromptSession,
} from "./v2-prompt-harness";
import { clientToolsOf, toolResponse } from "../../alwith/agent/clientTools";
const tools = {
    version: 1,
    revision: "canvas-1",
    definitions: [
        {
            name: "write_canvas",
            description: "Write canvas",
            inputSchema: { type: "object" },
        },
    ],
};
const call = {
    threadId: sessionId,
    turnId,
    callId: "write-1",
    tool: "alwith_client_write_canvas",
    namespace: null,
    arguments: {},
};
const clients: PromptSession[] = [];
afterEach(() => {
    for (const client of clients.splice(0)) client.connection.close();
});
async function start(options: Parameters<typeof connectSession>[1] = {}) {
    const client = await connectSession(2, {
        newSessionMeta: { alwith: { tools } },
        onRequestPermission: () => ({
            outcome: { outcome: "selected", optionId: "allow_once" },
        }),
        ...options,
    });
    clients.push(client);
    client.setTurnStart(async () => ({
        turn: createTurn("inProgress", turnId),
    }));
    const prompt = client.sendPrompt([{ type: "text", text: "Write canvas" }]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    client.emit(turnStarted());
    await vi.waitFor(() =>
        expect(client.agent.getSessionState(sessionId).currentTurnId).toBe(
            turnId,
        ),
    );
    const finish = async () => {
        client.emit(
            itemCompleted(
                userMessageItem(
                    client.turnStartParams[0]!["clientUserMessageId"] as string,
                ),
            ),
        );
        await prompt;
        client.emit(turnCompleted());
        await client.promptRunFinished();
    };
    return { client, finish };
}
describe("ALwith host tools over the upstream ACP router", () => {
    it("deduplicates writes and rejects altered call IDs and stale turns", async () => {
        const host = vi
            .fn()
            .mockResolvedValue({
                success: true,
                contentItems: [{ type: "text", text: "written" }],
            });
        const { client, finish } = await start({ onToolCall: host });
        const first = client.triggerApproval("item/tool/call", call);
        expect(await client.triggerApproval("item/tool/call", call)).toEqual(
            await first,
        );
        expect(await first).toEqual({
            success: true,
            contentItems: [{ type: "inputText", text: "written" }],
        });
        expect(host).toHaveBeenCalledTimes(1);
        for (const changes of [
            { arguments: { changed: true } },
            { turnId: "old" },
            { tool: "shell" },
        ]) {
            expect(
                await client.triggerApproval("item/tool/call", {
                    ...call,
                    ...changes,
                }),
            ).toMatchObject({ success: false });
        }
        expect(host).toHaveBeenCalledTimes(1);
        await finish();
    });
    it("keeps concurrent host calls independent when responses finish in reverse order", async () => {
        const pending = new Map<string, (value: unknown) => void>();
        const { client, finish } = await start({
            onToolCall: (params) => {
                const { toolCallId } = params as { toolCallId: string };
                return new Promise((resolve) => {
                    pending.set(toolCallId, resolve);
                });
            },
        });
        const first = client.triggerApproval("item/tool/call", {
            ...call,
            callId: "first",
        });
        const second = client.triggerApproval("item/tool/call", {
            ...call,
            callId: "second",
        });
        await vi.waitFor(() =>
            expect([...pending.keys()]).toEqual(["first", "second"]),
        );
        pending.get("second")!({
            success: true,
            contentItems: [{ type: "text", text: "second result" }],
        });
        expect(await second).toEqual({
            success: true,
            contentItems: [{ type: "inputText", text: "second result" }],
        });
        pending.get("first")!({
            success: true,
            contentItems: [{ type: "text", text: "first result" }],
        });
        expect(await first).toEqual({
            success: true,
            contentItems: [{ type: "inputText", text: "first result" }],
        });
        await finish();
    });
    it("does not invoke the host when permission is denied", async () => {
        const host = vi.fn();
        const { client, finish } = await start({
            onToolCall: host,
            onRequestPermission: () => ({ outcome: { outcome: "cancelled" } }),
        });
        expect(
            await client.triggerApproval("item/tool/call", call),
        ).toMatchObject({ success: false });
        expect(host).not.toHaveBeenCalled();
        await finish();
    });
    it("cancels a pending host request when the session is cancelled", async () => {
        let hostSignal: AbortSignal | undefined;
        let release!: (value: unknown) => void;
        const { client, finish } = await start({
            onToolCall: (_params, signal) => {
                hostSignal = signal;
                return new Promise((resolve) => {
                    release = resolve;
                });
            },
        });
        const result = client.triggerApproval("item/tool/call", call);
        await vi.waitFor(() => expect(hostSignal).toBeDefined());
        await client.cancel();
        expect(await result).toMatchObject({ success: false });
        await vi.waitFor(() => expect(hostSignal?.aborted).toBe(true));
        release({
            success: true,
            contentItems: [{ type: "text", text: "late" }],
        });
        await finish();
    });
    it("validates declarations and rejects unbounded resource results", () => {
        expect(() =>
            clientToolsOf({
                alwith: {
                    tools: {
                        ...tools,
                        definitions: [
                            ...tools.definitions,
                            ...tools.definitions,
                        ],
                    },
                },
            }),
        ).toThrow("unique");
        expect(() =>
            toolResponse({
                success: true,
                contentItems: [
                    { type: "resource", uri: "https://example.com" },
                ],
            }),
        ).toThrow("bounded");
    });
});
