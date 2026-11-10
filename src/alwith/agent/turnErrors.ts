import {readableServiceErrorMessage} from "../../ServiceErrorMessage";
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type {TurnError} from "../../app-server/v2";
import {codexFailureKind, SESSION_FAILURE_POLICY} from "../../CodexFailures";

/**
 * One stable transcript item per native failed turn, shared by live output and replay. The failure
 * classification is the adapter's own (`CodexFailures`), the one its AIR session failures use.
 */
export function turnErrorUpdate(turnId: string, error: TurnError): Extract<acp.SessionUpdate, {sessionUpdate: "agent_message"}> {
    const kind = codexFailureKind(error);
    const readable = readableServiceErrorMessage(error.message);
    const message = error.additionalDetails ? `${readable}\n\n${error.additionalDetails}` : readable;
    return {
        sessionUpdate: "agent_message",
        messageId: `codex-error:${turnId}`,
        content: [{type: "text", text: message}],
        _meta: {
            codex: {
                turnId,
                error: {kind, ...SESSION_FAILURE_POLICY[kind], ...error},
            },
        },
    };
}
