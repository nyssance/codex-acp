import { describe, expect, test } from "bun:test";

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import {
    assertPromptSupported,
    ConfigOptionError,
    configOptionRequest,
    UnsupportedPromptContentError,
} from "../guards";

const initialized = (
    prompt?: acp.PromptCapabilities,
): acp.InitializeResponse => ({
    protocolVersion: 2,
    info: { name: "fake-agent", version: "1" },
    capabilities: prompt ? { session: { prompt } } : {},
});

const image: acp.ContentBlock = {
    type: "image",
    data: "",
    mimeType: "image/png",
};
const resource: acp.ContentBlock = {
    type: "resource",
    resource: { uri: "file:///a", text: "" },
};

describe("assertPromptSupported", () => {
    test("text and resource links are the baseline; images, audio and embedded resources need the agent's say-so", () => {
        assertPromptSupported(initialized(), [
            { type: "text", text: "hi" },
            { type: "resource_link", uri: "file:///a", name: "a" },
        ]);
        expect(() =>
            assertPromptSupported(initialized(), [image, resource]),
        ).toThrow(UnsupportedPromptContentError);
        try {
            assertPromptSupported(initialized(), [image, resource]);
        } catch (error) {
            expect((error as UnsupportedPromptContentError).types).toEqual([
                "image",
                "resource",
            ]);
            expect((error as Error).message).toBe(
                "fake-agent does not accept image, resource content in a prompt",
            );
        }
        assertPromptSupported(initialized({ image: {}, embeddedContext: {} }), [
            image,
            resource,
        ]);
        expect(() =>
            assertPromptSupported(initialized({ image: {} }), [
                { type: "_video", data: "" } as never,
            ]),
        ).toThrow("_video");
    });
});

describe("configOptionRequest", () => {
    const options: acp.SessionConfigOption[] = [
        {
            type: "select",
            configId: "model",
            name: "Model",
            currentValue: "gpt",
            options: [
                {
                    groupId: "openai",
                    name: "OpenAI",
                    options: [{ value: "gpt", name: "GPT" }],
                },
                {
                    groupId: "local",
                    name: "Local",
                    options: [{ value: "llama", name: "Llama" }],
                },
            ],
        },
        {
            type: "boolean",
            configId: "web",
            name: "Web search",
            currentValue: false,
        },
    ];

    test("types the request by the option and refuses what the session does not offer", () => {
        expect(configOptionRequest("s", options, "model", "llama")).toEqual({
            sessionId: "s",
            configId: "model",
            type: "id",
            value: "llama",
        });
        expect(configOptionRequest("s", options, "web", true)).toEqual({
            sessionId: "s",
            configId: "web",
            type: "boolean",
            value: true,
        });
        expect(() =>
            configOptionRequest("s", options, "model", "claude"),
        ).toThrow(ConfigOptionError);
        expect(() =>
            configOptionRequest("s", options, "model", "claude"),
        ).toThrow("offers gpt, llama");
        expect(() => configOptionRequest("s", options, "web", "yes")).toThrow(
            "is a boolean option",
        );
        expect(() =>
            configOptionRequest("s", options, "effort", "high"),
        ).toThrow("offers no config option effort");
    });
});
