import {describe, expect, it} from "vitest";
import {connectSession, sessionId} from "./v2-prompt-harness";

describe.each([1, 2] as const)("ACP v%s background terminal controls", version => {
    it("snapshots all targets, verifies stops and aggregates failures without stopping later processes", async () => {
        const h = await connectSession(version);
        const stopped: string[] = [];
        let begun = false;
        h.setCodexResponse("thread/backgroundTerminals/list", async params => {
            const {threadId, cursor} = params as {threadId: string; cursor: string | null};
            expect(threadId).toBe(sessionId);
            const ids = begun ? ["failed", "later"] : cursor === null ? ["one"] : ["failed", "two"];
            return {data: ids.map(processId => ({processId, itemId: `item-${processId}`, command: "sleep"})), nextCursor: !begun && cursor === null ? "next" : null};
        });
        h.setCodexResponse("thread/backgroundTerminals/terminate", async params => {
            begun = true;
            const {processId} = params as {processId: string};
            stopped.push(processId);
            return {terminated: processId !== "failed"};
        });
        try {
            await expect(h.request("_codex/terminals/list", {sessionId})).resolves.toHaveLength(3);
            await expect(h.request("_codex/terminals/list", {sessionId, threadId: "foreign"})).rejects.toMatchObject({code: -32602});
            await expect(h.request("_codex/terminals/stopAll", {sessionId})).resolves.toEqual({
                stopped: ["one", "two"], failures: [{processId: "failed", message: "Codex could not stop background terminal failed"}],
            });
            expect(stopped).toEqual(["one", "failed", "two"]);
            expect(h.turnStartParams).toHaveLength(0);
        } finally { h.connection.close(); }
    });
});
