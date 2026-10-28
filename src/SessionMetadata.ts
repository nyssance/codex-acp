import type { AgentMode } from "./AgentMode";
import type { ApprovalsReviewer } from "./app-server/v2/ApprovalsReviewer";
import type { ModeKind } from "./app-server/ModeKind";
import type {
    Model,
    Thread,
    ThreadItemEntry,
    ThreadStatus,
} from "./app-server/v2";
import type { SessionInstructions } from "./ClientSystemPrompt";

export type SessionMetadata = {
    sessionId: string;
    agentMode?: AgentMode | undefined;
    readOnly?: boolean;
    lineage?: {
        projectId?: string | null;
        nativeSessionId: string | null;
        forkedFromId: string | null;
        forkedAtTurnId?: string | null;
    };
    permissionProfile?: string | null | undefined;
    approvalsReviewer?: ApprovalsReviewer | undefined;
    currentModelId: string;
    models: Model[];
    collaborationMode: ModeKind;
    modelProvider?: string | null;
    currentServiceTier?: string | null;
    threadStatus?: ThreadStatus;
    additionalDirectories: string[];
    skippedMcpServers?: string[];
    instructions?: SessionInstructions;
};

export type SessionMetadataWithThread = SessionMetadata & {
    /** The thread metadata. Its `turns` are empty: the items are in `history`. */
    thread: Thread;
    /** The items of the thread with their turns, oldest first, one page at a time. */
    history: AsyncIterable<ThreadItemEntry[]>;
};
