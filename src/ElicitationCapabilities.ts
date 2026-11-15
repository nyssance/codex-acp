import type * as acp from "@agentclientprotocol/sdk/unstable";

export function clientSupportsFormElicitation(
    clientCapabilities?: acp.ClientCapabilities | null
): boolean {
    return clientCapabilities?.elicitation?.form != null;
}

export function clientSupportsUrlElicitation(
    clientCapabilities?: acp.ClientCapabilities | null
): boolean {
    return clientCapabilities?.elicitation?.url != null;
}
