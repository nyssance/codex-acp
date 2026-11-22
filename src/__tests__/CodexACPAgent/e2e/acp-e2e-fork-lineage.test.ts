import {once} from "node:events";
import {copyFileSync, mkdtempSync, mkdirSync, rmSync} from "node:fs";
import {homedir, tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it, vi} from "vitest";
import {CodexAcpClient} from "../../../CodexAcpClient";
import {CodexAcpServer} from "../../../CodexAcpServer";
import {CodexAppServerClient} from "../../../CodexAppServerClient";
import {startCodexConnection} from "../../../CodexJsonRpcConnection";
import {AcpV2Connection} from "../../../ACPSessionConnection";

const live = process.env["RUN_E2E_TESTS"] === "true" ? it : it.skip;

// ACP v1 responses carry no lineage, so the boundary is checked on v2.
live(
    "fork boundary survives continuation and restart",
    async () => {
        const binary = process.env["CODEX_PATH"];
        const root = mkdtempSync(join(tmpdir(), "codex-acp-live-fork-"));
        const home = join(root, "home");
        const cwd = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(cwd);
        copyFileSync(join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json"), join(home, "auth.json"));
        vi.stubEnv("CODEX_HOME", home);
        async function start() {
            const connection = startCodexConnection(binary, {
                ...process.env,
                CODEX_HOME: home,
            });
            const codex = new CodexAppServerClient(connection.connection);
            const client = new CodexAcpClient(codex);
            const output = new AcpV2Connection({
                notify: async () => {},
                request: async () => {
                    throw new Error("The fork test must not request tools or permissions");
                },
            });
            const agent = new CodexAcpServer(output, client, undefined, () => connection.process.exitCode);
            await agent.initializeV2({
                protocolVersion: 2,
                info: {name: "fork-test", version: "1"},
                capabilities: {},
            });
            return {connection, codex, agent};
        }
        type Running = Awaited<ReturnType<typeof start>>;
        async function stop(running: Running) {
            running.connection.connection.end();
            if (running.connection.process.exitCode === null) {
                const exited = once(running.connection.process, "exit");
                running.connection.process.kill();
                await exited;
            }
        }
        let running: Running | undefined;
        try {
            running = await start();
            const params = {
                cwd,
                mcpServers: [],
                _meta: {codex: {mode: "read-only"}},
            };
            const parent = await running.agent.newSessionV2(params);
            async function prompt(id: string, marker: string) {
                await running!.agent.prompt({
                    sessionId: id,
                    prompt: [
                        {
                            type: "text",
                            text: `Reply with exactly ${marker}. Do not use tools.`,
                        },
                    ],
                });
            }
            await prompt(parent.sessionId, "FORK_BOUNDARY");
            const turns = await running.codex.threadTurnsList({
                threadId: parent.sessionId,
                sortDirection: "asc",
                itemsView: "full",
            });
            const boundary = turns.data.at(-1)!.id;
            await prompt(parent.sessionId, "PARENT_LATER");
            const forkParams = {
                ...params,
                sessionId: parent.sessionId,
                _meta: {codex: {lastTurnId: boundary}},
            };
            const fork = await running.agent.forkSessionV2(forkParams);
            const lineage = {
                forkedFromId: parent.sessionId,
                forkedAtTurnId: boundary,
            };
            expect(fork._meta).toMatchObject({codex: lineage});
            const inherited = await running.codex.threadTurnsList({
                threadId: fork.sessionId,
                sortDirection: "asc",
                itemsView: "full",
            });
            expect(inherited.data.map(turn => turn.id)).toEqual(turns.data.map(turn => turn.id));
            await prompt(fork.sessionId, "CHILD_CONTINUED");
            const source = await running.codex.threadTurnsList({
                threadId: parent.sessionId,
                itemsView: "full",
            });
            expect(JSON.stringify(source.data)).not.toContain("CHILD_CONTINUED");
            await stop(running);
            running = undefined;
            running = await start();
            const resumed = await running.agent.resumeSessionV2({
                cwd,
                sessionId: fork.sessionId,
                replayFrom: {type: "start"},
            });
            expect(resumed._meta).toMatchObject({codex: lineage});
            const persisted = await running.codex.threadTurnsList({
                threadId: fork.sessionId,
                itemsView: "full",
            });
            expect(JSON.stringify(persisted.data)).toContain("CHILD_CONTINUED");
            const contextOnly = await running.agent.resumeSessionV2({
                cwd,
                sessionId: fork.sessionId,
                replayFrom: null,
            });
            expect(contextOnly._meta).toMatchObject({codex: lineage});
        } finally {
            if (running) await stop(running);
            vi.unstubAllEnvs();
            rmSync(root, {recursive: true, force: true});
        }
    },
    180_000,
);
