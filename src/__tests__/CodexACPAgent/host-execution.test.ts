import {describe, expect, it, vi} from "vitest";
import {applicationContextOf, nativeToolsOf, nativeToolsConfig} from "../../alwith/codex/hostExecution";
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

it.each([false, "invalid", 3])("rejects malformed context: %j", applicationContext => {
    expect(() => applicationContextOf({alwith: {applicationContext}})).toThrow("applicationContext");
});
it("keeps omitted context unchanged and supports explicit per-key clearing", () => {
    expect(applicationContextOf(undefined)).toBeUndefined();
    expect(applicationContextOf({alwith: {applicationContext: {task: null}}})).toEqual({task: {kind: "application", value: ""}});
    expect(() => applicationContextOf({alwith: {applicationContext: {task: {}}}})).toThrow("entry");
});
it("validates native capability settings without interpreting input modes", () => {
    expect(nativeToolsOf({alwith: {inputMode: "future-mode"}})).toBeUndefined();
    expect(nativeToolsConfig(nativeToolsOf({alwith: {nativeTools: {}}}))).toEqual({});
    expect(() => nativeToolsOf({alwith: {nativeTools: {unknown: false}}})).toThrow("nativeTools");
    expect(() => nativeToolsOf({alwith: {nativeTools: {imageGeneration: "false"}}})).toThrow("nativeTools");
});

describe.each([2] as const)("ACP v%s application context", version => {
    it.each(["first", "replacement", null] as const)("delivers %s intent separately from user text and attachments", async contextValue => {
        const session = await connectSession(version);
        const prompt = [
            {type: "text" as const, text: "Keep the original wording"},
            {type: "image" as const, mimeType: "image/png", data: "aGVsbG8="},
        ];
        try {
            const response = session.request("session/prompt", {sessionId, prompt, _meta: {alwith: {applicationContext: {task: contextValue}}}});
            await vi.waitFor(() => expect(session.turnStartParams).toHaveLength(1));
            const params = session.turnStartParams[0]!;
            expect(params["input"]).toEqual([
                {type: "text", text: "Keep the original wording", text_elements: []},
                {type: "image", url: "data:image/png;base64,aGVsbG8="},
            ]);
            expect(params["additionalContext"]).toEqual(applicationContextOf({alwith: {applicationContext: {task: contextValue}}}));
            session.emit(turnStarted(turnId));
            session.emit(itemCompleted(userMessageItem(params["clientUserMessageId"] as string), turnId));
            session.emit(turnCompleted(turnId));
            await response;
        } finally {
            session.connection.close();
        }
    });
});

it("keeps application context on a message steered into an active v2 turn", async () => {
    const session = await connectSession(2);
    try {
        const first = session.request("session/prompt", {
            sessionId,
            prompt: [{type: "text", text: "A tree"}],
            _meta: {alwith: {applicationContext: {task: "first"}}},
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
            _meta: {alwith: {applicationContext: {task: "replacement"}}},
        });
        expect(steered).toMatchObject({
            input: [{type: "text", text: "Make it blue", text_elements: []}],
            additionalContext: applicationContextOf({alwith: {applicationContext: {task: "replacement"}}}),
        });
        session.emit(turnCompleted(turnId));
    } finally {
        session.connection.close();
    }
});

describe.each([2] as const)("ACP v%s native tool capabilities", version => {
    it.each([{}, {imageGeneration: false}] as const)("keeps %s routing across creation, resume and fork", async nativeTools => {
        const starts: Record<string, unknown>[] = [];
        const resumes: Record<string, unknown>[] = [];
        const forks: Record<string, unknown>[] = [];
        const session = await connectSession(version, {
            newSessionMeta: {alwith: {nativeTools}},
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
                if ("imageGeneration" in nativeTools) {
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
