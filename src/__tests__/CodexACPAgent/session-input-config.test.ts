import {describe, expect, it, vi} from "vitest";
import type {ThreadAttachment, ThreadAttachmentAddParams, ThreadAttachmentListParams} from "../../app-server/v2";
import {codexResponse, connectSession, createThread, sessionId} from "./v2-prompt-harness";

describe.each([2] as const)("ACP v%s native session inputConfig", version => {
    it("keeps clients that omit image routing unchanged", async () => {
        const read = vi.fn(async () => ({data: [], nextCursor: null}));
        const session = await connectSession(version, {codexResponses: {"thread/attachment/list": read}});
        try {
            await session.request("session/resume", {sessionId, cwd: "/workspace", mcpServers: []});
            expect(read).not.toHaveBeenCalled();
        } finally { session.connection.close(); }
    });
    it("stores opaque configuration without deriving execution policy and copies it on fork", async () => {
        const attachments = new Map<string, ThreadAttachment[]>();
        let resumeConfig: Record<string, unknown> = {};
        const session = await connectSession(version, {
            newSessionMeta: {alwith: {nativeTools: {}}},
            codexResponses: {
                "thread/attachment/list": async value => ({data: attachments.get((value as ThreadAttachmentListParams).threadId) ?? [], nextCursor: null}),
                "thread/attachment/add": async value => {
                    const params = value as ThreadAttachmentAddParams;
                    const rows = attachments.get(params.threadId) ?? [];
                    const existing = rows.find(row => row.identityKey === params.identityKey);
                    if (existing) return {outcome: "existing", attachment: existing};
                    const attachment = {id: crypto.randomUUID(), attachmentType: params.attachmentType, identityKey: params.identityKey, payload: params.payload, createdAt: 1};
                    attachments.set(params.threadId, [...rows, attachment]);
                    return {outcome: "created", attachment};
                },
                "thread/resume": async value => {
                    resumeConfig = (value as {config: Record<string, unknown>}).config;
                    return codexResponse("thread/resume");
                },
                "thread/fork": async () => ({...(codexResponse("thread/resume") as object), thread: {...createThread(), id: "fork-image", sessionId: "fork-image"}}),
            },
        });
        try {
            expect(await session.request("_codex/session_input_config_get", {sessionId})).toMatchObject({inputConfig: null, revision: 0});
            const inputConfig = {mode: "image", config: {model: "wham", size: "auto"}};
            expect(await session.request("_codex/session_input_config_set", {sessionId, inputConfig})).toMatchObject({inputConfig, revision: 1});
            await session.request("session/resume", {sessionId, cwd: "/workspace", mcpServers: [], _meta: {alwith: {nativeTools: {}}}});
            expect(resumeConfig).not.toHaveProperty("features.image_generation");
            expect(resumeConfig).not.toHaveProperty("features.imagegenext");
            await session.request("session/resume", {sessionId, cwd: "/workspace", mcpServers: [], _meta: {alwith: {nativeTools: {imageGeneration: false}}}});
            expect(resumeConfig["features.image_generation"]).toBe(false);
            expect(resumeConfig["features.imagegenext"]).toBe(false);
            await session.request("session/fork", {sessionId, cwd: "/workspace", mcpServers: []});
            expect(await session.request("_codex/session_input_config_get", {sessionId: "fork-image"})).toMatchObject({inputConfig, revision: 1});
            await session.request("_codex/session_input_config_set", {sessionId: "fork-image", inputConfig: {mode: "chat", config: {}}});
            expect(await session.request("_codex/session_input_config_get", {sessionId})).toMatchObject({inputConfig, revision: 1});
        } finally {
            session.connection.close();
        }
    });
});

it.each(["source-read", "target-read", "target-write"] as const)("releases failed forks after %s errors without touching the source subscription", async failure => {
    const fork = vi.fn(async () => ({...(codexResponse("thread/resume") as object), thread: {...createThread(), id: "failed-fork", sessionId: "failed-fork"}}));
    const unsubscribe = vi.fn(async () => ({}));
    const add = vi.fn(async () => { throw new Error("target write failed"); });
    const session = await connectSession(2, {
        codexResponses: {
            "thread/fork": fork,
            "thread/unsubscribe": unsubscribe,
            "thread/attachment/list": async value => {
                const {threadId} = value as ThreadAttachmentListParams;
                if (threadId === sessionId) {
                    if (failure === "source-read") throw new Error("source read failed");
                    return {data: [{id: "input", attachmentType: "alwith.session-input.v2", identityKey: "1", payload: {mode: "image", config: {model: "wham", size: "auto"}}, createdAt: 1}], nextCursor: null};
                }
                if (failure === "target-read") throw new Error("target read failed");
                return {data: [], nextCursor: null};
            },
            "thread/attachment/add": add,
        },
    });
    try {
        await expect(session.request("session/fork", {sessionId, cwd: "/workspace", mcpServers: []})).rejects.toThrow();
        if (failure === "source-read") {
            expect(fork).not.toHaveBeenCalled();
            expect(unsubscribe).not.toHaveBeenCalled();
        } else {
            expect(fork).toHaveBeenCalledTimes(1);
            expect(unsubscribe).toHaveBeenCalledExactlyOnceWith({threadId: "failed-fork"});
        }
        expect(add).toHaveBeenCalledTimes(failure === "target-write" ? 1 : 0);
    } finally { session.connection.close(); }
});
