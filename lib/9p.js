/** @suppress {missingProperties} */
// -------------------------------------------------
// --------------------- 9P ------------------------
// -------------------------------------------------
// Implementation of the 9p filesystem device following the
// 9P2000.L protocol ( https://code.google.com/p/diod/wiki/protocol )

import { LOG_9P } from "./../src/const.js";
import { VirtIO, VIRTIO_F_VERSION_1, VIRTIO_F_RING_EVENT_IDX, VIRTIO_F_RING_INDIRECT_DESC } from "../src/virtio.js";
import * as marshall from "../lib/marshall.js";
import { dbg_log, dbg_assert } from "../src/log.js";
import { h } from "../src/lib.js";

// For Types Only
import { CPU } from "../src/cpu.js";
import { BusConnector } from "../src/bus.js";
import { FS } from "./filesystem.js";

/**
 * @const
 * More accurate filenames in 9p debug messages at the cost of performance.
 */
const TRACK_FILENAMES = false;

// Feature bit (bit position) for mount tag.
const VIRTIO_9P_F_MOUNT_TAG = 0;
// Assumed max tag length in bytes.
const VIRTIO_9P_MAX_TAGLEN = 254;

const MAX_REPLYBUFFER_SIZE = 16 * 1024 * 1024;
const PUTER_DEFAULT_FILE_MODE = 0o100755;
const PUTER_DEFAULT_FOLDER_MODE = 0o40755;

// const FSCACHE = new Map();
const TEXTEN = new TextEncoder();
/**
 * https://nodejs.org/api/path.html#path_path_resolve_paths
 * @param {...string} paths A sequence of paths or path segments.
 * @return {string}
 */
var SLASH = 47;
var DOT = 46;
var getCWD;
if(typeof process !== "undefined" && typeof process.cwd !== "undefined") {
    getCWD = process.cwd;
}
else {
    getCWD = function () {
        var pathname = window.location.pathname;
        return pathname.slice(0, pathname.lastIndexOf("/") + 1);
    };
}
/**
 * Resolves . and .. elements in a path with directory names
 * @param {string} path
 * @param {boolean} allowAboveRoot
 * @return {string}
 */
function normalizeStringPosix(path, allowAboveRoot) {
    var res = "";
    var lastSlash = -1;
    var dots = 0;
    var code = void 0;
    var isAboveRoot = false;
    for(var i = 0; i <= path.length; ++i) {
        if(i < path.length) {
            code = path.charCodeAt(i);
        }
        else if(code === SLASH) {
            break;
        }
        else {
            code = SLASH;
        }
        if(code === SLASH) {
            if(lastSlash === i - 1 || dots === 1) {
                // NOOP
            }
            else if(lastSlash !== i - 1 && dots === 2) {
                if(res.length < 2 || !isAboveRoot ||
                    res.charCodeAt(res.length - 1) !== DOT ||
                    res.charCodeAt(res.length - 2) !== DOT) {
                    if(res.length > 2) {
                        var start = res.length - 1;
                        var j = start;
                        for(; j >= 0; --j) {
                            if(res.charCodeAt(j) === SLASH) {
                                break;
                            }
                        }
                        if(j !== start) {
                            res = (j === -1) ? "" : res.slice(0, j);
                            lastSlash = i;
                            dots = 0;
                            isAboveRoot = false;
                            continue;
                        }
                    }
                    else if(res.length === 2 || res.length === 1) {
                        res = "";
                        lastSlash = i;
                        dots = 0;
                        isAboveRoot = false;
                        continue;
                    }
                }
                if(allowAboveRoot) {
                    if(res.length > 0) {
                        res += "/..";
                    }
                    else {
                        res = "..";
                    }
                    isAboveRoot = true;
                }
            }
            else {
                var slice = path.slice(lastSlash + 1, i);
                if(res.length > 0) {
                    res += "/" + slice;
                }
                else {
                    res = slice;
                }
                isAboveRoot = false;
            }
            lastSlash = i;
            dots = 0;
        }
        else if(code === DOT && dots !== -1) {
            ++dots;
        }
        else {
            dots = -1;
        }
    }
    return res;
}

/**
 * https://nodejs.org/api/path.html#path_path_resolve_paths
 * @param {...string} args A sequence of paths or path segments.
 * @return {string}
 */
function resolvePath(...args) {

    var paths = [];
    for(var _i = 0; _i < args.length; _i++) {
        paths[_i] = args[_i];
    }
    var resolvedPath = "";
    var resolvedAbsolute = false;
    var cwd = void 0;
    for(var i = paths.length - 1; i >= -1 && !resolvedAbsolute; i--) {
        var path = void 0;
        if(i >= 0) {
            path = paths[i];
        }
        else {
            if(cwd === void 0) {
                cwd = getCWD();
            }
            path = cwd;
        }
        // Skip empty entries
        if(path.length === 0) {
            continue;
        }
        resolvedPath = path + "/" + resolvedPath;
        resolvedAbsolute = path.charCodeAt(0) === SLASH;
    }
    // At this point the path should be resolved to a full absolute path, but
    // handle relative paths to be safe (might happen when process.cwd() fails)
    // Normalize the path (removes leading slash)
    resolvedPath = normalizeStringPosix(resolvedPath, !resolvedAbsolute);
    if(resolvedAbsolute) {
        return "/" + resolvedPath;
    }
    else if(resolvedPath.length > 0) {
        return resolvedPath;
    }
    else {
        return ".";
    }
}

// TODO
// flush

export const EPERM = 1;       /* Operation not permitted */
export const ENOENT = 2;      /* No such file or directory */
export const EEXIST = 17;      /* File exists */
export const EINVAL = 22;     /* Invalid argument */
export const EOPNOTSUPP = 95;  /* Operation is not supported */
export const ENOTEMPTY = 39;  /* Directory not empty */
export const EPROTO    = 71;  /* Protocol error */

// Mapping from Filer.js to POSIX
const POSIX_ERR_CODE_MAP = {
    "forbidden": 1,
    "permission_denied": 1,
    "EPERM": 1,

    "subject_does_not_exist": 2, // TODO, ADD MORE PUTER ERROR CODES
    "ENOENT": 2,

    "EBADF": 9, // not possible in puter, possible if the user sends incorrect FID ID

    "EBUSY": 11, // Not possible in puter.

    "field_invalid": 2,
    "EINVAL": 22, //

    "dest_is_not_a_directory": 20,
    "ENOTDIR": 20,

    "cannot_overwrite_a_directory": 19,
    "EISDIR": 21,

    "item_with_same_name_exists": 17,
    "EEXIST": 17,

    "ELOOP": 40, // Too many levels of symbolic links, we dont support symlinks (yet!)

    "not_empty": 39,
    "ENOTEMPTY": 39,

    "EIO": 5, // is possible in puter, not reported properly however.
    "EOPNOTSUPP": 95
};

var P9_SETATTR_MODE = 0x00000001;
var P9_SETATTR_UID = 0x00000002;
var P9_SETATTR_GID = 0x00000004;
var P9_SETATTR_SIZE = 0x00000008;
var P9_SETATTR_ATIME = 0x00000010;
var P9_SETATTR_MTIME = 0x00000020;
var P9_SETATTR_CTIME = 0x00000040;
var P9_SETATTR_ATIME_SET = 0x00000080;
var P9_SETATTR_MTIME_SET = 0x00000100;

var P9_STAT_MODE_DIR = 0x80000000;
var P9_STAT_MODE_APPEND = 0x40000000;
var P9_STAT_MODE_EXCL = 0x20000000;
var P9_STAT_MODE_MOUNT = 0x10000000;
var P9_STAT_MODE_AUTH = 0x08000000;
var P9_STAT_MODE_TMP = 0x04000000;
var P9_STAT_MODE_SYMLINK = 0x02000000;
var P9_STAT_MODE_LINK = 0x01000000;
var P9_STAT_MODE_DEVICE = 0x00800000;
var P9_STAT_MODE_NAMED_PIPE = 0x00200000;
var P9_STAT_MODE_SOCKET = 0x00100000;
var P9_STAT_MODE_SETUID = 0x00080000;
var P9_STAT_MODE_SETGID = 0x00040000;
var P9_STAT_MODE_SETVTX = 0x00010000;

export const P9_LOCK_TYPE_RDLCK = 0;
export const P9_LOCK_TYPE_WRLCK = 1;
export const P9_LOCK_TYPE_UNLCK = 2;
const P9_LOCK_TYPES = ["shared", "exclusive", "unlock"];

const P9_LOCK_FLAGS_BLOCK = 1;
const P9_LOCK_FLAGS_RECLAIM = 2;

export const P9_LOCK_SUCCESS = 0;
export const P9_LOCK_BLOCKED = 1;
export const P9_LOCK_ERROR = 2;
export const P9_LOCK_GRACE = 3;

var FID_NONE = -1;
var FID_INODE = 1;
var FID_XATTR = 2;

function range(size)
{
    return Array.from(Array(size).keys());
}

// https://github.com/darkskyapp/string-hash
function hash32(string) {
    var hash = 5381;
    var i = string.length;

    while(i) {
        hash = (hash * 33) ^ string.charCodeAt(--i);
    }

    /* JavaScript does bitwise operations (like XOR, above) on 32-bit signed
    * integers. Since we want the results to be always positive, convert the
    * signed int to an unsigned by doing an unsigned bitshift. */
    return hash >>> 0;
}

function getQType(type) {
    switch(type) {
        case false:
            return 0x00;
        case true:
            return 0x80;
        default:
            return 0x00;
    }
}

function formatQid(path, stats) {
    if(stats.is_symlink) {
        return {
            type: 0x02,
            version: 0,
            path: hash32(stats.id)
        };
    }
    return {
        type: getQType(stats.is_dir),
        version: 0,
        path: hash32(stats.id)
    };
}

/**
 * @param {CPU} cpu
 * @param {Function} receive
 */
function init_virtio(cpu, configspace_taglen, configspace_tagname, receive)
{
    const virtio = new VirtIO(cpu,
        {
        name: "virtio-9p",
        pci_id: 0x06 << 3,
        device_id: 0x1049,
        subsystem_device_id: 9,
        common:
        {
            initial_port: 0xA800,
            queues:
            [
                {
                    size_supported: 32,
                    notify_offset: 0,
                },
            ],
            features:
            [
                VIRTIO_9P_F_MOUNT_TAG,
                VIRTIO_F_VERSION_1,
                VIRTIO_F_RING_EVENT_IDX,
                VIRTIO_F_RING_INDIRECT_DESC,
            ],
            on_driver_ok: () => {},
        },
        notification:
        {
            initial_port: 0xA900,
            single_handler: false,
            handlers:
            [
                (queue_id) =>
                {
                    if(queue_id !== 0)
                    {
                        dbg_assert(false, "Virtio-Filer-9P Notified for non-existent queue: " + queue_id +
                            " (expected queue_id of 0)");
                        return;
                    }
                    const virtqueue = virtio.queues[0];
                    while(virtqueue.has_request())
                    {
                        const bufchain = virtqueue.pop_request();
                        receive(bufchain);
                    }
                    virtqueue.notify_me_after(0);
                    // Don't flush replies here: async replies are not completed yet.
                },
            ],
        },
        isr_status:
        {
            initial_port: 0xA700,
        },
        device_specific:
        {
            initial_port: 0xA600,
            struct:
            [
                {
                    bytes: 2,
                    name: "mount tag length",
                    read: () => configspace_taglen,
                    write: data => { /* read only */ },
                },
            ].concat(range(VIRTIO_9P_MAX_TAGLEN).map(index =>
                ({
                    bytes: 1,
                    name: "mount tag name " + index,
                    // Note: configspace_tagname may have changed after set_state
                    read: () => configspace_tagname[index] || 0,
                    write: data => { /* read only */ },
                })
            )),
        },
    });
    return virtio;
}

/**
 * @constructor
 *
 * @param {FS} filesystem
 * @param {CPU} cpu
 */
export function Virtio9p(filesystem, cpu, bus) {
    this.puterFS = (window.puter && window.puter.fs) || window.parent.puter.fs;
    window.puterFS = this.puterFS;

    /** @const @type {BusConnector} */
    this.bus = bus;

    this.configspace_tagname = [0x70, 0x75, 0x74, 0x65, 0x72, 0x66, 0x73]; // "puterfs" string
    this.configspace_taglen = this.configspace_tagname.length; // num bytes

    this.virtio = init_virtio(cpu, this.configspace_taglen, this.configspace_tagname, this.ReceiveRequest.bind(this));
    this.virtqueue = this.virtio.queues[0];

    this.VERSION = "9P2000.L";
    this.BLOCKSIZE = 8192; // Let's define one page.
    this.msize = 8192; // maximum message size
    this.replybuffer = new Uint8Array(this.msize*2); // Twice the msize to stay on the safe site
    this.replybuffersize = 0;
    this.fids = {};
    this.pendingTags = {};
}

Virtio9p.prototype.shouldAbortRequest = function(tag) {
    var shouldAbort = !this.pendingTags[tag];
    if(shouldAbort) {
        dbg_log("Request can be aborted tag=" + tag, LOG_9P);
    }
    return shouldAbort;
};

Virtio9p.prototype.get_state = function() {
    var state = [];

    // state[0] = this.configspace_tagname;
    // state[1] = this.configspace_taglen;
    // state[2] = this.virtio;
    // state[3] = this.VERSION;
    // state[4] = this.BLOCKSIZE;
    // state[5] = this.msize;
    // state[6] = this.replybuffer;
    // state[7] = this.replybuffersize;
    // state[8] = this.fids.map(function(f) { return [f.inodeid, f.type, f.uid, f.dbg_name]; });
    // state[9] = this.fs;
    // state[10] = this.sh;
    // state[11] = this.Path;
    // state[12] = this.Buffer;

    state[0] = this.configspace_tagname;
    state[1] = this.configspace_taglen;
    state[2] = this.virtio;
    state[3] = this.VERSION;
    state[4] = this.BLOCKSIZE;
    state[5] = this.msize;
    state[6] = this.replybuffer;
    state[7] = this.replybuffersize;

    if(this.fids.map)
        state[8] = this.fids.map(function(f) { return [f.inodeid, f.type, f.uid, f.dbg_name]; });
    // state[9] = this.fs;

    return state;
};

Virtio9p.prototype.set_state = function(state) {
    this.configspace_tagname = state[0];
    this.configspace_taglen = state[1];
    this.virtio.set_state(state[2]);
    this.virtqueue = this.virtio.queues[0];
    this.VERSION = state[3];
    this.BLOCKSIZE = state[4];
    this.msize = state[5];
    this.replybuffer = state[6];
    this.replybuffersize = state[7];
    this.fids = {};
    this.puterFS = (window.puter && window.puter.fs) || window.parent.puter.fs;
    window.puterFS = this.puterFS;
};

Virtio9p.prototype.Createfid = function(path, type, uid) {
    return { path, type, uid };
};


Virtio9p.prototype.Reset = function() {
    this.fids = {};
};

Virtio9p.prototype.reset = function()
{
    this.fids = [];
    this.virtio.reset();
};

// Before we begin any async file i/o, mark the tag as being pending
Virtio9p.prototype.addTag = function(tag) {
    this.pendingTags[tag] = {};
};

// Flush an inflight async request
Virtio9p.prototype.flushTag = function(tag) {
    delete this.pendingTags[tag];
};

Virtio9p.prototype.BuildReply = function(id, tag, payloadsize) {
    dbg_assert(payloadsize >= 0, "9P: Negative payload size");
    marshall.Marshall(["w", "b", "h"], [payloadsize+7, id+1, tag], this.replybuffer, 0);
    if((payloadsize+7) >= this.replybuffer.length) {
        dbg_log("Error in 9p: payloadsize exceeds maximum length", LOG_9P);
    }
    //for(var i=0; i<payload.length; i++)
    //    this.replybuffer[7+i] = payload[i];
    this.replybuffersize = payloadsize + 7;
};

Virtio9p.prototype.SendError = function(tag, err) {
    //var size = marshall.Marshall(["s", "w"], [errormsg, errorcode], this.replybuffer, 7);
    var errorcode = POSIX_ERR_CODE_MAP[err.code];
    var size = marshall.Marshall(["w"], [errorcode], this.replybuffer, 7);
    this.BuildReply(6, tag, size);
};

Virtio9p.prototype.SendReply = function(bufchain) {
    dbg_assert(this.replybuffersize >= 0, "9P: Negative replybuffersize");
    bufchain.set_next_blob(this.replybuffer.subarray(0, this.replybuffersize));
    this.virtqueue.push_reply(bufchain);
    this.virtqueue.flush_replies();
};

Virtio9p.prototype.ReceiveRequest = async function(bufchain) {
    var self = this;
    // var Path = this.Path;
    // var Buffer = this.buffer;
    // var fs = this.fs;
    var puterFS = this.puterFS;
    // var sh = this.sh;

    // TODO: split into header + data blobs to avoid unnecessary copying.
    const buffer = new Uint8Array(bufchain.length_readable);
    bufchain.get_next_blob(buffer);

    const state = { offset: 0 };
    var header = marshall.Unmarshall(["w", "b", "h"], buffer, state);
    var size = header[0];
    var id = header[1];
    var tag = header[2];
    //dbg_log("size:" + size + " id:" + id + " tag:" + tag, LOG_9P);

    this.addTag(tag);
    // message.Debug("size:" + size + " id:" + id + " tag:" + tag);
    // console.log(header);
    switch(id) {
        case 8: // statfs
            size = 1024; // this.fs.GetTotalSize(); // size used by all files
            var space = 1024 * 1024 * 1024; // this.fs.GetSpace();
            var req = [];
            req[0] = 0x01021997; // fs type
            req[1] = this.BLOCKSIZE; // optimal transfer block size
            req[2] = Math.floor(space / req[1]); // free blocks
            req[3] = req[2] - Math.floor(size / req[1]); // free blocks in fs
            req[4] = req[2] - Math.floor(size / req[1]); // free blocks avail to non-superuser
            req[5] = 1024 * 1024 * 1024; // total number of inodes
            req[6] = 1024 * 1024; // free inodes
            req[7] = 0; // file system id?
            req[8] = 256; // maximum length of filenames

            size = marshall.Marshall(["w", "w", "d", "d", "d", "d", "d", "d", "w"], req, this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(bufchain);
            break;

        case 112: // topen
        case 12: // tlopen
            var req = marshall.Unmarshall(["w", "w"], buffer, state);
            var fid = req[0];
            var mode = req[1];
            var path = this.fids[fid].path;

            dbg_log("[open] fid=" + fid + ", mode=" + mode, LOG_9P);
            dbg_log("file open " + path + " tag:"+tag, LOG_9P);

            puterFS.stat(path).then((stats) => {
                if(self.shouldAbortRequest(tag)) return;

                req[0] = formatQid(path, stats);
                req[1] = self.msize - 24;
                marshall.Marshall(["Q", "w"], req, self.replybuffer, 7);
                self.BuildReply(id, tag, 13 + 4);
                self.SendReply(bufchain);
            }).catch(err => {
                if(self.shouldAbortRequest(tag)) return;
                console.error(err);
                self.SendError(tag, err);
                self.SendReply(bufchain);
            });

            break;

        case 70: // link
            // I'm going to incorrectly treat hardlinks as symlinks
            var req = marshall.Unmarshall(["w", "w", "s"], buffer, state);
            var dfid = req[0];
            var dirPath = self.fids[dfid].path;
            var fid = req[1];
            var existingPath = self.fids[fid].path;
            var name = req[2];
            var newPath = resolvePath(dirPath, name);

            dbg_log("[link] dfid=" + dfid + ", name=" + name, LOG_9P);

            // puterFS.symlink(existingPath, newPath).then(() => {
            //     if(self.shouldAbortRequest(tag)) return;

            //     puterFS.stat(newPath).then((stats) => {
            //         if(self.shouldAbortRequest(tag)) return;

            //         var qid = formatQid(newPath, stats);

            //         marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
            //         self.BuildReply(id, tag, 13);
            //         self.SendReply(bufchain);
            //     }).catch((err) => {
            //         if(self.shouldAbortRequest(tag)) return;

            //         if(err) {
            //             self.SendError(tag, err);
            //             self.SendReply(bufchain);
            //         }
            //     });
            // }).catch((err) => {
            //     if(self.shouldAbortRequest(tag)) return;

            //     if(err) {
            //         self.SendError(tag, err);
            //         self.SendReply(bufchain);
            //     }
            // });
            self.SendError(tag, {code: "EIO"});
            self.SendReply(bufchain);
            break;

        case 16: // symlink
            var req = marshall.Unmarshall(["w", "s", "s", "w"], buffer, state);
            var fid = req[0];
            var path = self.fids[fid].path;
            var name = req[1];
            var newPath = resolvePath(path, name);
            var symtgt = req[2];
            var newtgt = resolvePath(path, symtgt);
            if(symtgt.startsWith("/")) {
                newtgt = symtgt;
            }
            var gid = req[3];

            // dbg_log("[symlink] fid=" + fid + ", name=" + name + ", symgt=" + symgt + ", gid=" + gid, LOG_9P);
            // puterFS.symlink(newtgt, newPath).then(function() {
            //     if(self.shouldAbortRequest(tag)) return;

            //     puterFS.stat(newPath).then(function(stats) {
            //         if(self.shouldAbortRequest(tag)) return;

            //         var qid = formatQid(newPath, stats);

            //         marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
            //         self.BuildReply(id, tag, 13);
            //         self.SendReply(bufchain);
            //     }).catch(function(err) {
            //         if(self.shouldAbortRequest(tag)) return;

            //         if(err) {
            //             self.SendError(tag, err);
            //             self.SendReply(bufchain);
            //         }
            //     });
            // }).catch(function(err) {
            //     if(self.shouldAbortRequest(tag)) return;

            //     if(err) {
            //         self.SendError(tag, err);
            //         self.SendReply(bufchain);
            //     }
            // });

            self.SendError(tag, {code: "EIO"});
            self.SendReply(bufchain);
            break;

        case 18: // mknod
            var req = marshall.Unmarshall(["w", "s", "w", "w", "w", "w"], buffer, state);
            var fid = req[0];
            var filePath = self.fids[fid].path;
            var name = req[1];
            var mode = req[2];
            var major = req[3];
            var minor = req[4];
            var gid = req[5];

            dbg_log("[mknod] fid=" + fid + ", name=" + name + ", major=" + major + ", minor=" + minor+ "", LOG_9P);

            self.SendError(tag, {code: "EOPNOTSUPP"});
            self.SendReply(bufchain);
            break;


        case 22: // TREADLINK
            var req = marshall.Unmarshall(["w"], buffer, state);
            var fid = req[0];
            var path = self.fids[fid].path;

            dbg_log("[readlink] fid=" + fid + " name=" + path, LOG_9P);

            puterFS.stat(path).then(stats => {
                if(self.shouldAbortRequest(tag)) return;
                if(!stats.symlink_path) {
                    self.SendError(tag, {code: "EINVAL"});
                    self.sendReply(bufchain);
                }
                size = marshall.Marshall(["s"], [stats.symlink_path], self.replybuffer, 7);
                self.BuildReply(id, tag, size);
                self.SendReply(bufchain);
            }).catch(err => {
                if(self.shouldAbortRequest(tag)) return;
                if(err) {
                    self.SendError(tag, err);
                    self.sendReply(bufchain);
                }
            });

            break;


        case 72: // tmkdir
            var req = marshall.Unmarshall(["w", "s", "w", "w"], buffer, state);
            var fid = req[0];
            var name = req[1];
            var mode = req[2];
            var gid = req[3];
            var parentPath = self.fids[fid].path;
            var newDir = resolvePath(parentPath, name);

            dbg_log("[mkdir] fid=" + fid + ", name=" + name + ", mode=" + mode + ", gid=" + gid, LOG_9P);

            puterFS.mkdir(newDir).then((stats) => {
                if(self.shouldAbortRequest(tag)) return;

                var qid = formatQid(newDir, stats);
                marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
                self.BuildReply(id, tag, 13);
                self.SendReply(bufchain);

            }).catch(err => {
                if(self.shouldAbortRequest(tag)) return;
                self.SendError(tag, err);
                self.SendReply(bufchain);
            });

            break;

        case 14: // tlcreate
            var req = marshall.Unmarshall(["w", "s", "w", "w", "w"], buffer, state);
            var fid = req[0];
            var name = req[1];
            var flags = req[2];
            var mode = req[3];
            var gid = req[4];

            var newFilePath = resolvePath(self.fids[fid].path, name);

            // the old code doesn't have this line?
            this.bus.send("9p-create", [name, this.fids[fid].inodeid]);
            dbg_log("[create] fid=" + fid + ", name=" + name + ", flags=" + flags + ", mode=" + mode + ", gid=" + gid, LOG_9P);
            puterFS.write(newFilePath, undefined, {overwrite: false}).then((stats) => {
                var qid = formatQid(newFilePath, stats);
                marshall.Marshall(["Q", "w"], [qid, self.msize - 24], self.replybuffer, 7);
                self.fids[fid] = self.Createfid(newFilePath, FID_INODE, uid);
                self.BuildReply(id, tag, 13 + 4);
                self.SendReply(bufchain);
            }).catch((err) => {
                console.error("CREATE FILE ERROR! ", err);
                self.SendError(tag, err);
                self.SendReply(bufchain);
            });
            break;

        case 52: // lock
            // always succeeds
            marshall.Marshall(["b"], [0], this.replybuffer, 7);
            this.BuildReply(id, tag, 1);
            this.SendReply(bufchain);
            break;

        case 54: // getlock
            this.SendError(tag, {code: "EIO"});
            this.SendReply(bufchain);
            break;

        case 24: // getattr
            var req = marshall.Unmarshall(["w", "d"], buffer, state);
            var fid = req[0];
            var path = this.fids[fid].path;

            dbg_log("[getattr]: fid=" + fid + " name=" + path + " request mask=" + req[1], LOG_9P);

            // We ignore the request_mask, and always send back all fields except btime, gen, data_version
            function statsToFileAttributes(stats) {
                // P9_GETATTR_BASIC 0x000007ffULL - Mask for all fields except btime, gen, data_version */
                var valid = 0x000007ff;
                var qid = formatQid(path, stats);

                var mode = PUTER_DEFAULT_FILE_MODE; // unix 644 (NEX)
                if(qid.type === 0x80)
                    mode = PUTER_DEFAULT_FOLDER_MODE; // dir 755

                var uid = 0; // root owns
                var gid = 0;
                var nlink = 1;
                var rdev = (0x0 << 8) | (0x0);
                var size = stats.size;
                var blksize = self.BLOCKSIZE;
                var blocks = Math.floor(size / 512 + 1);
                /** @suppress {missingProperties} */
                var atime_sec = stats.accessed;
                /** @suppress {missingProperties} */
                var atime_nsec = stats.accessed * 1000 * 1000000;
                /** @suppress {missingProperties} */
                var mtime_sec = stats.modified;
                /** @suppress {missingProperties} */
                var mtime_nsec = stats.modified * 1000 * 1000000;
                /** @suppress {missingProperties} */
                var ctime_sec = stats.created;
                /** @suppress {missingProperties} */
                var ctime_nsec = stats.created * 1000 * 1000000;
                // Reserved for future use, not supported by us.
                var btime_sec = 0x0;
                var btime_nsec = 0x0;
                var gen = 0x0;
                var data_version = 0x0;

                return [
                    valid, qid, mode, uid, gid, nlink, rdev, size, blksize,
                    blocks, atime_sec, atime_nsec, mtime_sec, mtime_nsec,
                    ctime_sec, ctime_nsec, btime_sec, btime_nsec, gen,
                    data_version
                ];
            }
            puterFS.stat(path).then(stats => {
                if(self.shouldAbortRequest(tag)) return;

                var p9stats = statsToFileAttributes(stats);

                marshall.Marshall([
                    "d", "Q",
                    "w",
                    "w", "w",
                    "d", "d",
                    "d", "d", "d",
                    "d", "d", // atime
                    "d", "d", // mtime
                    "d", "d", // ctime
                    "d", "d", // btime
                    "d", "d",
                ], p9stats, self.replybuffer, 7);
                self.BuildReply(id, tag, 8 + 13 + 4 + 4 + 4 + 8 * 15);
                self.SendReply(bufchain);
            }).catch(err => {
                if(self.shouldAbortRequest(tag)) return;

                self.SendError(tag, err);
                self.SendReply(bufchain);
            });
            break;

        case 26: // setattr
            var req = marshall.Unmarshall(["w", "w",
                "w", // mode
                "w", "w", // uid, gid
                "d", // size
                "d", "d", // atime
                "d", "d", // mtime
            ], buffer, state);
            var fid = req[0];
            var path = this.fids[fid].path;
            const promises = [];
            dbg_log("[setattr]: fid=" + fid + " request mask=" + req[1] + " name=" + path, LOG_9P);
            if(req[1] & P9_SETATTR_SIZE) {
                promises.push(
                    new Promise(function(resolve, reject) {
                        var size = req[5];

                        dbg_log("[setattr]: size=" + size, LOG_9P);
                        puterFS.read(path)
                            .then(blob => blob.arrayBuffer())
                            .then(dat => {
                                puterFS.write(path,new window.parent.Blob([dat.slice(0,size)]), {overwrite: true, dedupeName: false})
                                    .then(() => {
                                        resolve();
                                    })
                                    .catch(err => {
                                        reject(err);
                                    });
                            });
                    })
                );
            } else {
                console.error("UNSUPPORTED 9P SETATTR!: ", req);
                promises.push(
                    new Promise(function(resolve, reject) {
                        resolve();
                        // reject({code: "EOPNOTSUPP"}); // crashes git?
                    }));
            }
            Promise.all(promises)
                .then(function() {
                    self.BuildReply(id, tag, 0);
                    self.SendReply(bufchain);
                })
                .catch(function(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                });
        break;

        case 50: // fsync
            var req = marshall.Unmarshall(["w", "d"], buffer, state);
            var fid = req[0];
            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;

        case 40: // TREADDIR
            var req = marshall.Unmarshall(["w", "d", "w"], buffer, state);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            var path = this.fids[fid].path;
            // Directory entries are represented as variable-length records:
            // qid[13] offset[8] type[1] name[s]
            puterFS.readdir(path)
                .then((entries) => {
                    if(self.shouldAbortRequest(tag)) {
                        return;
                    }

                    // first get size
                    var size = entries.reduce(function(currentValue, entry) {
                        return currentValue + 13 + 8 + 1 + 2 + TEXTEN.encode(entry.name).length;
                    }, 0);

                    // Deal with . and ..
                    size += 13 + 8 + 1 + 2 + 1; // "." entry
                    size += 13 + 8 + 1 + 2 + 2; // ".." entry
                    var data = new Uint8Array(size);
                    // Get info for '.'
                    puterFS.stat(path).then(function(stats) {
                        if(self.shouldAbortRequest(tag)) {
                            return;
                        }

                        var dataOffset = 0x0;

                        dataOffset += marshall.Marshall(
                            ["Q", "d", "b", "s"],
                            [
                                formatQid(path, stats),
                                dataOffset + 13 + 8 + 1 + 2 + 1,
                                (stats.is_dir ? PUTER_DEFAULT_FOLDER_MODE: PUTER_DEFAULT_FILE_MODE) >> 12,
                                "."
                            ],
                            data, dataOffset);

                        // Get info for '..'
                        var parentDirPath = resolvePath("..", path);
                        puterFS.stat(path).then(function(stats) {
                            if(self.shouldAbortRequest(tag)) {
                                return;
                            }

                            dataOffset += marshall.Marshall(
                                ["Q", "d", "b", "s"],
                                [
                                    formatQid(parentDirPath, stats),
                                    dataOffset + 13 + 8 + 1 + 2 + 2,
                                    (stats.is_dir ? PUTER_DEFAULT_FOLDER_MODE: PUTER_DEFAULT_FILE_MODE) >> 12,
                                    ".."
                                ],
                                data, dataOffset);

                            entries.forEach(function(entry) {
                                // var entryPath = resolvePath(path, entry.name);
                                dataOffset += marshall.Marshall(
                                    ["Q", "d", "b", "s"],
                                    [
                                        formatQid(entry.path, entry),
                                        dataOffset + 13 + 8 + 1 + 2 + TEXTEN.encode(entry.name).length,
                                        (entry.is_dir ? PUTER_DEFAULT_FOLDER_MODE: PUTER_DEFAULT_FILE_MODE) >> 12,
                                        entry.name
                                    ],
                                    data, dataOffset);
                            });

                            // sometimes seems to break stuff but is in old code?
                            // as a VERY HACKY fix I have used Math.abs but this definitely should NOT be happening
                            if(size < offset + count) {
                                // console.warn("size<offset+count !", "size=" + size, "offset=" + offset, "count=" + count);
                                if(size > offset) {
                                    count = size - offset;
                                } else {
                                    count = 0;
                                }
                            }
                            if(data) {
                                for(var i = 0; i < count; i++)
                                    self.replybuffer[7 + 4 + i] = data[offset + i];
                            }

                            marshall.Marshall(["w"], [count], self.replybuffer, 7);
                            self.BuildReply(id, tag, 4 + count);
                            self.SendReply(bufchain);
                        }).catch(err => {
                            if(self.shouldAbortRequest(tag)) {
                                return;
                            }
                            self.SendError(tag, err);
                            self.SendReply(bufchain);
                        });
                    });

                }).catch(err => {
                    if(self.shouldAbortRequest(tag)) {
                        return;
                    }
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                });
            break;
        case 116: // read
            var req = marshall.Unmarshall(["w", "d", "w"], buffer, state);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];

            var fidata = this.fids[fid];
            var path = fidata.path;

            dbg_log("[read]: fid=" + fid + " offset=" + offset + " count=" + count, LOG_9P);

            function _read(data) {
                var size = data.length;

                if(offset + count > size) {
                    count = size - offset;
                }

                for(var i = 0; i < count; i++)
                    self.replybuffer[7 + 4 + i] = data[offset + i];

                marshall.Marshall(["w"], [count], self.replybuffer, 7);
                self.BuildReply(id, tag, 4 + count);
                self.SendReply(bufchain);
            }

            if(!fidata.rcache) {
                puterFS.read(path)
                    .then(blob => blob.arrayBuffer())
                    .then(function(dat) {
                        const data2 = new Uint8Array(dat);
                        if(self.shouldAbortRequest(tag)) return;

                        fidata.rcache = {data: data2, remaining: data2.byteLength};
                        _read(data2);
                    }).catch(err => {
                        if(self.shouldAbortRequest(tag)) return;
                        self.SendError(tag, err);
                        self.SendReply(bufchain);
                    });
            } else {
                const file = fidata.rcache;
                _read(file.data);
            }

            break;
        case 118: // write
            var req = marshall.Unmarshall(["w", "d", "w"], buffer, state);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            var path = self.fids[fid].path;
            var fidata = this.fids[fid];

            dbg_log("[write]: fid=" + fid + " offset=" + offset + " count=" + count + " fidtype=" + this.fids[fid].type, LOG_9P);
            if(!fidata.wops) {
                fidata.wops = [];
            }
            var data = buffer.slice(state.offset);

            fidata.wops.push({
                data: data,
                count: count,
                offset: offset
            });
            marshall.Marshall(["w"], [data.length], self.replybuffer, 7);
            self.BuildReply(id, tag, 4);
            self.SendReply(bufchain);
            break;

        case 74: // RENAMEAT
            var req = marshall.Unmarshall(["w", "s", "w", "s"], buffer, state);
            var olddirfid = req[0];
            var oldname = req[1];
            var oldPath = resolvePath(self.fids[olddirfid].path, oldname);
            var newdirfid = req[2];
            var newname = req[3];
            var newPath = resolvePath(self.fids[newdirfid].path, newname);
            dbg_log("[renameat]: oldname=" + oldname + " newname=" + newname, LOG_9P);

            puterFS.move(oldPath, newPath, {overwrite: true, dedupeName: false}).then(function() {
                if(self.shouldAbortRequest(tag)) return;

                self.BuildReply(id, tag, 0);
                self.SendReply(bufchain);
            }).catch(err => {
                console.error("MOVEOP ERR: " + err);
                if(self.shouldAbortRequest(tag)) return;
                self.SendError(tag, err);
                self.SendReply(bufchain);
            });

            break;

        case 76: // TUNLINKAT
            var req = marshall.Unmarshall(["w", "s", "w"], buffer, state);
            var dirfd = req[0];
            var name = req[1];
            var flags = req[2];
            var path = resolvePath(self.fids[dirfd].path, name);

            dbg_log("[unlink]: dirfd=" + dirfd + " name=" + name + " flags=" + flags, LOG_9P);

            puterFS.delete(path, {recursive: false})
                .then(() => {
                    if(self.shouldAbortRequest(tag)) return;
                    self.BuildReply(id, tag, 0);
                    self.SendReply(bufchain);
                }).catch((err) => {
                    if(self.shouldAbortRequest(tag)) return;
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                });

            break;

        case 100: // version
            var version = marshall.Unmarshall(["w", "s"], buffer, state);
            dbg_log("[version]: msize=" + version[0] + " version=" + version[1], LOG_9P);
            if(this.msize !== version[0])
            {
                this.msize = version[0];
                this.replybuffer = new Uint8Array(Math.min(MAX_REPLYBUFFER_SIZE, this.msize*2));
            }
            size = marshall.Marshall(["w", "s"], [this.msize, this.VERSION], this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(bufchain);
            break;

        case 104: // attach
            // return root directorie's QID
            var req = marshall.Unmarshall(["w", "w", "s", "s", "w"], buffer, state);
            var fid = req[0];
            var uid = req[4];
            dbg_log("[attach]: fid=" + fid + " afid=" + h(req[1]) + " uname=" + req[2] + " aname=" + req[3], LOG_9P);
            this.fids[fid] = this.Createfid("/", FID_INODE, uid);
            puterFS.stat("/")
                .then(function(stats) {
                    if(self.shouldAbortRequest(tag)) return;

                    var qid = formatQid("/", stats);

                    marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
                    self.BuildReply(id, tag, 13);
                    self.SendReply(bufchain);
                    self.bus.send("9p-attach");
                }).catch(err => {

                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                });
            break;

        case 108: // tflush
            var req = marshall.Unmarshall(["h"], buffer, state);
            var oldtag = req[0];
            this.flushTag(oldtag);
            dbg_log("[flush] " + tag, LOG_9P);

            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;


        case 110: // walk
            var req = marshall.Unmarshall(["w", "w", "h"], buffer, state);
            var fid = req[0];
            var nwfid = req[1];
            var nwname = req[2];
            dbg_log("[walk]: fid=" + req[0] + " nwfid=" + req[1] + " nwname=" + nwname, LOG_9P);
            if(nwname === 0) {
                this.fids[nwfid] = this.Createfid(this.fids[fid].path, FID_INODE, this.fids[fid].uid);
                //this.fids[nwfid].inodeid = this.fids[fid].inodeid;
                marshall.Marshall(["h"], [0], this.replybuffer, 7);
                this.BuildReply(id, tag, 2);
                this.SendReply(bufchain);
                break;
            }
            var wnames = [];
            for(var i = 0; i < nwname; i++) {
                wnames.push("s");
            }
            var walk = marshall.Unmarshall(wnames, buffer, state);
            var path = this.fids[fid].path;

            var offset = 7 + 2;
            var nwidx = 0;

            dbg_log("walk in dir " + path  + " to: " + walk.toString(), LOG_9P);
            function _walk(path, pathParts) {
                var part = pathParts.shift();

                if(!part) {
                    marshall.Marshall(["h"], [nwidx], self.replybuffer, 7);
                    self.BuildReply(id, tag, offset - 7);
                    self.SendReply(bufchain);
                    return;
                }

                path = resolvePath(path, part);
                puterFS.stat(path)
                    .then(function(stats) {
                        if(self.shouldAbortRequest(tag)) {
                            return;
                        }

                        var qid = formatQid(path, stats);

                        self.fids[nwfid] = self.Createfid(path, FID_INODE, 0);
                        offset += marshall.Marshall(["Q"], [qid], self.replybuffer, offset);
                        nwidx++;
                        _walk(path, pathParts);
                    }).catch(err => {
                        if(self.shouldAbortRequest(tag)) {
                            return;
                        }
                        self.SendError(tag, err);
                        self.SendReply(bufchain);
                    });
            }

            _walk(path, walk);
            break;

        case 120: // clunk (means close FID)
            var req = marshall.Unmarshall(["w"], buffer, state);
            dbg_log("[clunk]: fid=" + req[0], LOG_9P);
            var fid = req[0];
            var fidata = self.fids[fid];
            if(fidata.wops) {
                puterFS.read(fidata.path)
                    .then(blob => blob.arrayBuffer())
                    .then(arrBuf => {
                        const dat = new Uint8Array(arrBuf);
                        // Calculate length of file to write
                        let length = dat.length;
                        for(const wop of fidata.wops) {
                            const newLen = wop.offset + wop.count;
                            if(newLen > length) {
                                length = newLen;
                            }
                        }

                        const data = new Uint8Array(length); // set old data
                        data.set(dat, 0);
                        for(const wop of fidata.wops) { // set new data ontop of old data
                            data.set(wop.data, wop.offset);
                        }

                        const finalized = new window.parent.Blob([data]); // so instanceof lines up
                        puterFS.write(fidata.path, finalized, {overwrite: true, dedupeName: false, createMissingParents: true})
                            .then(() => {
                                delete self.fids[fid];
                                this.BuildReply(id, tag, 0);
                                this.SendReply(bufchain);
                            }).catch(err => {
                                console.error("FD WRITE&CLOSE ERROR! ", err);
                                this.BuildReply(id, tag, 0);
                                this.SendReply(bufchain);
                                delete self.fids[fid];
                            });


                    }).catch((err) => {
                        console.error(err);
                        delete self.fids[fid];
                        this.BuildReply(id, tag, 0);
                        this.SendReply(bufchain);
                    });

            } else {
                delete self.fids[fid];
                this.BuildReply(id, tag, 0);
                this.SendReply(bufchain);
            }

            break;

        case 32: // txattrcreate
            var req = marshall.Unmarshall(["w", "s", "d", "w"], buffer, state);
            var fid = req[0];
            var name = req[1];
            var attr_size = req[2];
            var flags = req[3];
            dbg_log("[txattrcreate]: fid=" + fid + " name=" + name + " attr_size=" + attr_size + " flags=" + flags, LOG_9P);

            // XXX: xattr not supported yet. E.g. checks corresponding to the flags needed.
            this.fids[fid].type = FID_XATTR;

            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;

        case 30: // xattrwalk
            var req = marshall.Unmarshall(["w", "w", "s"], buffer, state);
            var fid = req[0];
            var newfid = req[1];
            var name = req[2];
            dbg_log("[xattrwalk]: fid=" + req[0] + " newfid=" + req[1] + " name=" + req[2], LOG_9P);

            // Workaround for Linux restarts writes until full blocksize
            this.SendError(tag, { code: "EOPNOTSUPP" });
            this.SendReply(bufchain);
            break;

        default:
            dbg_log("Error in Virtio9p: Unknown id " + id + " received", LOG_9P);
            dbg_assert(false);
            //this.SendError(tag, "Operation i not supported",  EOPNOTSUPP);
            //this.SendReply(bufchain);
            break;
    }

    //consistency checks if there are problems with the filesystem
    //this.fs.Check();
};

/** @typedef {function(Uint8Array, function(Uint8Array):void):void} */
let P9Handler;

/**
 * @constructor
 *
 * @param {P9Handler} handle_fn
 * @param {CPU} cpu
 */
export function Virtio9pHandler(handle_fn, cpu) {
    /** @type {P9Handler} */
    this.handle_fn = handle_fn;
    this.tag_bufchain = new Map();

    this.configspace_tagname = [0x68, 0x6F, 0x73, 0x74, 0x39, 0x70]; // "host9p" string
    this.configspace_taglen = this.configspace_tagname.length; // num bytes

    this.virtio = init_virtio(
        cpu,
        this.configspace_taglen,
        this.configspace_tagname,
        async (bufchain) => {
            // TODO: split into header + data blobs to avoid unnecessary copying.
            const reqbuf = new Uint8Array(bufchain.length_readable);
            bufchain.get_next_blob(reqbuf);

            var reqheader = marshall.Unmarshall(["w", "b", "h"], reqbuf, { offset : 0 });
            var reqtag = reqheader[2];

            this.tag_bufchain.set(reqtag, bufchain);
            this.handle_fn(reqbuf, (replybuf) => {
                var replyheader = marshall.Unmarshall(["w", "b", "h"], replybuf, { offset: 0 });
                var replytag = replyheader[2];

                const bufchain = this.tag_bufchain.get(replytag);
                if(!bufchain)
                {
                    console.error("No bufchain found for tag: " + replytag);
                    return;
                }

                bufchain.set_next_blob(replybuf);
                this.virtqueue.push_reply(bufchain);
                this.virtqueue.flush_replies();

                this.tag_bufchain.delete(replytag);
            });
        }
    );
    this.virtqueue = this.virtio.queues[0];
}

Virtio9pHandler.prototype.get_state = function()
{
    var state = [];

    state[0] = this.configspace_tagname;
    state[1] = this.configspace_taglen;
    state[2] = this.virtio;
    state[3] = this.tag_bufchain;

    return state;
};

Virtio9pHandler.prototype.set_state = function(state)
{
    this.configspace_tagname = state[0];
    this.configspace_taglen = state[1];
    this.virtio.set_state(state[2]);
    this.virtqueue = this.virtio.queues[0];
    this.tag_bufchain = state[3];
};


Virtio9pHandler.prototype.reset = function()
{
    this.virtio.reset();
};


/**
 * @constructor
 *
 * @param {string} url
 * @param {CPU} cpu
 */
export function Virtio9pProxy(url, cpu)
{
    this.socket = undefined;
    this.cpu = cpu;

    // TODO: circular buffer?
    this.send_queue = [];
    this.url = url;

    this.reconnect_interval = 10000;
    this.last_connect_attempt = Date.now() - this.reconnect_interval;
    this.send_queue_limit = 64;
    this.destroyed = false;

    this.tag_bufchain = new Map();

    this.configspace_tagname = [0x68, 0x6F, 0x73, 0x74, 0x39, 0x70]; // "host9p" string
    this.configspace_taglen = this.configspace_tagname.length; // num bytes

    this.virtio = init_virtio(
        cpu,
        this.configspace_taglen,
        this.configspace_tagname,
        async (bufchain) => {
            // TODO: split into header + data blobs to avoid unnecessary copying.
            const reqbuf = new Uint8Array(bufchain.length_readable);
            bufchain.get_next_blob(reqbuf);

            const reqheader = marshall.Unmarshall(["w", "b", "h"], reqbuf, { offset : 0 });
            const reqtag = reqheader[2];

            this.tag_bufchain.set(reqtag, bufchain);
            this.send(reqbuf);
        }
    );
    this.virtqueue = this.virtio.queues[0];
}

Virtio9pProxy.prototype.get_state = function()
{
    var state = [];

    state[0] = this.configspace_tagname;
    state[1] = this.configspace_taglen;
    state[2] = this.virtio;
    state[3] = this.tag_bufchain;

    return state;
};

Virtio9pProxy.prototype.set_state = function(state)
{
    this.configspace_tagname = state[0];
    this.configspace_taglen = state[1];
    this.virtio.set_state(state[2]);
    this.virtqueue = this.virtio.queues[0];
    this.tag_bufchain = state[3];
};

Virtio9pProxy.prototype.reset = function() {
    this.virtio.reset();
};

Virtio9pProxy.prototype.handle_message = function(e)
{
    const replybuf = new Uint8Array(e.data);
    const replyheader = marshall.Unmarshall(["w", "b", "h"], replybuf, { offset: 0 });
    const replytag = replyheader[2];

    const bufchain = this.tag_bufchain.get(replytag);
    if(!bufchain)
    {
        console.error("Virtio9pProxy: No bufchain found for tag: " + replytag);
        return;
    }

    bufchain.set_next_blob(replybuf);
    this.virtqueue.push_reply(bufchain);
    this.virtqueue.flush_replies();

    this.tag_bufchain.delete(replytag);
};

Virtio9pProxy.prototype.handle_close = function(e)
{
    //console.log("onclose", e);

    if(!this.destroyed)
    {
        this.connect();
        setTimeout(this.connect.bind(this), this.reconnect_interval);
    }
};

Virtio9pProxy.prototype.handle_open = function(e)
{
    //console.log("open", e);

    for(var i = 0; i < this.send_queue.length; i++)
    {
        this.send(this.send_queue[i]);
    }

    this.send_queue = [];
};

Virtio9pProxy.prototype.handle_error = function(e)
{
    //console.log("onerror", e);
};

Virtio9pProxy.prototype.destroy = function()
{
    this.destroyed = true;
    if(this.socket)
    {
        this.socket.close();
    }
};

Virtio9pProxy.prototype.connect = function()
{
    if(typeof WebSocket === "undefined")
    {
        return;
    }

    if(this.socket)
    {
        var state = this.socket.readyState;

        if(state === 0 || state === 1)
        {
            // already or almost there
            return;
        }
    }

    var now = Date.now();

    if(this.last_connect_attempt + this.reconnect_interval > now)
    {
        return;
    }

    this.last_connect_attempt = Date.now();

    try
    {
        this.socket = new WebSocket(this.url);
    }
    catch(e)
    {
        console.error(e);
        return;
    }

    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = this.handle_open.bind(this);
    this.socket.onmessage = this.handle_message.bind(this);
    this.socket.onclose = this.handle_close.bind(this);
    this.socket.onerror = this.handle_error.bind(this);
};

Virtio9pProxy.prototype.send = function(data)
{
    //console.log("send", data);

    if(!this.socket || this.socket.readyState !== 1)
    {
        this.send_queue.push(data);

        if(this.send_queue.length > 2 * this.send_queue_limit)
        {
            this.send_queue = this.send_queue.slice(-this.send_queue_limit);
        }

        this.connect();
    }
    else
    {
        this.socket.send(data);
    }
};

Virtio9pProxy.prototype.change_proxy = function(url)
{
    this.url = url;

    if(this.socket)
    {
        this.socket.onclose = function() {};
        this.socket.onerror = function() {};
        this.socket.close();
        this.socket = undefined;
    }
};
