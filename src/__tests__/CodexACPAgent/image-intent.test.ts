import {describe, expect, it, vi} from "vitest";
import {imageIntentContext, inputModeOf} from "../../alwith/codex/imageIntent";
import {
    codexResponse,
    createThread,
    connectSession,
    sessionId,
    turnId,
    turnStarted,
    turnCompleted,
    itemCompleted,
    userMessageItem,
} from "./v2-prompt-harness";

it.each([false, "picture_v2", {}, 3])("rejects an invalid image intent: %j", imageIntent => {
    expect(() => imageIntentContext({alwith: {imageIntent}})).toThrow("imageIntent");
});
it("does not add image context for clients that omit the extension", () => {
    expect(imageIntentContext(undefined)).toBeUndefined();
});

describe.each([1, 2] as const)("ACP v%s image intent", version => {
    it.each(["generate", "edit", null] as const)("delivers %s intent separately from user text and attachments", async imageIntent => {
        const session = await connectSession(version);
        const prompt = [
            {type: "text" as const, text: "Keep the original wording"},
            {type: "image" as const, mimeType: "image/png", data: "aGVsbG8="},
        ];
        try {
            const response = session.request("session/prompt", {sessionId, prompt, _meta: {alwith: {imageIntent}}});
            await vi.waitFor(() => expect(session.turnStartParams).toHaveLength(1));
            const params = session.turnStartParams[0]!;
            expect(params["input"]).toEqual([
                {type: "text", text: "Keep the original wording", text_elements: []},
                {type: "image", url: "data:image/png;base64,aGVsbG8="},
            ]);
            expect(params["additionalContext"]).toEqual(imageIntentContext({alwith: {imageIntent}}));
            session.emit(turnStarted(turnId));
            session.emit(itemCompleted(userMessageItem(params["clientUserMessageId"] as string), turnId));
            session.emit(turnCompleted(turnId));
            await response;
        } finally {
            session.connection.close();
        }
    });
});

it("keeps edit intent on a message steered into an active v2 turn", async () => {
    const session = await connectSession(2);
    try {
        const first = session.request("session/prompt", {
            sessionId,
            prompt: [{type: "text", text: "A tree"}],
            _meta: {alwith: {imageIntent: "generate"}},
        });
        await vi.waitFor(() => expect(session.turnStartParams).toHaveLength(1));
        session.emit(turnStarted(turnId));
        session.emit(itemCompleted(userMessageItem(session.turnStartParams[0]!["clientUserMessageId"] as string), turnId));
        await first;
        let steered: Record<string, unknown> | null = null;
        session.setCodexResponse("turn/steer", async params => {
            steered = params as Record<string, unknown>;
            return {turnId};
        });
        await session.request("session/prompt", {
            sessionId,
            prompt: [{type: "text", text: "Make it blue"}],
            _meta: {alwith: {imageIntent: "edit"}},
        });
        expect(steered).toMatchObject({
            input: [{type: "text", text: "Make it blue", text_elements: []}],
            additionalContext: imageIntentContext({alwith: {imageIntent: "edit"}}),
        });
        session.emit(turnCompleted(turnId));
    } finally {
        session.connection.close();
    }
});

it.each([false, "picture_v2", {}, 3])("rejects an invalid session input mode: %j", inputMode => {
    expect(() => inputModeOf({alwith: {inputMode}})).toThrow("inputMode");
});

it("keeps workflow instructions scoped to application image requests", () => {
    const imageInstructions = "Use the selected image model and return its image reference.";
    expect(imageIntentContext({alwith: {imageIntent: "edit", imageInstructions}})?.["alwith.imageIntent"]?.value).toContain(
        imageInstructions,
    );
    const native = imageIntentContext({alwith: {imageIntent: null, imageInstructions}})?.["alwith.imageIntent"]?.value;
    expect(native).toContain("use the native image generation tool");
    expect(native).not.toContain(imageInstructions);
    expect(() => imageIntentContext({alwith: {imageIntent: "edit", imageInstructions: {}}})).toThrow("imageInstructions");
});

describe.each([1, 2] as const)("ACP v%s session image routing", version => {
    it.each(["chat", "image"] as const)("keeps %s routing across creation, resume and fork", async inputMode => {
        const starts: Record<string, unknown>[] = [];
        const resumes: Record<string, unknown>[] = [];
        const forks: Record<string, unknown>[] = [];
        const session = await connectSession(version, {
            newSessionMeta: {alwith: {inputMode}},
            codexResponses: {
                "thread/start": async params => {
                    starts.push(params as Record<string, unknown>);
                    return codexResponse("thread/start");
                },
                "thread/resume": async params => {
                    resumes.push(params as Record<string, unknown>);
                    return codexResponse("thread/resume");
                },
                "thread/fork": async params => {
                    forks.push(params as Record<string, unknown>);
                    return {
                        ...(codexResponse("thread/resume") as object),
                        thread: {...createThread(), id: "fork-image", sessionId: "fork-image"},
                    };
                },
            },
        });
        try {
            const check = (params: Record<string, unknown>) => {
                const config = params["config"] as Record<string, unknown>;
                if (inputMode === "image") {
                    expect(config["features.image_generation"]).toBe(false);
                    expect(config["features.imagegenext"]).toBe(false);
                } else {
                    expect(config).not.toHaveProperty("features.image_generation");
                    expect(config).not.toHaveProperty("features.imagegenext");
                }
            };
            check(starts[0]!);
            // Internal provider repairs omit host metadata and must keep the thread's route.
            await session.request("session/resume", {sessionId, cwd: "/workspace", mcpServers: []});
            expect(resumes.length).toBeGreaterThan(0);
            check(resumes.at(-1)!);
            await session.request("session/fork", {sessionId, cwd: "/workspace", mcpServers: []});
            expect(forks).toHaveLength(1);
            check(forks[0]!);
        } finally {
            session.connection.close();
        }
    });
});
