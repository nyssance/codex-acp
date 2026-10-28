// What a client checks before sending, against what the agent declared: the prompt content an agent accepts comes from its initialize
// response, the config values a session accepts from its broadcast options. Checking here turns an opaque -32602 from the agent into a
// named error at the call site, and never sends a request the agent has already said it cannot serve.
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import {
    isBooleanOption,
    isGroupedSelect,
    isSelectOption,
} from "../session/blocks";

/** The prompt holds content the agent did not declare support for in `promptCapabilities`. */
export class UnsupportedPromptContentError extends Error {
    readonly types: string[];
    constructor(agent: string, types: string[]) {
        super(
            `${agent} does not accept ${types.join(", ")} content in a prompt`,
        );
        this.name = "UnsupportedPromptContentError";
        this.types = types;
    }
}

/**
 * Text and resource links are the protocol baseline every agent accepts; images, audio and embedded resources only when the agent's
 * `capabilities.session.prompt` say so. Anything else is not a prompt content block at all.
 */
export function assertPromptSupported(
    initialized: acp.InitializeResponse,
    prompt: readonly acp.ContentBlock[],
): void {
    const capabilities = initialized.capabilities?.session?.prompt;
    const unsupported = new Set<string>();
    for (const block of prompt) {
        switch (block.type) {
            case "text":
            case "resource_link":
                break;
            case "image":
                if (!capabilities?.image) unsupported.add("image");
                break;
            case "audio":
                if (!capabilities?.audio) unsupported.add("audio");
                break;
            case "resource":
                if (!capabilities?.embeddedContext) unsupported.add("resource");
                break;
            default:
                unsupported.add(String((block as { type: unknown }).type));
        }
    }
    if (unsupported.size > 0)
        throw new UnsupportedPromptContentError(initialized.info.name, [
            ...unsupported,
        ]);
}

/** A config write the session's options do not offer: unknown option, wrong value type, or a value outside the select's choices. */
export class ConfigOptionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigOptionError";
    }
}

/**
 * The `session/set_config_option` request for `value`, typed by the option itself (`type: "boolean"` for a switch, `type: "id"` for a select)
 * and refused here when the session's broadcast options do not offer it.
 */
export function configOptionRequest(
    sessionId: string,
    configOptions: readonly acp.SessionConfigOption[],
    configId: string,
    value: string | boolean,
): acp.SetSessionConfigOptionRequest {
    const option = configOptions.find(
        (candidate) => candidate.configId === configId,
    );
    if (option === undefined)
        throw new ConfigOptionError(
            `session ${sessionId} offers no config option ${configId}`,
        );
    if (isBooleanOption(option)) {
        if (typeof value !== "boolean")
            throw new ConfigOptionError(
                `${configId} is a boolean option; ${JSON.stringify(value)} is not a boolean`,
            );
        return { sessionId, configId, type: "boolean", value };
    }
    if (isSelectOption(option)) {
        const values = isGroupedSelect(option.options)
            ? option.options.flatMap((group) =>
                  group.options.map((choice) => choice.value),
              )
            : option.options.map((choice) => choice.value);
        if (typeof value !== "string" || !values.includes(value))
            throw new ConfigOptionError(
                `${configId} offers ${values.join(", ")}; ${JSON.stringify(value)} is not one of them`,
            );
        return { sessionId, configId, type: "id", value };
    }
    throw new ConfigOptionError(
        `${configId} has a config option type this client does not know`,
    );
}
