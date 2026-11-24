// `@nyssance/codex-acp-v2/client`: what an app needs to talk to this adapter from the browser or
// Node, using @alwith/api only for Runtime transport and generic state. Nothing here starts a process.
export {CodexCapabilitiesClient, supportsCodexRealtime} from "./CodexCapabilitiesClient";
export type {CodexCapabilitiesConnection, RealtimeEvent, RealtimeStart} from "./CodexCapabilitiesClient";
export {CodexClient} from "./CodexClient";
export type {CodexClientState, ForkOptions, ForkOrigin} from "./CodexClient";
export * from "./codex-extensions";
export type {HistoryRequest} from "./history";
export {nativeTurnId} from "./history-navigation";
export type {HistoryNavigationState, HistoryTurnPreview, HistoryTurnSummary} from "./history-navigation";
export {prependHistory, projectHistoryTurns, readHistoryPage} from "./history-page";
export type {BrowseHistoryRequest, HistoryPageState} from "./history-page";
export {latestAssistantReply} from "./activity-preview";

export * from "./protocol";

export {
    sessionGroup,
    groupSessions,
    projectName,
    isQuickChatDirectory,
    normalizedPath,
    QUICK_CHATS_GROUP,
} from "../projects/projection";
export type {ProjectContext, SessionGroup} from "../projects/projection";

