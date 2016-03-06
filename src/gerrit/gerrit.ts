import { Ref } from "./ref";
import { Logger, LoggerSingleton } from "./logger";
import { GerritSettings } from "./settings";
import { workspace } from "vscode";
import { exec } from "child_process";
import * as common from "./common";
import * as utils from "./utils";
import * as http from "http";
import * as https from "https";

export class Gerrit {
    private branch: string;
    private currentRef: Ref;
    private logger: LoggerSingleton;
    private settings: GerritSettings;

    constructor(private workspaceRoot: string, private repo: string, ref?: Ref) {
        this.settings = new GerritSettings();
        this.logger = Logger.logger;
        this.logger.setDebug(true);
        this.logger.log("Activating Gerrit...");
        if (ref !== null) {
            // TODO: determine ref at start
            this.currentRef = ref;
        }
    }

    public getCurrentRef(): Ref {
        return this.currentRef;
    }

    private setCurrentRef(ref: Ref) {
        this.currentRef = ref;
        this.logger.debug(`New Ref:
    ID: ${this.currentRef.getId()}
    Patch Set: ${this.currentRef.getPatchSet()}`);
    }

    private isDirty(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            this.getDirtyFiles().then(value => {
                resolve(value.length !== 0);
            }, reason => {
                reject(reason);
            });
        });
    }

    public getDirtyFiles(): Promise<common.DirtyFilesContainter> {
        let options = [
            "--exclude-standard"
        ];
        let dirtyTypes = {
            deleted: "-d",
            modified: "-m",
            untracked: "-o"
        };
        let container = new common.DirtyFilesContainter();
        return this.git("ls-files", options.concat([dirtyTypes.deleted])).then(result => {
            let files: string[] = result.split(utils.SPLIT_LINE).filter(utils.filterDuplicates);
            for (let i in files) {
                container.addDeleted({
                    path: files[i]
                });
            }
            return this.git("ls-files", options.concat([dirtyTypes.modified]));
        }).then(result => {
            let files: string[] = result.split(utils.SPLIT_LINE).filter(utils.filterDuplicates);
            for (let i in files) {
                container.addModified({
                    path: files[i]
                });
            }
            return this.git("ls-files", options.concat([dirtyTypes.untracked]));
        }).then(result => {
            let files: string[] = result.split(utils.SPLIT_LINE).filter(utils.filterDuplicates);
            for (let i in files) {
                container.addUntrackedFile({
                    path: files[i]
                });
            }
            return container;
        });
    }

    public stage(path: string): Promise<string> {
        this.logger.debug(`Stage:
    Message: ${path}`);
        let args = [
            path
        ];
        return this.git("add", [], args);
    }

    public reset(path: string, hard?: boolean): Promise<string> {
        hard = utils.setDefault(hard, false);
        this.logger.debug(`Stage:
    Message: ${path}`);
        let args: string[] = [
            path
        ];
        let options: string[] = [];
        if (hard) {
            options.push("--hard");
        }
        return this.git("reset", options, args);
    }

    public clean(path: string): Promise<string> {
        return this.checkout(path);
    }

    // TODO: Use quick pick during commit for staging files
    public commit(msg: string, files: string[], amend: boolean): Promise<string> {
        this.logger.debug(`Commit:
    Message: ${msg}
    Files: ${files}
    Amend: ${amend}`);
        return new Promise((resolve, reject) => {
            let options: string[] = [
                "commit",
            ];
            if (amend) {
                options.push("--amend", "--no-edit");
            } else {
                if (msg === null || msg.length === 0) {
                    let reason: common.RejectReason = {
                        showInformation: true,
                        message: "Requires a message to commit with",
                        type: common.RejectType.DEFAULT
                    };
                    reject(reason);
                }
                // TODO: make it work with spaces, find what vscode uses
                options.push("-m", msg);
            }
            this.git("commit", options).then(value => {
                resolve(value);
            }, reason => {
                reject(reason);
            });
        });
    }

    // TODO: get branch list??
    public checkoutBranch(branch: string): Promise<string> {
        this.logger.debug(`Checkout Branch:
    Branch: origin/${branch}`);
        return new Promise((resolve, reject) => {
            this.fetch("", ["-fv"]).then(fetchValue => {
                this.checkout(`origin/${branch}`).then(checkoutValue => {
                    this.branch = branch;
                    resolve(checkoutValue);
                }, checkoutReason => {
                    reject(checkoutReason);
                });
            }, fetchReason => {
                reject(fetchReason);
            });
        });
    }

    public checkoutRef(ref: Ref): Promise<string> {
        this.logger.debug(`Checkout Branch:
    ID: ${ref.getId()}
    Patch Set: ${ref.getPatchSet()}`);
        return new Promise((resolve, reject) => {
            this.isDirty().then(clean => {
                if (!clean) {
                    let reason: common.RejectReason = {
                        showInformation: true,
                        message: "Dirty Head",
                        type: common.RejectType.DEFAULT
                    };
                    reject(reason);
                }

                this.setCurrentRef(ref);

                this.fetch(ref.getUrl()).then(fetchValue => {
                    this.checkout("FETCH_HEAD").then(checkoutValue => {
                        resolve(checkoutValue);
                    }, checkoutReason => {
                        reject(checkoutReason);
                    });
                }, fetchReason => {
                    reject(fetchReason);
                });
            }, reason => {
                reject(reason);
            });
        });
    }

    public cherrypickRef(ref: Ref): Promise<string> {
        this.logger.debug(`Cherrypick Branch:
    ID: ${ref.getId()}
    Patch Set: ${ref.getPatchSet()}`);
        return new Promise((resolve, reject) => {
            this.isDirty().then(clean => {
                if (!clean) {
                    let reason: common.RejectReason = {
                        showInformation: true,
                        message: "Dirty Head",
                        type: common.RejectType.DEFAULT
                    };
                    reject(reason);
                }

                this.setCurrentRef(ref);

                this.fetch(ref.getUrl()).then(fetchValue => {
                    this.cherrypick("FETCH_HEAD").then(checkoutValue => {
                        resolve(checkoutValue);
                    }, checkoutReason => {
                        reject(checkoutReason);
                    });
                }, fetchRreason => {
                    reject(fetchRreason);
                });
            }, reason => {
                reject(reason);
            });
        });
    }

    // TODO: fetchRef, using resolver loses `this` instance, find solution
    // private fetchRef(ref: Ref, resolver: (url: string) => Promise<string>): Promise<string> {
    //     return new Promise((resolve, reject) => {
    //         if (this.isDirty()) {
    //             reject("Dirty");
    //         }

    //         this.setCurrentRef(ref);

    //         this.fetch(ref.getUrl()).then(value => {
    //             resolver("FETCH_HEAD").then(value => {
    //                 resolve(value);
    //             }, reason => {
    //                 reject(reason);
    //             });
    //         }, reason => {
    //             reject(reason);
    //         });
    //     });
    // }

    private fetch(url: string, options?: string[]): Promise<string> {
        url = utils.setDefault(url, "");
        options = utils.setDefault(options, []);
        let args: string[] = [
            "origin"
        ];
        if (url.length > 0) {
            args.push(url);
        }
        return this.git("fetch", options, args);
    }

    private checkout(HEAD: string): Promise<string> {
        let args = [
            HEAD
        ];
        return this.git("checkout", [], args);
    }

    private cherrypick(HEAD: string): Promise<string> {
        let args = [
            HEAD
        ];
        return this.git("cherry-pick", [], args);
    }

    // TODO: add check for running cherrypick
    public cherrypickContinue(): Promise<string> {
        let options = [
            "--continue"
        ];
        return this.git("cherry-pick", options);
    }

    // add option to push to current branch in use
    public push(branch: string): Promise<string> {
        let args = [
            "origin",
            `HEAD:refs/for/${branch}`
        ];
        return this.git("push", [], args);
    }

    // TODO: check how rejections are passed through
    public rebase(branch: string): Promise<string> {
        this.logger.debug(`Rebase Branch:
    Branch: origin/${branch}`);
        return this.fetch("", ["-fv"]).then(value => {
            let args: string[] = [
                `origin/${branch}`
            ];
            return this.git("rebase", [], args);
        });
    }

    // TODO: add check for running rebase
    public rebaseContinue(): Promise<string> {
        let options = [
            "--continue"
        ];
        return this.git("rebase", options);
    }

    private git(command: string, options?: string[], args?: string[]): Promise<string> {
        options = utils.setDefault(options, []);
        args = utils.setDefault(args, []);
        return new Promise((resolve, reject) => {
            let fullCmd: string[] = ["git", command];
            fullCmd = fullCmd.concat(options);
            fullCmd.push("--");
            fullCmd = fullCmd.concat(args);
            let cmd = fullCmd.join(" ");
            this.logger.log(cmd);
            exec(cmd, { cwd: this.workspaceRoot }, (error: Error, stdout: Buffer, stderr: Buffer) => {
                if (error === null) {
                    this.logger.log(stdout.toString());
                    resolve(stdout.toString());
                } else {
                    let reason: common.RejectReason = {
                        showInformation: false,
                        message: "Failed Git",
                        type: common.RejectType.GIT,
                        attributes: { error: error, stderr: stderr }
                    };
                    console.warn(reason);
                    this.logger.log([error.name, error.message].join("\n"));
                    reject(reason);
                }
            });
        });
    }

    private generateFetchUrl(): string {
        if (["http", "ssh"].indexOf(this.settings.protocol) === -1) {
            this.logger.log("Incorrect protocol specified");
            this.logger.log("Must be http or ssh");
            throw new Error("Incorrect protocol specified");
        }
        return `${this.settings.protocol}://${this.settings.host}:${(this.settings.protocol === "http")
            ? this.settings.httpPort : this.settings.sshPort}/${this.settings.project}`;
    }

    private get(path: string): Promise<Object> {
        let options: https.RequestOptions = {
            host: this.settings.host,
            port: 443,
            path: path,
            method: "GET",
            headers: {
                "Content-Type": "application/json"
            }
        };
        return new Promise((resolve, reject) => {
            let req = https.get(options, res => {
                let output = "";
                console.log(options.host + ":" + res.statusCode);
                res.setEncoding("utf8");

                res.on("data", (chunk: string) => {
                    output += chunk;
                });

                res.on("end", () => {
                    let data = JSON.parse(output);
                    resolve(data);
                });
            });

            req.on("error", function(err) {
                let reason: common.RejectReason = {
                    showInformation: false,
                    message: "Failed GET",
                    type: common.RejectType.GET,
                    attributes: { error: err }
                };
                reject(err);
            });

            req.end();
        });
    }
}