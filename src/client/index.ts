// `@nyssance/codex-acp-v2/client`: what an app needs to talk to this adapter from the browser or
// Node, using @alwith/api only for Runtime transport and generic state. Nothing here starts a process.
export {
    CodexCapabilitiesClient,
    supportsCodexRealtime,
} from "./CodexCapabilitiesClient";
export type {
    BedrockDiscoverResponse,
    BedrockSetupParams,
    CodexCapabilitiesConnection,
    GoalSnapshot,
    HooksListEntry,
    PermissionProfileSummary,
    RealtimeAudio,
    RealtimeEvent,
    RealtimeStart,
    RealtimeTextRole,
} from "./CodexCapabilitiesClient";
export { CodexClient } from "./CodexClient";
export type { CodexClientState, ForkOptions, ForkOrigin } from "./CodexClient";
export * from "./codex-extensions";
export { exportConversation } from "./history";
export type { HistoryRequest } from "./history";
export {
    historyTurnPreview,
    mergeNavigationHistory,
    nativeTurnId,
    readHistoryIndex,
    readHistoryTurn,
} from "./history-navigation";
export type {
    HistoryNavigationState,
    HistoryTurnPreview,
    HistoryTurnSummary,
} from "./history-navigation";
export {
    prependHistory,
    projectHistoryTurns,
    readHistoryPage,
} from "./history-page";
export type { BrowseHistoryRequest, HistoryPageState } from "./history-page";
export { latestAssistantReply, readActivityReply } from "./activity-preview";

export * from "./protocol";

export { sessionGroup, groupSessions, projectName, isQuickChatDirectory, matchingProject, normalizedPath, pathContains, QUICK_CHATS_GROUP } from "../projects/projection";
export type { ProjectContext, SessionGroup } from "../projects/projection";
