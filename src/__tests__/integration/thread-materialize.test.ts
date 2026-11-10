import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {expect, it} from "vitest";
import {startCodexConnection} from "../../CodexJsonRpcConnection";
import {writeCodexHomeConfig} from "../acp-test-utils";
import {describeIntegration} from "./integration-fixture";

/**
 * A model change before the first message resumes the thread with the new model. Only a thread with a
 * rollout resumes; Codex writes it when the thread is placed in a section, without adding any history.
 */
describeIntegration("integration: rollout of a thread without turns", () => {
    it("writes the rollout without history so the thread resumes with another model", async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-materialize-"));
        writeCodexHomeConfig(home);
        const codex = startCodexConnection(path.resolve("node_modules/.bin/codex"), {...process.env, CODEX_HOME: home});
        const request = <T>(method: string, params: unknown) => codex.connection.sendRequest(method, params) as Promise<T>;
        // Codex reports notLoaded before teardown ends; thread/closed is sent once a resume can load it.
        const unloaded = async (threadId: string) => {
            const closed = new Promise<void>(resolve => {
                const listener = codex.connection.onNotification("thread/closed", (params: {threadId: string}) => {
                    if (params.threadId !== threadId) return;
                    listener.dispose();
                    resolve();
                });
            });
            await request("thread/unsubscribe", {threadId});
            await closed;
        };
        try {
            await request("initialize", {clientInfo: {name: "test", version: "0"}});
            codex.connection.sendNotification("initialized");

            const unwritten = (await request<{thread: {id: string}}>("thread/start", {cwd: home, config: {thread_unload_delay_secs: 0}}))
                .thread.id;
            await unloaded(unwritten);
            await expect(request("thread/resume", {threadId: unwritten, model: "gpt-5.4"})).rejects.toThrow();

            const {thread} = await request<{thread: {id: string}}>("thread/start", {cwd: home, config: {thread_unload_delay_secs: 0}});
            await request("thread/section/move", {threadId: thread.id, sectionId: null});
            await unloaded(thread.id);
            const resumed = await request<{model: string; thread: {id: string}}>("thread/resume", {
                threadId: thread.id,
                model: "gpt-5.4",
            });
            expect(resumed.thread.id).toBe(thread.id);
            expect(resumed.model).toBe("gpt-5.4");
            const turns = await request<{data: unknown[]}>("thread/turns/list", {threadId: thread.id, limit: 10});
            expect(turns.data).toEqual([]);
        } finally {
            codex.connection.dispose();
            codex.process.kill();
            fs.rmSync(home, {recursive: true, force: true});
        }
    });
});
