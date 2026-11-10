import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type {UserInput} from "../../app-server/v2";
import {parseAsyncQuestionReply, renderAsyncQuestionReply} from "../../CodexAsyncQuestions";

/** Receipt adoption retains optimistic content; keep structured replies at message level too. */
export function withQuestionReplyParts(content: acp.ContentBlock[], meta?: Record<string, unknown>): Record<string, unknown> | undefined {
    let found = false;
    const parts = content.flatMap(block => {
        if (!acp.ContentBlock.isText(block)) return [];
        const reply = (
            block._meta?.["codex"] as
                | {
                      questionReply?: {
                          questionItemId: string;
                          question: string;
                          answer: string;
                      };
                  }
                | undefined
        )?.questionReply;
        if (!reply) return [{text: block.text}];
        found = true;
        return [
            {
                questionItemId: reply.questionItemId,
                question: reply.question,
                text: reply.answer,
            },
        ];
    });
    return found
        ? {
              ...meta,
              codex: {
                  ...(meta?.["codex"] as object),
                  questionReplyParts: parts,
              },
          }
        : meta;
}

/** The structured blocks of a reply envelope, one per answer; anything else stays text. */
export function questionReplyContent(text: string): acp.ContentBlock[] | null {
    const replies = parseAsyncQuestionReply(text);
    if (replies === null) return null;
    return replies.map(({questionItemId, question, answer}) => ({
        type: "text",
        text: `${question}\n${answer}`,
        _meta: {
            codex: {questionReply: {questionItemId, question, answer}},
        },
    }));
}

/**
 * Replaces the quoted text that `session/load` replays for a reply envelope with the structured reply the
 * live path sends, so clients can match each answer to its question after a reload.
 */
export function withQuestionReplies(updates: readonly acp.SessionUpdate[], inputs: readonly UserInput[]): acp.SessionUpdate[] {
    const replies = new Map<string, acp.ContentBlock[]>();
    for (const input of inputs) {
        if (input.type !== "text") continue;
        const content = questionReplyContent(input.text);
        const rendered = renderAsyncQuestionReply(input.text);
        if (content !== null && rendered !== null) replies.set(rendered, content);
    }
    return updates.map(update => {
        if (!acp.SessionUpdate.isUserMessageChunk(update) || !acp.ContentBlock.isText(update.content)) return update;
        const content = replies.get(update.content.text);
        if (content === undefined) return update;
        const meta = withQuestionReplyParts(content, update._meta ?? undefined);
        return {
            sessionUpdate: "user_message",
            messageId: update.messageId,
            content,
            ...(meta ? {_meta: meta} : {}),
        };
    });
}
