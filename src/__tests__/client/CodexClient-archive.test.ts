import { expect, test, vi } from "vitest";
import { CodexClient } from "../../client/CodexClient";

const projectContext = {
    projects: [],
    homeDirectory: "/home",
    chatDirectory: "/home/chats",
    codexChatDirectory: "/home/.codex/chats",
};

function client(answer: (method: string, params: Record<string, unknown>) => unknown) {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) =>
        method === "_codex/project_context" ? projectContext : answer(method, params),
    );
    const codex = new CodexClient(() => Promise.reject(new Error("not connected")), {
        agentId: "agent",
        launch: { engine: "codex" },
    });
    const agent = { request };
    Object.assign(codex, { agent, live: () => agent });
    return { codex, request };
}

function seed(codex: CodexClient) {
    (codex as unknown as { set(patch: { sessionList: unknown[] }): void }).set({ sessionList: [row] });
}

const row = { sessionId: "a", cwd: "/work", title: "Old", updatedAt: null, archived: false };

test("archives, unarchives and lists the archive with the standard ACP methods", async () => {
    const { codex, request } = client((method) =>
        method === "session/list"
            ? { sessions: [{ sessionId: "b", cwd: "/work", archived: true }], nextCursor: null }
            : {},
    );
    seed(codex);
    await codex.archive("a");
    expect(request).toHaveBeenCalledWith("session/archive", { sessionId: "a" });
    expect(codex.state.sessionList).toEqual([]);
    expect(codex.state.archivedSessions).toEqual([{ ...row, archived: true }]);

    await codex.unarchive("a");
    expect(request).toHaveBeenCalledWith("session/unarchive", { sessionId: "a" });
    expect(codex.state.sessionList).toEqual([row]);

    await codex.listArchived({ reset: true });
    expect(request).toHaveBeenCalledWith("session/list", { archived: "only" });
    expect(codex.state.archivedSessions.map((item) => [item.sessionId, item.archived])).toEqual([["b", true]]);
});

test("renames with session/set_title and keeps the title the agent stored", async () => {
    const { codex, request } = client(() => ({ title: "New" }));
    seed(codex);
    await codex.renameSession("a", "  New  ");
    expect(request).toHaveBeenCalledWith("session/set_title", { sessionId: "a", title: "  New  " });
    expect(codex.state.sessionList[0]?.title).toBe("New");
});
