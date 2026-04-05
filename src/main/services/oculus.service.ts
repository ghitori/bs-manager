import path from "path";
import { pathExist, resolveGUIDPath } from "../helpers/fs.helpers";
import log from "electron-log";
import { lstat } from "fs-extra";
import { tryit } from "../../shared/helpers/error.helpers";
import { app, shell } from "electron";
import { isProcessRunning } from "../helpers/os.helpers";
import { sToMs } from "../../shared/helpers/time.helpers";
import { execOnOs } from "../helpers/env.helpers";
import { UtilsService } from "./utils.service";
import { exec } from "child_process";
import { CustomError } from "shared/models/exceptions/custom-error.class";
import { BSLaunchError } from "shared/models/bs-launch";

const { list } = (execOnOs({ win32: () => require("regedit-rs") }, true) ?? {}) as typeof import("regedit-rs");

export class OculusService {
    private static instance: OculusService;

    public static getInstance(): OculusService {
        if (!OculusService.instance) {
            OculusService.instance = new OculusService();
        }
        return OculusService.instance;
    }


    private readonly utils: UtilsService;

    private oculusLibraries: OculusLibrary[];

    private constructor() {
        this.utils = UtilsService.getInstance();
    }

    public async getOculusLibs(): Promise<OculusLibrary[]> {
        if (process.platform !== "win32") {
            log.info("Oculus library auto-detection not supported on non-windows platforms");
            return null;
        }

        if (this.oculusLibraries) {
            return this.oculusLibraries;
        }

        const oculusLibsRegKey = "HKCU\\SOFTWARE\\Oculus VR, LLC\\Oculus\\Libraries";
        const libsRegData = await list(oculusLibsRegKey).then(data => data[oculusLibsRegKey]);

        if (!libsRegData.keys?.length) {
            log.info("Registry key \"HKCU\\SOFTWARE\\Oculus VR, LLC\\Oculus\\Libraries\" not found");
            return null;
        }

        const defaultLibraryId = libsRegData.values.DefaultLibrary.value as string;

        const libsPath: OculusLibrary[] = (
            await Promise.all(libsRegData.keys.map(async key => {
                const originalPath = await list([`${oculusLibsRegKey}\\${key}`]).then(res => res[`${oculusLibsRegKey}\\${key}`]);

                if (originalPath.values?.OriginalPath) {
                    return { id: key, path: originalPath.values.OriginalPath.value, isDefault: defaultLibraryId === key } as OculusLibrary;
                }

                if(originalPath.values?.Path) {
                    const { result } = tryit(() => resolveGUIDPath(originalPath.values.Path.value as string));
                    return result ? { id: key, path: result, isDefault: defaultLibraryId === key } as OculusLibrary : null;
                }

                return null;
            }, []))
        ).filter(Boolean);

        this.oculusLibraries = libsPath;

        return libsPath;
    }

    public async getGameFolder(gameFolder: string): Promise<string> {
        const libsFolders = await this.getOculusLibs();

        if (!libsFolders) {
            return null;
        }

        const rootLibDir = "Software";

        for (const { path: libPath } of libsFolders) {
            const gameFullPath = path.join(libPath, rootLibDir, gameFolder);
            if (await pathExist(gameFullPath)) {
                return (await lstat(gameFullPath)).isSymbolicLink() ? null : gameFullPath;
            }
        }

        return null;
    }

    /**
     * Return the first game folder found in the list
     * @param {string[]} gameFolders
     */
    public async tryGetGameFolder(gameFolders: string[]): Promise<string> {
        for(const gameFolder of gameFolders){
            const fullPath = await this.getGameFolder(gameFolder);
            if(fullPath){ return fullPath; }
        }

        return null;
    }

    public async oculusRunning(): Promise<boolean> {
        if (await isProcessRunning("OculusClient")) {
            return true;
        }

        return isProcessRunning("Client"); // new name of oculus client
    }

    public async isOculusInstalled(): Promise<boolean> {
        if (process.platform !== "win32") {
            log.info("Oculus installation check is not supported on non-windows platforms");
            return true;
        }

        const oculusSchemeRegKey = "HKCU\\SOFTWARE\\Classes\\oculus";
        const schemeRegData = await list(oculusSchemeRegKey).then(data => data[oculusSchemeRegKey]);

        if (!Object.keys(schemeRegData.values).length) {
            log.error("Registry key \"HKCU\\SOFTWARE\\Classes\\oculus\" not found");
            return false;
        }
        return true
    }

    public async startOculus(): Promise<void>{
        if(await this.oculusRunning()){ return; }

        if (!await this.isOculusInstalled()){
            throw new CustomError("No scheme found. Check if Oculus is installed.", BSLaunchError.OCULUS_NOT_INSTALLED);
        }

        await shell.openPath("oculus://view/homepage");

        return new Promise((resolve, reject) => {
            const interval = setInterval(async () => {
                if(!(await this.oculusRunning())){ return; }
                clearInterval(interval);
                resolve();
            }, sToMs(3));

            setTimeout(() => {
                clearInterval(interval);
                reject(new Error("Unable to open Oculus"));
            }, sToMs(30));
        });
    }

    public async isSideLoadedAppsEnabled(): Promise<boolean> {
        if(process.platform !== "win32"){
            log.info("Cannot check sideloaded apps on non-windows platforms");
            throw new Error("Cannot check sideloaded apps on non-windows platforms");
        }

        const regPath = "HKLM\\SOFTWARE\\Wow6432Node\\Oculus VR, LLC\\Oculus";
        const res = await list(regPath).then(res => res[regPath]);

        if(!res.exists){
            log.info("Registry key not found", regPath);
            return false;
        }

        const value = res.values?.AllowDevSideloaded;

        if(!value){
            log.info("Registry value not found", "AllowDevSideloaded");
            return false;
        }

        return value.value === 1;
    }

    public async enableSideloadedApps(): Promise<void> {
        if(process.platform !== "win32"){
            log.info("Cannot enable sideloaded apps on non-windows platforms");
            return;
        }

        const enabled = await this.isSideLoadedAppsEnabled();

        if(enabled){
            log.info("Sideloaded apps already enabled");
            return;
        }

        const exePath = path.join(this.utils.getAssetsScriptsPath(), "oculus-allow-dev-sideloaded.exe");

        return new Promise((resolve, reject) => {
            log.info("Enabling sideloaded apps");
            const process = exec(`"${exePath}" --log-path "${path.join(app.getPath("logs"), "oculus-allow-dev-sideloaded.log")}"`);
            process.on("exit", code => {
                if(code === 0){
                    resolve();
                } else {
                    reject(new Error(`Failed to enable sideloaded apps, exit code: ${code}`));
                }
            });

            process.on("error", err => {
                log.error("Error while enabling sideloaded apps", err);
                reject(err);
            });

            process.stdout.on("data", data => {
                log.info(data.toString?.() ?? data);
            });
        })
    }

    public async isOVRServiceRunning(): Promise<boolean> {
        if(process.platform !== "win32"){
            log.info("Cannot check OVRService on non-windows platforms");
            return false;
        }
    
        return new Promise((resolve) => {
            const process = exec(`sc query OVRService`);
            let output = "";
            
            process.stdout?.on("data", data => {
                output += data.toString();
            });

            process.on("exit", async code => {
                if(code !== 0){
                    log.info("OVRService query failed, trying with process check");
                    const running = await isProcessRunning("OVRServer_x64");
                    return resolve(running);
                }
                return resolve(output.includes("RUNNING"));
            });
        });
    }

    public async getOVRServicePermission(): Promise<string> {
        if(process.platform !== "win32"){
            throw new Error("Cannot get OVRService permission on non-windows platforms");
        }

        return new Promise((resolve, reject) => {
            const process = exec(`sc sdshow "OVRService"`);
            let output = "";
            
            process.stdout?.on("data", (data) => {
                output += data.toString();
            });

            process.on("exit", code => {
                if(code !== 0){
                    return reject(new Error(`Failed to get OVRService SDDL, exit code: ${code}`));
                }
                return resolve(output.trim());
            });

            process.on("error", err => {
                reject(new Error(`Error getting OVRService SDDL: ${err.message}`));
            });
        });
    }

    public async grantOVRServicePermission(): Promise<void> {
        if(process.platform !== "win32"){
            throw new Error("Cannot grant OVRService permission on non-windows platforms");
        }
    
        const sid = await new Promise<string>((resolve, reject) => {
            const process = exec(`powershell -Command "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"`);
            let output = "";
            
            process.stdout?.on("data", (data) => {
                output += data.toString();
            });

            process.on("exit", (code) => {
                if(code !== 0 || !output.trim().startsWith("S-")){
                    return reject(new Error(`Failed to get current user SID, exit code: ${code}`));
                }
                return resolve(output.trim());
            });

            process.on("error", err => {
                reject(new Error(`Error getting user SID: ${err.message}`));
            });
        });

        const sidPermission = `(A;;RPWP;;;${sid})`;
        const sddl = await this.getOVRServicePermission();

        if (sddl.includes(sidPermission)) {
            log.info("Current user already has permission to OVRService");
            return;
        }

        const newSddl = `${sddl}${sidPermission}`;

        await new Promise<void>((resolve, reject) => {
            const process = exec(`powershell -Command "Start-Process sc.exe -Verb RunAs -ArgumentList 'sdset','OVRService','${newSddl}' -Wait"`);
            
            process.on("exit", (code) => {
                if(code !== 0){
                    return reject(CustomError.fromError(new Error("UAC authorization is required"), BSLaunchError.GRANT_OVRSERVICE_PERMISSION_FAIL));
                }
                return resolve();
            });
        });

        const updatedSddl = await this.getOVRServicePermission();
        if (!updatedSddl.includes(sidPermission)) {
            throw new Error("Failed to grant permission to OVRService");
        }

        log.info("Successfully granted permission to OVRService");
    }

    public async killOculusClient(): Promise<void> { //Kill Oculus client if you dont stop it last time.
        for (let i = 0; i < 10; i++) {
            await new Promise<void>((resolve) => {
                setTimeout(() => {
                    exec(`powershell -Command "Get-Process | Where-Object {$_.Path -like '*oculus-client\\Client.exe'} | Stop-Process -Force`);
                    resolve();
                }, 1000);
            });
        }
    }

    public async startOVRService(): Promise<void> {
        if (await this.isOVRServiceRunning()) return;

        log.info("OVRService is not running. Starting OVRService...");

        return new Promise((resolve, reject) => {
            const process = exec("sc start OVRService");

            process.on("exit", async (code) => {
                switch (code) {
                    case 0:
                        this.killOculusClient()
                    case 1056:
                        log.info("OVRService started successfully");
                        resolve();
                        break;
                    case 5:
                        log.warn("Failed to start OVRService, access denied");
                        try {
                            await this.grantOVRServicePermission();
                            await this.startOVRService();
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                        break;
                    case 1060:
                        log.error("OVRService is not installed");
                        reject(CustomError.fromError(new Error("OVRService is not installed"), BSLaunchError.OCULUS_NOT_INSTALLED));
                        break;
                    default:
                        log.error(`Failed to start OVRService, exit code: ${code}`);
                        reject(CustomError.fromError(new Error("Failed to start OVRService"), BSLaunchError.OVRSERVICE_START_FAIL));
                }
            });
        });
    }
}

export interface OculusLibrary {
    id: string;
    path: string;
    isDefault?: boolean;
}
