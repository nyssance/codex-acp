import { afterEach, describe, expect, it, vi } from "vitest";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { ThreadItem } from "../../app-server/v2";
import {
    connectSession,
    createThread,
    createTurn,
    cwd,
    dump,
    itemCompleted,
    itemStarted,
    type PromptSession,
    sessionId,
    settle,
    turnCompleted,
    turnStarted,
    userMessageItem,
} from "./v2-prompt-harness";
import { expectConformingV2SessionUpdates } from "./v2-session-update-guard";

const image = {
    type: "imageGeneration",
    generationId: null,
    id: "generated-image",
    status: "completed",
    revisedPrompt: null,
    result: "iVBORw0KGgo=",
    savedPath: "/workspace/generated/square.png",
    failure: null,
} satisfies ThreadItem;

const imageContent = [
    {
        type: "content",
        content: {
            type: "image",
            data: image.result,
            mimeType: "image/png",
        },
    },
];

function toolUpdates(client: PromptSession): acpV2.SessionUpdate[] {
    return client.transcript.flatMap((entry) =>
        "sessionUpdate" in entry &&
        ["tool_call", "tool_call_update"].includes(
            entry.sessionUpdate.sessionUpdate,
        )
            ? [entry.sessionUpdate]
            : [],
    );
}

async function startTurn(client: PromptSession): Promise<void> {
    const response = client.sendPrompt([
        { type: "text", text: "Draw a square" },
    ]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    const clientId = client.turnStartParams[0]!["clientUserMessageId"];
    expect(typeof clientId).toBe("string");
    client.emit(turnStarted());
    client.emit(itemCompleted(userMessageItem(clientId as string)));
    await response;
}

async function finishTurn(client: PromptSession): Promise<void> {
    client.emit(turnCompleted());
    await client.promptRunFinished();
    await settle();
}

describe("image generation over ACP v2", () => {
    let client: PromptSession | undefined;

    afterEach(() => {
        client?.connection.close();
        client = undefined;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it("preserves image identity and content through live start and completion upserts", async () => {
        client = await connectSession(2);
        await startTurn(client);
        client.emit(
            itemStarted({
                type: "imageGeneration",
                generationId: null,
                id: image.id,
                status: "generating",
                revisedPrompt: null,
                result: "",
                failure: null,
            }),
        );
        await vi.waitFor(() => expect(toolUpdates(client!)).toHaveLength(1));
        expect(toolUpdates(client)[0]).toMatchObject({
            sessionUpdate: "tool_call_update",
            toolCallId: image.id,
            name: "image_generation",
            status: "in_progress",
        });
        expect(toolUpdates(client)[0]).not.toHaveProperty("content");

        client.emit(itemCompleted(image));
        await finishTurn(client);
        const updates = toolUpdates(client);
        expect(updates).toHaveLength(2);
        expect(updates[1]).toMatchObject({
            sessionUpdate: "tool_call_update",
            toolCallId: image.id,
            status: "completed",
            content: imageContent,
            rawOutput: { savedPath: image.savedPath },
        });
        // Omitted patch fields retain the identity established by the start upsert.
        expect(Object.assign({}, ...updates)).toMatchObject({
            name: "image_generation",
        });
        await expect(dump(updates)).toMatchFileSnapshot(
            "data/image-generation-v2-live.json",
        );
    });

    it("creates a complete image upsert when the start event was not observed", async () => {
        client = await connectSession(2);
        await startTurn(client);
        client.emit(itemCompleted(image));
        await finishTurn(client);
        const updates = toolUpdates(client);
        expect(updates).toHaveLength(1);
        expect(updates[0]).toMatchObject({
            sessionUpdate: "tool_call_update",
            toolCallId: image.id,
            name: "image_generation",
            status: "completed",
            content: imageContent,
            rawOutput: { savedPath: image.savedPath },
        });
        await expect(dump(updates)).toMatchFileSnapshot(
            "data/image-generation-v2-completed-only.json",
        );
    });

    it("replays image identity and content before the v2 resume response", async () => {
        client = await connectSession(2);
        client.setCodexResponse("thread/read", async () => ({
            readState: null,
            thread: {
                ...createThread(),
                turns: [
                    {
                        ...createTurn("completed"),
                        items: [image],
                        itemsView: "full",
                    },
                ],
            },
        }));
        await client.request("session/resume", {
            sessionId,
            cwd,
            replayFrom: { type: "start" },
        });
        const updates = toolUpdates(client);
        expect(updates).toHaveLength(1);
        expect(updates[0]).toMatchObject({
            sessionUpdate: "tool_call_update",
            toolCallId: image.id,
            name: "image_generation",
            status: "completed",
            content: imageContent,
            rawOutput: { savedPath: image.savedPath },
        });
        await settle();
        expect(toolUpdates(client)).toEqual(updates);
        await expect(dump(updates)).toMatchFileSnapshot(
            "data/image-generation-v2-replay.json",
        );
    });
});
