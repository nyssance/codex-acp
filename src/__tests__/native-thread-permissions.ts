import { AgentMode } from "../AgentMode";

/** Native settings included in start, resume, and fork responses. */
export function testThreadPermissions(mode = AgentMode.Agent) {
    return {
        approvalPolicy: mode.approvalPolicy,
        approvalsReviewer: mode.approvalsReviewer,
        sandbox: mode.sandboxPolicy,
        activePermissionProfile: null,
    };
}
