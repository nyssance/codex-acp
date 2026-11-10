import {RequestError} from "@agentclientprotocol/sdk/unstable";
import type {AdditionalContextEntry} from "../../app-server/v2";
import {isRecord} from "../../permissions/json";

export type NativeToolSettings = {imageGeneration?: boolean};

/** Host-selected capabilities, independent of application modes and persisted configuration. */
export function nativeToolsOf(meta: unknown): NativeToolSettings | undefined {
    const value = isRecord(meta) && isRecord(meta["alwith"]) ? meta["alwith"]["nativeTools"] : undefined;
    if (value === undefined) return undefined;
    if (!isRecord(value) || Object.keys(value).some(key => key !== "imageGeneration")
        || (value["imageGeneration"] !== undefined && typeof value["imageGeneration"] !== "boolean"))
        throw RequestError.invalidParams(undefined, "Invalid nativeTools capability settings");
    return value["imageGeneration"] === undefined ? {} : {imageGeneration: value["imageGeneration"] as boolean};
}

export function nativeToolsConfig(settings: NativeToolSettings | undefined) {
    return settings?.imageGeneration === undefined ? {} : {
        "features.image_generation": settings.imageGeneration,
        "features.imagegenext": settings.imageGeneration,
    };
}

/** Omission leaves context untouched; a null entry explicitly replaces that key with empty context. */
export function applicationContextOf(meta: unknown): Record<string, AdditionalContextEntry> | undefined {
    const value = isRecord(meta) && isRecord(meta["alwith"]) ? meta["alwith"]["applicationContext"] : undefined;
    if (value === undefined) return undefined;
    if (!isRecord(value) || Object.keys(value).length > 128)
        throw RequestError.invalidParams(undefined, "Invalid applicationContext");
    const entries = Object.entries(value).map(([key, text]) => {
        if (!key || key.length > 128 || (text !== null && typeof text !== "string"))
            throw RequestError.invalidParams(undefined, "Invalid applicationContext entry");
        return [key, {kind: "application", value: text ?? ""}] as const;
    });
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1024)
        throw RequestError.invalidParams(undefined, "applicationContext exceeds 64 KiB");
    return Object.fromEntries(entries);
}
