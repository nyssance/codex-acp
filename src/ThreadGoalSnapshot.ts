import type {ACPSessionConnection, UpdateSessionEvent} from "./ACPSessionConnection";
import {AIR_GOAL_KEY, JETBRAINS_META_KEY, withAirMeta} from "./AirExtension";
import {recordOrNull} from "./permissions/json";
import {GOAL_CONTROL_METHOD, type GoalSnapshot, type GoalStatus} from "./GoalExtension";
import type {ThreadGoal} from "./app-server/v2";

export type ThreadGoalSnapshot = GoalSnapshot;

function toGoalStatus(status: ThreadGoal["status"]): GoalStatus {
    switch (status) {
        case "active":
        case "paused":
        case "blocked":
        case "complete":
            return status;
        case "usageLimited":
        case "budgetLimited":
            return "limited";
    }
}

function toUnixMilliseconds(timestampSeconds: number): number {
    return timestampSeconds * 1000;
}

export function toThreadGoalSnapshot(goal: ThreadGoal): ThreadGoalSnapshot {
    return {
        objective: goal.objective.trim(),
        status: toGoalStatus(goal.status),
        tokenBudget: goal.tokenBudget,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
        createdAt: toUnixMilliseconds(goal.createdAt),
        updatedAt: toUnixMilliseconds(goal.updatedAt),
        controlMethod: GOAL_CONTROL_METHOD,
    };
}

export function sameThreadGoalSnapshot(
    left: ThreadGoalSnapshot | null | undefined,
    right: ThreadGoalSnapshot | null,
): boolean {
    if (left === undefined) return false;
    if (left === null || right === null) return left === right;
    return left.objective === right.objective
        && left.status === right.status
        && left.tokenBudget === right.tokenBudget
        && left.createdAt === right.createdAt && left.updatedAt === right.updatedAt && left.tokensUsed === right.tokensUsed && left.timeUsedSeconds === right.timeUsedSeconds;
}

/** v2 exposes goals without requiring the client to impersonate AIR. */
export function goalSessionInfoUpdate(goal: ThreadGoalSnapshot | null, airClient: boolean, v2 = false): UpdateSessionEvent | null {
    if (v2)
        return {
            sessionUpdate: "session_info_update",
            _meta: {
                ...(airClient ? withAirMeta(undefined, AIR_GOAL_KEY, goal) : {}),
                codex: {goal},
            },
        };
    if (!airClient) return null;
    return {
        sessionUpdate: "session_info_update",
        _meta: withAirMeta(undefined, AIR_GOAL_KEY, goal),
    };
}

/** v2 replaces whole namespace values, so compose the current `codex` and AIR values at publication time. */
export function publishGoalSessionInfo(session: ACPSessionConnection, goal: ThreadGoalSnapshot | null, airClient: boolean): Promise<void> {
    if (session.protocolVersion === 2) {
        return session.patchSessionMetadata((current) => ({
            ...(airClient
                ? {
                      [JETBRAINS_META_KEY]: withAirMeta(current, AIR_GOAL_KEY, goal)[JETBRAINS_META_KEY],
                  }
                : {}),
            codex: {...recordOrNull(current["codex"]), goal},
        }));
    }
    const update = goalSessionInfoUpdate(goal, airClient);
    return update === null ? Promise.resolve() : session.update(update);
}
