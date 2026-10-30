import { afterEach, describe, expect, test, vi } from "vitest";
import {
    connectSession,
    codexResponse,
    createThread,
    type PromptSession,
} from "../CodexACPAgent/v2-prompt-harness";

const clients: PromptSession[] = [];
afterEach(() => {
    for (const client of clients.splice(0)) client.connection.close();
});

describe.each([1, 2] as const)(
    "project assignment through ACP v%s",
    (version) => {
        test("folder registration passes the server-generated ID to thread/start and returns it", async () => {
            const start = vi.fn(async () => ({
                ...(codexResponse("thread/start") as object),
                thread: { ...createThread(), projectId: "native-project" },
            }));
            const create = vi.fn(async () => ({
                project: { id: "native-project" },
            }));
            const client = await connectSession(version, {
                codexResponses: {
                    "project/create": create,
                    "thread/start": start,
                },
            });
            clients.push(client);
            expect(create).toHaveBeenCalledTimes(1);
            expect(start).toHaveBeenCalledWith(
                expect.objectContaining({ projectId: "native-project" }),
            );
            const response = await client.request("session/new", {
                cwd: "/another",
                mcpServers: [],
            });
            expect(response._meta.codex.projectId).toBe("native-project");
        });
        test("explicit null creates a projectless session without project registration", async () => {
            const list = vi.fn(async () => {
                throw new Error("must not list");
            });
            const start = vi.fn(async () => ({
                ...(codexResponse("thread/start") as object),
                thread: { ...createThread(), projectId: null },
            }));
            const client = await connectSession(version, {
                newSessionMeta: { codex: { projectId: null } },
                codexResponses: { "project/list": list, "thread/start": start },
            });
            clients.push(client);
            expect(list).not.toHaveBeenCalled();
            expect(start).toHaveBeenCalledWith(
                expect.objectContaining({ projectId: null }),
            );
        });
        test("registration failure does not start an unassigned thread", async () => {
            const client = await connectSession(version, {
                newSessionMeta: { codex: { projectId: null } },
            });
            clients.push(client);
            const start = vi.fn();
            client.setCodexResponse("project/list", async () => {
                throw new Error("project catalog offline");
            });
            client.setCodexResponse("thread/start", start);
            await expect(
                client.request("session/new", { cwd: "/work", mcpServers: [] }),
            ).rejects.toThrow();
            expect(start).not.toHaveBeenCalled();
        });
    },
);
