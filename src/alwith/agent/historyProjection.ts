import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type { ThreadItem } from "../../app-server/v2";
import { withTurnId } from "./turnMetadata";
import { hydrateLocalImages } from "../codex/userImages";

/** Renders one native item as `session/load` replays it, in the ACP v2 wire shape. */
export type HistoryRenderer = (
    item: ThreadItem,
    cwd: string,
) => Promise<acp.SessionUpdate[]>;

export interface HistoryOmission {
    itemId: string;
    field: string;
    reason: string;
}
export interface HistoryProjection {
    updates: acp.SessionUpdate[];
    omissions: HistoryOmission[];
}

/** `session/load`'s rendering of an item, plus what history readers need beyond a replay. */
export async function projectHistoryItem(
    render: HistoryRenderer,
    item: ThreadItem,
    cwd: string,
    turnId: string,
    startedAt: number | null,
    signal: AbortSignal,
): Promise<HistoryProjection> {
    let updates = await render(item, cwd);
    // A history reader may run on another machine, so local images are sent inline.
    if (item.type === "userMessage")
        updates = await hydrateLocalImages(updates, item.content, signal);
    const omissions: HistoryOmission[] = [];
    if (!updates.length)
        omissions.push({
            itemId: item.id,
            field: "*",
            reason: "no_acp_representation",
        });
    if (item.type === "reasoning" && item.summary.length && item.content.length)
        omissions.push({
            itemId: item.id,
            field: "content",
            reason: "summary_selected",
        });
    if (item.type === "agentMessage" && item.memoryCitation !== null)
        omissions.push({
            itemId: item.id,
            field: "memoryCitation",
            reason: "no_acp_representation",
        });
    return {
        updates: updates.map((update) => withTurnId(update, turnId, startedAt)),
        omissions,
    };
}
