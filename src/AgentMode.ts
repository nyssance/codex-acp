import {isDeepStrictEqual} from "node:util";
import type {
    ApprovalsReviewer,
    AskForApproval,
    PermissionProfileSummary,
    SandboxMode,
    SandboxPolicy,
} from "./app-server/v2";
import type {SessionConfigOption, SessionMode, SessionModeState} from "@agentclientprotocol/sdk/unstable";
import {AIR_KIND_KEY, airOnlyMeta} from "./AirExtension";

export const MODE_CONFIG_ID = "mode";
const PERMISSION_PROFILE_MODE_PREFIX = "permission-profile:";

type AgentModeKind = "plan" | "auto_review" | "standard" | "full_access";

export class AgentMode {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly kind: AgentModeKind | null;
    readonly approvalPolicy: AskForApproval;
    readonly approvalsReviewer: ApprovalsReviewer;
    readonly sandboxPolicy: SandboxPolicy | null;
    readonly sandboxMode: SandboxMode | null;
    readonly permissionProfileId: string | null;

    private constructor(
        id: string,
        name: string,
        description: string,
        kind: AgentModeKind | null,
        approvalPolicy: AskForApproval,
        approvalsReviewer: ApprovalsReviewer,
        sandboxPolicy: SandboxPolicy | null,
        sandboxMode: SandboxMode | null,
        permissionProfileId: string | null = null,
    ) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.kind = kind;
        this.approvalPolicy = approvalPolicy;
        this.approvalsReviewer = approvalsReviewer;
        this.sandboxPolicy = sandboxPolicy;
        this.sandboxMode = sandboxMode; // same as sandboxPolicy, need to look for
        this.permissionProfileId = permissionProfileId;
    }

    static readonly ReadOnly = new AgentMode(
        "read-only",
        "Read-only",
        "Requires approval to edit files and access the internet.",
        "standard",
        "on-request",
        "user",
        {
            type: "readOnly",
            networkAccess: false,
        },
        "read-only",
    );
    static readonly WorkspaceWrite = new AgentMode(
        "workspace-write",
        "Workspace access",
        "Edit workspace files; ask before writing outside the workspace or accessing the network.",
        "standard",
        "on-request",
        "user",
        {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        },
        "workspace-write",
    );
    static readonly Agent = new AgentMode(
        "agent",
        "Auto review",
        "Only ask for actions detected as potentially unsafe",
        "auto_review",
        "on-request",
        "auto_review",
        {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false
        },
        "workspace-write",
    );
    static readonly AgentFullAccess = new AgentMode(
        "agent-full-access",
        "Full access",
        "Unrestricted access to the internet and any file on your computer",
        "full_access",
        "never",
        "user",
        {"type": "dangerFullAccess"},
        "danger-full-access",
    );

    static fromPermissionProfile(
        id: string,
        description: string | null = null,
        approvalPolicy: AskForApproval = "on-request",
        approvalsReviewer: ApprovalsReviewer = "user",
    ): AgentMode {
        return new AgentMode(
            `${PERMISSION_PROFILE_MODE_PREFIX}${id}`,
            id,
            description ?? `Use the ${id} Codex permission profile.`,
            null,
            approvalPolicy,
            approvalsReviewer,
            null,
            null,
            id,
        );
    }

    static DEFAULT_AGENT_MODE = AgentMode.Agent;

    /** Only AIR gets the mode kind, in `_meta.jetbrains.air.kind`. */
    toSessionMode(airClient: boolean): SessionMode {
        const meta = this.kind === null ? undefined : airOnlyMeta(airClient, AIR_KIND_KEY, this.kind);
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            ...(meta ? {_meta: meta} : {}),
        };
    }

    toSessionModeState(airClient: boolean, offeredModes: AgentMode[] = AgentMode.all()): SessionModeState {
        return {
            availableModes: this.withCurrent(offeredModes).map(mode => mode.toSessionMode(airClient)),
            currentModeId: this.id
        };
    }

    toConfigOption(airClient: boolean, offeredModes: AgentMode[] = AgentMode.all()): SessionConfigOption {
        const toOptions = (modes: AgentMode[]) => modes.map(mode => {
            const meta = mode.kind === null ? undefined : airOnlyMeta(airClient, AIR_KIND_KEY, mode.kind);
            return {
                value: mode.id,
                name: mode.name,
                description: mode.description,
                ...(meta ? {_meta: meta} : {}),
            };
        });
        const availableModes = this.withCurrent(offeredModes);
        const permissionProfileModes = availableModes.filter(mode => mode.permissionProfileId !== null);
        const options = permissionProfileModes.length === 0
            ? toOptions(availableModes)
            : [
                {
                    group: "sandbox-modes",
                    name: "Sandbox Modes",
                    options: toOptions(availableModes.filter(mode => mode.permissionProfileId === null)),
                },
                {
                    group: "permission-profiles",
                    name: "Permission Profiles",
                    options: toOptions(permissionProfileModes),
                },
            ];
        return {
            id: MODE_CONFIG_ID,
            name: "Mode",
            description: "Approval and sandboxing preset for the session",
            category: "mode",
            type: "select",
            currentValue: this.id,
            options,
        };
    }

    /** A custom or restored mode that is not offered stays selectable as the current value. */
    private withCurrent(modes: AgentMode[]): AgentMode[] {
        return modes.some(mode => mode.id === this.id) ? modes : [...modes, this];
    }

    static all(
        permissionProfiles: PermissionProfileSummary[] = [],
        permissionProfileApprovalPolicy: AskForApproval = "on-request",
        permissionProfileApprovalsReviewer: ApprovalsReviewer = "user",
    ): AgentMode[] {
        const profileModes = permissionProfiles
            .filter(profile => profile.allowed && !profile.id.startsWith(":"))
            .map(profile => AgentMode.fromPermissionProfile(
                profile.id,
                profile.description,
                permissionProfileApprovalPolicy,
                permissionProfileApprovalsReviewer,
            ));
        return [
            AgentMode.ReadOnly,
            AgentMode.WorkspaceWrite,
            AgentMode.Agent,
            AgentMode.AgentFullAccess,
            ...profileModes,
        ];
    }

    static find(modeId: string, availableModes: AgentMode[] = AgentMode.all()): AgentMode | null {
        const match = availableModes.find(m => m.id === modeId);
        return match ?? null;
    }

    static fromThread(thread: {
        approvalPolicy: AskForApproval;
        approvalsReviewer: ApprovalsReviewer;
        sandbox: SandboxPolicy;
        activePermissionProfile?: {id: string} | null;
    }): AgentMode {
        const profile = thread.activePermissionProfile;
        if (profile && !profile.id.startsWith(":"))
            return AgentMode.fromPermissionProfile(profile.id, null, thread.approvalPolicy, thread.approvalsReviewer);
        const preset = AgentMode.all().find(mode =>
            isDeepStrictEqual(mode.approvalPolicy, thread.approvalPolicy) &&
            mode.approvalsReviewer === thread.approvalsReviewer &&
            isDeepStrictEqual(mode.sandboxPolicy, thread.sandbox)
        );
        if (preset) return preset;
        const sandboxMode = (() => {
            switch (thread.sandbox.type) {
                case "readOnly":
                    return "read-only";
                case "workspaceWrite":
                    return "workspace-write";
                case "dangerFullAccess":
                case "externalSandbox":
                    return "danger-full-access";
            }
        })();
        return new AgentMode(
            "custom",
            "Custom permissions",
            "Keep the session's existing permission settings.",
            thread.approvalsReviewer === "auto_review" ? "auto_review" : "standard",
            thread.approvalPolicy,
            thread.approvalsReviewer,
            structuredClone(thread.sandbox),
            sandboxMode,
        );
    }

    static getInitialAgentMode(
        availableModes: AgentMode[] = AgentMode.all(),
        activePermissionProfileId: string | null = null,
    ): AgentMode {
        const predefinedAgentMode = process.env["INITIAL_AGENT_MODE"];
        if (predefinedAgentMode) {
            const mode = AgentMode.find(predefinedAgentMode, availableModes);
            if (!mode) throw new Error(`Unknown INITIAL_AGENT_MODE: ${predefinedAgentMode}`);
            return mode;
        }
        if (activePermissionProfileId !== null) {
            const profileMode = availableModes.find(mode => mode.permissionProfileId === activePermissionProfileId);
            if (profileMode) {
                return profileMode;
            }
        }
        return AgentMode.DEFAULT_AGENT_MODE;
    }
}
