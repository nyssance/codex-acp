import { describe, expect, it } from "vitest";
import { AgentMode } from "../../AgentMode";
import { codexResponse, connectSession, sessionId } from "./v2-prompt-harness";
import { testThreadPermissions } from "../native-thread-permissions";

for (const protocol of [1, 2] as const) {
    describe(`permission persistence over ACP ${protocol}`, () => {
        it.each(AgentMode.all())(
            "persists $id before confirming the mode",
            async (mode) => {
                const client = await connectSession(protocol);
                try {
                    const initial =
                        client.agent.getSessionState(sessionId).agentMode;
                    let sent: unknown;
                    client.setCodexResponse(
                        "thread/settings/update",
                        async (params) => {
                            expect(
                                client.agent.getSessionState(sessionId)
                                    .agentMode,
                            ).toBe(initial);
                            sent = params;
                            return {};
                        },
                    );
                    await client.agent.setSessionMode({
                        sessionId,
                        modeId: mode.id,
                    });
                    expect(sent).toMatchObject({
                        threadId: sessionId,
                        approvalPolicy: mode.approvalPolicy,
                        approvalsReviewer: mode.approvalsReviewer,
                        sandboxPolicy: mode.sandboxPolicy,
                    });
                    expect(
                        client.agent.getSessionState(sessionId).agentMode,
                    ).toBe(mode);
                } finally {
                    client.connection.close();
                }
            },
        );
        it.each(AgentMode.all())(
            "restores native $id through session/resume",
            async (mode) => {
                const client = await connectSession(protocol);
                try {
                    client.setCodexResponse("thread/resume", async () => ({
                        ...(codexResponse("thread/resume") as object),
                        ...testThreadPermissions(mode),
                    }));
                    await client.request("session/resume", {
                        sessionId,
                        cwd: "/workspace",
                        mcpServers: [],
                    });
                    expect(
                        client.agent.getSessionState(sessionId).agentMode,
                    ).toBe(mode);
                } finally {
                    client.connection.close();
                }
            },
        );
        it("preserves the confirmed mode when native settings are rejected", async () => {
            const client = await connectSession(protocol);
            try {
                const initial =
                    client.agent.getSessionState(sessionId).agentMode;
                client.setCodexResponse("thread/settings/update", async () => {
                    throw new Error("Settings rejected");
                });
                await expect(
                    client.agent.setSessionMode({
                        sessionId,
                        modeId: "read-only",
                    }),
                ).rejects.toThrow("Settings rejected");
                expect(client.agent.getSessionState(sessionId).agentMode).toBe(
                    initial,
                );
            } finally {
                client.connection.close();
            }
        });
    });
}
it.each(AgentMode.all())("restores persisted $id settings", (mode) => {
    expect(AgentMode.fromThread(testThreadPermissions(mode))).toBe(mode);
});
it("keeps a named profile instead of replacing it with a preset", () => {
    const mode = AgentMode.fromThread({
        ...testThreadPermissions(),
        activePermissionProfile: { id: "team" },
    });
    expect(mode.permissionProfile).toBe("team");
    expect(mode.id).toBe("profile:team");
});
