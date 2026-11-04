import { afterEach, expect, it, vi } from "vitest";
import type { ThreadItem } from "../../app-server/v2";
import {
    connectSession,
    createTurn,
    itemCompleted,
    itemStarted,
    userMessageItem,
    turnStarted,
    turnCompleted,
    turnId,
    sessionId,
    type PromptSession,
} from "./v2-prompt-harness";
const clients: PromptSession[] = [];
afterEach(() => {
    for (const client of clients.splice(0)) client.connection.close();
});
const question: Extract<ThreadItem, { type: "agentMessage" }> = {
    type: "agentMessage",
    id: "async-question",
    text: "",
    phase: "final_answer",
    memoryCitation: null,
    delivery: "async",
    questions: [{ title: "Which environment?", options: ["Local", "Remote"] }],
};
it("keeps question-only native messages structured without waiting for user interaction", async () => {
    const client = await connectSession();
    clients.push(client);
    client.setTurnStart(async () => ({ turn: createTurn("inProgress") }));
    const prompt = client.sendPrompt([{ type: "text", text: "go" }]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    client.emit(turnStarted());
    client.emit(
        itemCompleted(
            userMessageItem(
                client.turnStartParams[0]!["clientUserMessageId"] as string,
            ),
        ),
    );
    await prompt;
    const start = client.transcript.length;
    client.emit(itemStarted(question));
    client.emit(itemCompleted(question));
    await vi.waitFor(() =>
        expect(
            client.transcript
                .slice(start)
                .filter(
                    (entry) =>
                        "sessionUpdate" in entry &&
                        entry.sessionUpdate.sessionUpdate === "agent_message",
                ),
        ).toHaveLength(2),
    );
    const updates = client.transcript
        .slice(start)
        .flatMap((entry) =>
            "sessionUpdate" in entry ? [entry.sessionUpdate] : [],
        );
    expect(updates).toContainEqual(
        expect.objectContaining({
            messageId: question.id,
            _meta: {
                codex: expect.objectContaining({
                    turnId,
                    phase: question.phase,
                    delivery: "async",
                    questions: question.questions,
                    messageCompleted: true,
                }),
            },
        }),
    );
    expect(
        updates.some((update) => update.sessionUpdate === "state_update"),
    ).toBe(false);
    client.emit(turnCompleted());
    await client.promptRunFinished();
});
it("reads question messages and structured replies from history", async () => {
    const client = await connectSession();
    clients.push(client);
    const replies = [
        {
            questionItemId: JSON.stringify([
                "request_user_input_async",
                question.id,
                0,
            ]),
            question: "Which environment?",
            answer: "Remote",
        },
    ];
    const reply = userMessageItem(
        "reply",
        `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`,
    );
    client.setCodexResponse("thread/items/list", async () => ({
        data: [question, reply].map((item) => ({
            turnId,
            item,
            startedAtMs: 1,
            completedAtMs: 2,
        })),
        nextCursor: null,
    }));
    const page = (await client.request("_codex/session_history_items", {
        sessionId,
    })) as {
        items: Array<{
            itemId: string;
            updates: Array<Record<string, unknown>>;
            omissions: unknown[];
        }>;
    };
    const [asked, answered] = page.items;
    expect(asked!.omissions).toEqual([]);
    expect(asked!.updates).toContainEqual(
        expect.objectContaining({
            sessionUpdate: "agent_message_chunk",
            messageId: question.id,
            _meta: expect.objectContaining({
                codex: expect.objectContaining({
                    delivery: "async",
                    questions: question.questions,
                    turnId,
                }),
            }),
        }),
    );
    // Same shape as the live path, so the client can tell which question was answered.
    expect(answered!.updates).toContainEqual(
        expect.objectContaining({
            sessionUpdate: "user_message",
            messageId: "reply",
            content: [
                {
                    type: "text",
                    text: "Which environment?\nRemote",
                    _meta: { codex: { questionReply: replies[0] } },
                },
            ],
            _meta: expect.objectContaining({
                codex: expect.objectContaining({
                    questionReplyParts: [
                        { questionItemId: replies[0]!.questionItemId, question: "Which environment?", text: "Remote" },
                    ],
                }),
            }),
        }),
    );
});
