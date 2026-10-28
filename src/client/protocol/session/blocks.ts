// Type guards for ACP unions. Every ACP union carries a `{type: string}` catch-all
// for forward compatibility, so a plain `block.type === "text"` check does not
// narrow; these predicates do.
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

export type TextBlock = acp.TextContent & { type: "text" };
export type ImageBlock = acp.ImageContent & { type: "image" };
export type ResourceLinkBlock = acp.ResourceLink & { type: "resource_link" };
export type EmbeddedResourceBlock = acp.EmbeddedResource & { type: "resource" };

export function isText(block: acp.ContentBlock): block is TextBlock {
    return block.type === "text";
}
export function isImage(block: acp.ContentBlock): block is ImageBlock {
    return block.type === "image";
}
export function isResourceLink(
    block: acp.ContentBlock,
): block is ResourceLinkBlock {
    return block.type === "resource_link";
}
export function isEmbeddedResource(
    block: acp.ContentBlock,
): block is EmbeddedResourceBlock {
    return block.type === "resource";
}

export type ContentEntry = acp.Content & { type: "content" };
export type DiffEntry = acp.Diff & { type: "diff" };
export type TerminalEntry = acp.Terminal & { type: "terminal" };

export function isContentEntry(
    entry: acp.ToolCallContent,
): entry is ContentEntry {
    return entry.type === "content";
}
export function isDiffEntry(entry: acp.ToolCallContent): entry is DiffEntry {
    return entry.type === "diff";
}

export type SelectOption = acp.SessionConfigOption &
    acp.SessionConfigSelect & { type: "select" };
export type BooleanOption = acp.SessionConfigOption &
    acp.SessionConfigBoolean & { type: "boolean" };

export function isSelectOption(
    option: acp.SessionConfigOption,
): option is SelectOption {
    return option.type === "select";
}
export function isBooleanOption(
    option: acp.SessionConfigOption,
): option is BooleanOption {
    return option.type === "boolean";
}
export function isGroupedSelect(
    options: acp.SessionConfigSelectOptions,
): options is acp.SessionConfigSelectGroup[] {
    return options.length > 0 && "groupId" in options[0];
}

export type PlanItemsContent = acp.PlanItems & { type: "items" };
export type PlanMarkdownContent = acp.PlanMarkdown & { type: "markdown" };

export function isPlanItems(
    plan: acp.PlanUpdateContent,
): plan is PlanItemsContent {
    return plan.type === "items";
}
export function isPlanMarkdown(
    plan: acp.PlanUpdateContent,
): plan is PlanMarkdownContent {
    return plan.type === "markdown";
}

export type FormElicitation = acp.CreateElicitationRequest &
    acp.ElicitationFormMode & { mode: "form" };
export type UrlElicitation = acp.CreateElicitationRequest &
    acp.ElicitationUrlMode & { mode: "url" };

export function isFormElicitation(
    request: acp.CreateElicitationRequest,
): request is FormElicitation {
    return request.mode === "form";
}
export function isUrlElicitation(
    request: acp.CreateElicitationRequest,
): request is UrlElicitation {
    return request.mode === "url";
}

export type ToolCallSubject = acp.ToolCallPermissionSubject & {
    type: "tool_call";
};

export function isToolCallSubject(
    subject: acp.RequestPermissionSubject,
): subject is ToolCallSubject {
    return subject.type === "tool_call";
}

export type StringProperty = acp.StringPropertySchema & { type: "string" };
export type NumberProperty =
    | (acp.NumberPropertySchema & { type: "number" })
    | (acp.IntegerPropertySchema & { type: "integer" });
export type BooleanProperty = acp.BooleanPropertySchema & { type: "boolean" };
export type ArrayProperty = acp.MultiSelectPropertySchema & { type: "array" };

export function isStringProperty(
    property: acp.ElicitationPropertySchema,
): property is StringProperty {
    return property.type === "string";
}
export function isNumberProperty(
    property: acp.ElicitationPropertySchema,
): property is NumberProperty {
    return property.type === "number" || property.type === "integer";
}
export function isBooleanProperty(
    property: acp.ElicitationPropertySchema,
): property is BooleanProperty {
    return property.type === "boolean";
}
export function isArrayProperty(
    property: acp.ElicitationPropertySchema,
): property is ArrayProperty {
    return property.type === "array";
}

export function textOf(blocks: acp.ContentBlock[]): string {
    return blocks
        .filter(isText)
        .map((block) => block.text)
        .filter((text) => text.length > 0)
        .join("\n");
}
