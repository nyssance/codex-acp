// The to-do ledger: requests the agent sends that await this app's answer (permissions, elicitations).
//
// The protocol-mandated duties every WorkBuddy must do and whose errors users can see: answers carry the original id; when the user hits Stop,
// all unanswered permissions of that session MUST be answered cancelled (otherwise the requests hang in the agent and Runtime forever, and are
// replayed as zombie dialogs on the next takeover); requests the agent retracts itself (`$/cancel_request`) get -32800 and the dialog is dismissed; unknown
// requests get -32601 rather than leaving the agent waiting. This only manages the ledger and the replies; what dialog to show is the app's business.
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

/** A request sent by the agent, same shape as the Runtime's `pendingAgentRequests`. */
export type AgentRequest = { id: unknown; method: string; params: unknown };

/** Sends the reply back to the agent: the `acpRespond` call, with the original `id`. */
export type Reply = (
    id: unknown,
    result?: unknown,
    error?: { code: number; message: string },
) => void;

export type PendingPermission = {
    kind: "permission";
    /** The ledger key: the comparison key of a JSON-RPC id (`9` and `"9"` are two different ids). */
    key: string;
    id: unknown;
    sessionId: string;
    /** The tool call being authorized; null if the authorization is not for a tool call. */
    toolCallId: string | null;
    params: acp.RequestPermissionRequest;
    at: number;
};

export type PendingElicitation = {
    kind: "elicitation";
    key: string;
    id: unknown;
    /** In the protocol an elicitation need not belong to a session; alwith-cli includes a sessionId. */
    sessionId: string | null;
    /** Always present in url mode; the protocol has none in form mode, alwith-cli happens to include one. Without it, answer by key. */
    elicitationId: string | null;
    params: acp.CreateElicitationRequest;
    at: number;
};

export type PendingRequest = PendingPermission | PendingElicitation;

/** JSON-RPC: a request retracted by `$/cancel_request` MUST be answered with this (or a valid response). */
export const REQUEST_CANCELLED = -32800;
export const METHOD_NOT_FOUND = -32601;

export function requestKey(id: unknown): string {
    return JSON.stringify(id) ?? String(id);
}

export class AgentRequests {
    private readonly items = new Map<string, PendingRequest>();
    private readonly changed = new Set<(pending: PendingRequest[]) => void>();
    private readonly received = new Set<(request: PendingRequest) => void>();
    private readonly withdrawn = new Set<(request: PendingRequest) => void>();
    private readonly reply: Reply;

    constructor(reply: Reply) {
        this.reply = reply;
    }

    list(): PendingRequest[] {
        return [...this.items.values()];
    }

    forSession(sessionId: string): PendingRequest[] {
        return this.list().filter((request) => request.sessionId === sessionId);
    }

    get(key: string): PendingRequest | undefined {
        return this.items.get(key);
    }

    permissionFor(toolCallId: string): PendingPermission | undefined {
        for (const request of this.items.values()) {
            if (
                request.kind === "permission" &&
                request.toolCallId === toolCallId
            )
                return request;
        }
        return undefined;
    }

    elicitation(elicitationId: string): PendingElicitation | undefined {
        for (const request of this.items.values()) {
            if (
                request.kind === "elicitation" &&
                request.elicitationId === elicitationId
            )
                return request;
        }
        return undefined;
    }

    /** The ledger changed (arrived, answered, retracted, released): the app renders from this. */
    onChange(listener: (pending: PendingRequest[]) => void): () => void {
        this.changed.add(listener);
        return () => this.changed.delete(listener);
    }

    /** An entry newly in the ledger (just received, or replayed on takeover): the app shows a dialog / opens an auth page from this. */
    onReceived(listener: (request: PendingRequest) => void): () => void {
        this.received.add(listener);
        return () => this.received.delete(listener);
    }

    /** An entry retracted by the agent (`$/cancel_request`): the original request was answered -32800; the app dismisses the dialog. */
    onWithdrawn(listener: (request: PendingRequest) => void): () => void {
        this.withdrawn.add(listener);
        return () => this.withdrawn.delete(listener);
    }

    /**
     * Receives an agent request. Permissions and elicitations are recorded in the ledger; others (fs, terminal, ...) this app does not do, and get -32601: without a reply
     * the agent would be stuck on that request. `pendingAgentRequests` handed over by the Runtime on takeover also enter here, treated as just received.
     */
    receive(request: AgentRequest): void {
        const key = requestKey(request.id);
        if (request.method === "session/request_permission") {
            const params = request.params as acp.RequestPermissionRequest;
            // sessionId is required by the protocol: without it we cannot cancel per session in bulk, so blow up instead of recording an ownerless one
            if (typeof params?.sessionId !== "string")
                throw new Error(
                    `session/request_permission is missing sessionId: ${key}`,
                );
            const subject = params.subject as
                | { type?: string; toolCall?: { toolCallId?: unknown } }
                | undefined;
            const toolCallId =
                typeof subject?.toolCall?.toolCallId === "string"
                    ? subject.toolCall.toolCallId
                    : null;
            const pending: PendingPermission = {
                kind: "permission",
                key,
                id: request.id,
                sessionId: params.sessionId,
                toolCallId,
                params,
                at: Date.now(),
            };
            this.items.set(key, pending);
            this.emit();
            for (const listener of [...this.received]) listener(pending);
            return;
        }
        if (request.method === "elicitation/create") {
            const params = request.params as acp.CreateElicitationRequest & {
                sessionId?: unknown;
                elicitationId?: unknown;
            };
            const pending: PendingElicitation = {
                kind: "elicitation",
                key,
                id: request.id,
                sessionId:
                    typeof params?.sessionId === "string"
                        ? params.sessionId
                        : null,
                elicitationId:
                    typeof params?.elicitationId === "string"
                        ? params.elicitationId
                        : null,
                params,
                at: Date.now(),
            };
            this.items.set(key, pending);
            this.emit();
            for (const listener of [...this.received]) listener(pending);
            return;
        }
        this.reply(request.id, undefined, {
            code: METHOD_NOT_FOUND,
            message: `method not found: ${request.method}`,
        });
    }

    receiveAll(requests: AgentRequest[]): void {
        for (const request of requests) this.receive(request);
    }

    /** Answers one, by ledger key. If it is no longer in the ledger (answered, retracted, released) returns false and sends nothing. */
    answer(key: string, result: unknown): boolean {
        const request = this.items.get(key);
        if (request === undefined) return false;
        this.items.delete(key);
        this.reply(request.id, result);
        this.emit();
        return true;
    }

    answerPermission(
        toolCallId: string,
        outcome: acp.RequestPermissionOutcome,
        meta?: Record<string, unknown> | null,
    ): boolean {
        const request = this.permissionFor(toolCallId);
        if (request === undefined) return false;
        return this.answer(
            request.key,
            meta ? { outcome, _meta: meta } : { outcome },
        );
    }

    /**
     * The two agent notifications relevant to the ledger:
     * - `$/cancel_request`: the agent retracts a request it sent (session/cancel cascades to permissions and elicitations). Spec: the receiver
     *   MUST answer the original request with a valid response or -32800. We answer -32800, remove it from the ledger, and notify the app to dismiss the dialog. An unrecognized id is a no-op
     *   (the original request may already be answered, as when the Stop path answers cancelled first and then sends session/cancel).
     * - `elicitation/complete`: a url-mode elicitation finished on the agent's side. If it is still in the ledger (the app has not answered), close it
     *   on the app's behalf: the user already finished in the browser, and asking again would be asking into the void.
     */
    onNotification(method: string, params: unknown): void {
        if (method === "$/cancel_request") {
            const requestId = (params as { requestId?: unknown } | undefined)
                ?.requestId;
            if (requestId === undefined)
                throw new Error("$/cancel_request is missing requestId");
            const key = requestKey(requestId);
            const request = this.items.get(key);
            if (request === undefined) return;
            this.items.delete(key);
            this.reply(request.id, undefined, {
                code: REQUEST_CANCELLED,
                message: "Request cancelled",
            });
            for (const listener of this.withdrawn) listener(request);
            this.emit();
            return;
        }
        if (method === "elicitation/complete") {
            const elicitationId = (
                params as { elicitationId?: unknown } | undefined
            )?.elicitationId;
            if (typeof elicitationId !== "string") return;
            const request = this.elicitation(elicitationId);
            if (request !== undefined)
                this.answer(request.key, { action: "cancel" });
        }
    }

    /**
     * The user stopped this turn (Stop): all unanswered permissions of the session are answered cancelled (spec: "The Client MUST respond
     * to all pending session/request_permission requests with the cancelled outcome"), elicitations with cancel
     * - cancel means "the client itself cannot continue", decline means "the user does not want to answer"; the protocol has two separate words for them.
     */
    cancelSession(sessionId: string): void {
        for (const request of this.forSession(sessionId)) {
            this.items.delete(request.key);
            this.reply(
                request.id,
                request.kind === "permission"
                    ? { outcome: { outcome: "cancelled" } }
                    : { action: "cancel" },
            );
        }
        this.emit();
    }

    /**
     * No longer holds these requests and answers none of them: the process is handed to another window to take over (it gets the same replay from the Runtime), or
     * the process is already gone (answers could not be delivered). Returns the ones released, so the app can dismiss dialogs.
     */
    release(): PendingRequest[] {
        const released = this.list();
        this.items.clear();
        this.emit();
        return released;
    }

    private emit(): void {
        const pending = this.list();
        for (const listener of this.changed) listener(pending);
    }
}
