import {isRecord} from "../../permissions/json";
import {expandSummaries} from "./externalCompaction";

/** Native Responses rejects plaintext reasoning input, including foreign encrypted envelopes. */
export function compatibleResponsesRequest(body: string, destination: "native" | "external" = "native"): string {
    const request: unknown = JSON.parse(body);
    if (!isRecord(request)) return body;
    const input = request["input"];
    const filtered = Array.isArray(input)
        ? input.filter(
              (item: unknown) =>
                  !(
                      isRecord(item) &&
                      (destination === "external"
                          ? item["type"] === "additional_tools"
                          : item["type"] === "reasoning" && Array.isArray(item["content"]) && item["content"].length > 0)
                  ),
          )
        : input;
    // Either upstream gets the summary a gateway compaction stands for, never the proxy's own envelope.
    const compatible = Array.isArray(filtered) ? expandSummaries(filtered) : filtered;
    const selected = request["model"];
    const match = typeof selected === "string" ? /^gateway:[^:]+:([^:]+)$/.exec(selected) : null;
    const native = typeof selected === "string" && selected.startsWith("native:");
    const model = match ? decodeURIComponent(match[1]!) : native ? decodeURIComponent(selected.slice("native:".length)) : selected;
    const unchangedInput =
        compatible === input ||
        (compatible === filtered && Array.isArray(filtered) && Array.isArray(input) && filtered.length === input.length);
    return unchangedInput && model === selected
        ? body
        : JSON.stringify({
              ...request,
              ...(match || native ? {model} : {}),
              ...(Array.isArray(input) ? {input: compatible} : {}),
          });
}
