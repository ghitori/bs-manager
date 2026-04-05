import { BSVersion } from "shared/bs-version.interface";

export const LaunchMods = {
    OCULUS: "oculus",
    FPFC: "fpfc",
    DEBUG: "debug",
    SKIP_STEAM: "skip_steam",
    SKIP_OCULUS_CLIENT: "skip_oculus_client",
    EDITOR: "editor",
    PROTON_LOGS: "proton_logs",
} as const;

export type LaunchMod = typeof LaunchMods[keyof typeof LaunchMods];

export interface LaunchOption {
    version: BSVersion,
    launchMods?: LaunchMod[],
    command?: string,
    admin?: boolean
}
