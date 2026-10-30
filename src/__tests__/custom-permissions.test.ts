import { describe, expect, it } from "vitest";
import { AgentMode } from "../AgentMode";
import { hostThreadOptions } from "../alwith/hostSession";
import type { SandboxPolicy } from "../app-server/v2";

describe("restored custom permissions", () => {
    it.each<SandboxPolicy>([
        { type: "readOnly", networkAccess: false },
        {
            type: "workspaceWrite",
            writableRoots: ["/custom"],
            networkAccess: true,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
        },
        { type: "externalSandbox", networkAccess: "enabled" },
    ])("preserves the actual policy for $type", (sandbox) => {
        const thread = {
            approvalPolicy: "never" as const,
            approvalsReviewer: "auto_review" as const,
            sandbox,
        };
        const mode = AgentMode.fromThread(thread);
        expect(mode.id).toBe("custom");
        expect(mode.approvalPolicy).toEqual(thread.approvalPolicy);
        expect(mode.approvalsReviewer).toBe(thread.approvalsReviewer);
        expect(mode.sandboxPolicy).toEqual(sandbox);
        expect(mode.toConfigOption(false).currentValue).toBe("custom");
        expect(
            mode
                .toSessionModeState(false)
                .availableModes.some((m) => m.id === "custom"),
        ).toBe(true);
        expect(hostThreadOptions({ codex: { mode: mode.id } })).toEqual({});
    });
    it.each(AgentMode.all())("keeps the exact preset $id", (mode) => {
        expect(
            AgentMode.fromThread({
                approvalPolicy: mode.approvalPolicy,
                approvalsReviewer: mode.approvalsReviewer,
                sandbox: mode.sandboxPolicy,
            }),
        ).toBe(mode);
    });
});
