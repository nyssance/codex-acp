import {expect, test} from "vitest";

import {codexTurnError} from "../../client/codex-extensions";

test("standard errors preserve the message and the adapter's failure classification", () => {
    expect(
        codexTurnError({
            stopReason: "error",
            error: {
                code: -32603,
                message: "Provider unavailable",
                data: {
                    codex: {
                        kind: "provider_error",
                        category: "service",
                        actions: ["retry"],
                    },
                },
            },
            meta: {codex: {error: {message: "Old message"}}},
        }),
    ).toEqual({
        message: "Provider unavailable",
        kind: "provider_error",
        category: "service",
        actions: ["retry"],
        retryable: true,
    });
});

test("standard errors work without vendor metadata", () => {
    expect(
        codexTurnError({
            stopReason: "error",
            error: {code: -32603, message: "Disconnected"},
            meta: null,
        }),
    ).toEqual({
        message: "Disconnected",
        kind: null,
        category: null,
        actions: [],
        retryable: false,
    });
});

test("legacy errors and stop reasons without details remain visible", () => {
    expect(
        codexTurnError({
            stopReason: "_error",
            error: null,
            meta: {codex: {error: {message: "Legacy failure"}}},
        }).message,
    ).toBe("Legacy failure");
    expect(
        codexTurnError({
            stopReason: "max_turn_requests",
            error: null,
            meta: null,
        }).message,
    ).toBe("Turn ended: max_turn_requests");
});
