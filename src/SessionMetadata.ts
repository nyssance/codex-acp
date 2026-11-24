import type {AgentMode} from "./AgentMode";
import type {ModeKind} from "./app-server/ModeKind";
import type {
    ApprovalsReviewer,
    AskForApproval,
    Model,
    PermissionProfileSummary,
    Thread,
    ThreadItemEntry,
    ThreadStatus,
} from "./app-server/v2";
import type {SessionInstructions} from "./ClientSystemPrompt";
import type {McpStartupFailure} from "./mcp/McpStartupTracker";

export type SessionOptionMetadata = {
    currentModelId: string,
    models: Model[],
    collaborationMode: ModeKind,
    currentServiceTier?: string | null,
    activePermissionProfileId?: string | null,
    approvalPolicy?: AskForApproval,
    approvalsReviewer?: ApprovalsReviewer,
    permissionProfiles?: PermissionProfileSummary[],
};

export type SessionMetadata = SessionOptionMetadata & {
    sessionId: string,
    agentMode?: AgentMode | undefined,
    readOnly?: boolean,
    lineage?: {
        projectId?: string | null,
        nativeSessionId: string | null,
        forkedFromId: string | null,
        forkedAtTurnId?: string | null,
    },
    permissionProfile?: string | null | undefined,
    /** The thread's own reviewer; `approvalsReviewer` is the configured default for profile modes. */
    threadApprovalsReviewer?: ApprovalsReviewer | undefined,
    modelProvider?: string | null,
    threadStatus?: ThreadStatus,
    additionalDirectories: string[],
    skippedMcpServers?: string[],
    mcpStartupFailures?: McpStartupFailure[],
    instructions?: SessionInstructions,
    sessionTitle?: string | null,
}

export type SessionMetadataWithThread = SessionMetadata & {
    /** The thread metadata. Its `turns` are empty: the items are in `history`. */
    thread: Thread,
    /** The items of the thread with their turns, oldest first, one page at a time. */
    history: AsyncIterable<ThreadItemEntry[]>,
}
