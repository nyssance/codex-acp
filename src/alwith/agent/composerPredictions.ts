import type { ReasoningEffort } from "../../app-server/ReasoningEffort";
import type { AppServerClient } from "../codex/AppServerClient";
import { logger } from "../../Logger";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";
type ClientSession = { update(value: SessionUpdate): Promise<void> };

const PROMPT = `Suggest the single most likely next message the user would send in this conversation, in the user's language and voice. Keep it short and directly useful. If the next step is unclear or the conversation is finished, use null. Do not answer the suggestion, perform work, or use tools. Return only JSON: {"suggestion": "short message"} or {"suggestion": null}.`;

/** Ephemeral Codex threads are never installed as ACP sessions or forwarded to the UI. */
export class ComposerPredictions {
    private readonly jobs = new Map<string, AbortController>();
    constructor(private readonly codex: AppServerClient) {}

    cancel(sessionId: string): void {
        this.jobs.get(sessionId)?.abort();
        this.jobs.delete(sessionId);
    }

    start(
        sessionId: string,
        sourceTurnId: string,
        client: ClientSession,
        lifetime: AbortSignal,
        effort?: ReasoningEffort,
    ): void {
        this.cancel(sessionId);
        const job = new AbortController();
        this.jobs.set(sessionId, job);
        void this.generate(
            sessionId,
            sourceTurnId,
            client,
            lifetime,
            job,
            effort,
        ).catch((error) => logger.error("Composer prediction failed", error));
    }

    private async generate(
        sessionId: string,
        sourceTurnId: string,
        client: ClientSession,
        lifetime: AbortSignal,
        job: AbortController,
        effort?: ReasoningEffort,
    ): Promise<void> {
        const codex = this.codex.snapshot();
        const timeout = new AbortController();
        const timer = setTimeout(
            () => timeout.abort(new Error("Prediction timed out after 60 seconds")),
            60_000,
        );
        const signal = AbortSignal.any([
            job.signal,
            lifetime,
            codex.disconnectSignal,
            timeout.signal,
        ]);
        let forkId: string | undefined;
        let text: string | undefined;
        const stop = codex.observeNotifications((notification) => {
            if (
                notification.method === "item/completed" &&
                notification.params.threadId === forkId &&
                notification.params.item.type === "agentMessage"
            ) {
                text = notification.params.item.text;
            }
        });
        let result:
            | { type: "completed"; text: string | null }
            | { type: "failed"; message: string };
        try {
            signal.throwIfAborted();
            const fork = await codex.threadFork({
                threadId: sessionId,
                experimentalPredictionMode: true,
                ephemeral: true,
                excludeTurns: true,
                threadSource: "composer_predictions",
            });
            forkId = fork.thread.id;
            signal.throwIfAborted();
            const completed = await codex.runTurn(
                {
                    threadId: forkId,
                    turnTrigger: "composer_predictions",
                    responsesapiClientMetadata: {
                        prediction_source_thread_id: sessionId,
                        prediction_source_turn_id: sourceTurnId,
                        prediction_trigger: "live",
                    },
                    input: [{ type: "text", text: PROMPT, text_elements: [] }],
                    outputSchema: null,
                    ...(effort === undefined ? {} : { effort }),
                },
                undefined,
                signal,
            );
            if (completed.turn.status !== "completed")
                throw new Error("Prediction turn did not complete");
            const parsed: unknown = JSON.parse(text ?? "");
            if (
                !parsed ||
                typeof parsed !== "object" ||
                !("suggestion" in parsed) ||
                (parsed.suggestion !== null &&
                    typeof parsed.suggestion !== "string")
            )
                throw new Error("Invalid prediction output");
            const suggestion = parsed.suggestion;
            if (typeof suggestion === "string" && suggestion.length > 1000)
                throw new Error("Prediction exceeds the draft limit");
            result = {
                type: "completed",
                text: suggestion === null ? null : suggestion.trim() || null,
            };
        } catch (error) {
            const reason: unknown = signal.aborted ? signal.reason : error;
            result = {
                type: "failed",
                message: reason instanceof Error ? reason.message : String(reason),
            };
        } finally {
            clearTimeout(timer);
            stop();
        }
        // Unsubscribe also tears down any still-running ephemeral turn.
        if (forkId) await codex.threadUnsubscribe({ threadId: forkId });
        const current = this.jobs.get(sessionId) === job;
        if (current) this.jobs.delete(sessionId);
        if (
            !job.signal.aborted &&
            !lifetime.aborted &&
            !codex.disconnectSignal.aborted &&
            current
        ) {
            await client.update({
                sessionUpdate: "session_info_update",
                _meta: { codex: { prediction: { sourceTurnId, result } } },
            });
        }
    }
}
