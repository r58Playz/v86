import { VirtIO, VIRTIO_F_VERSION_1 } from "./virtio.js";
import * as marshall from "../lib/marshall.js";
import { dbg_assert, dbg_log } from "./log.js";
import { h } from "./lib.js";
import { LOG_VIRTIO } from "./const.js";

import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";
import { ScreenAdapter } from "./browser/screen.js";
import { VirtQueueBufferChain } from "./virtio.js";
import { VGAScreen } from "./vga.js";

// https://docs.oasis-open.org/virtio/virtio/v1.4/csprd01/virtio-v1.4-csprd01.html#x1-4730007

const VIRTIO_GPU_F_VIRGL = 0;
const VIRTIO_GPU_F_EDID = 1;
const VIRTIO_GPU_F_RESOURCE_UUID = 2;
const VIRTIO_GPU_F_RESOURCE_BLOB = 3;
const VIRTIO_GPU_F_CONTEXT_INIT = 4;
const VIRTIO_GPU_F_BLOB_ALIGNMENT = 5;

const VIRTIO_GPU_EVENT_DISPLAY = 1 << 0;

const VIRTIO_GPU_SHM_ID_UNDEFINED = 0;
const VIRTIO_GPU_SHM_ID_HOST_VISIBLE = 1;

const VIRTIO_GPU_CMD_GET_DISPLAY_INFO = 0x0100;
const VIRTIO_GPU_CMD_RESOURCE_CREATE_2D = 0x0101;
const VIRTIO_GPU_CMD_RESOURCE_UNREF = 0x0102;
const VIRTIO_GPU_CMD_SET_SCANOUT = 0x0103;
const VIRTIO_GPU_CMD_RESOURCE_FLUSH = 0x0104;
const VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D = 0x0105;
const VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING = 0x0106;
const VIRTIO_GPU_CMD_RESOURCE_DETACH_BACKING = 0x0107;
const VIRTIO_GPU_CMD_GET_CAPSET_INFO = 0x0108;
const VIRTIO_GPU_CMD_GET_CAPSET = 0x0109;
const VIRTIO_GPU_CMD_GET_EDID = 0x010A;
const VIRTIO_GPU_CMD_RESOURCE_ASSIGN_UUID = 0x010B;
const VIRTIO_GPU_CMD_RESOURCE_CREATE_BLOB = 0x010C;
const VIRTIO_GPU_CMD_SET_SCANOUT_BLOB = 0x010D;

const VIRTIO_GPU_CMD_CTX_CREATE = 0x0200;
const VIRTIO_GPU_CMD_CTX_DESTROY = 0x0201;
const VIRTIO_GPU_CMD_CTX_ATTACH_RESOURCE = 0x0202;
const VIRTIO_GPU_CMD_CTX_DETACH_RESOURCE = 0x0203;
const VIRTIO_GPU_CMD_RESOURCE_CREATE_3D = 0x0204;
const VIRTIO_GPU_CMD_TRANSFER_TO_HOST_3D = 0x0205;
const VIRTIO_GPU_CMD_TRANSFER_FROM_HOST_3D = 0x0206;
const VIRTIO_GPU_CMD_SUBMIT_3D = 0x0207;
const VIRTIO_GPU_CMD_RESOURCE_MAP_BLOB = 0x0208;
const VIRTIO_GPU_CMD_RESOURCE_UNMAP_BLOB = 0x0209;

const VIRTIO_GPU_CMD_UPDATE_CURSOR = 0x0300;
const VIRTIO_GPU_CMD_MOVE_CURSOR = 0x0301;

const VIRTIO_GPU_RESP_OK_NODATA = 0x1100;
const VIRTIO_GPU_RESP_OK_DISPLAY_INFO = 0x1101;
const VIRTIO_GPU_RESP_OK_CAPSET_INFO = 0x1102;
const VIRTIO_GPU_RESP_OK_CAPSET = 0x1103;
const VIRTIO_GPU_RESP_OK_EDID = 0x1104;
const VIRTIO_GPU_RESP_OK_RESOURCE_UUID = 0x1105;
const VIRTIO_GPU_RESP_OK_MAP_INFO = 0x1106;

const VIRTIO_GPU_RESP_ERR_UNSPEC = 0x1200;
const VIRTIO_GPU_RESP_ERR_OUT_OF_MEMORY = 0x1201;
const VIRTIO_GPU_RESP_ERR_INVALID_SCANOUT_ID = 0x1202;
const VIRTIO_GPU_RESP_ERR_INVALID_RESOURCE_ID = 0x1203;
const VIRTIO_GPU_RESP_ERR_INVALID_CONTEXT_ID = 0x1204;
const VIRTIO_GPU_RESP_ERR_INVALID_PARAMETER = 0x1205;

const VIRTIO_GPU_FLAG_FENCE = 1 << 0;
const VIRTIO_GPU_FLAG_INFO_RING_IDX = 1 << 1;

const VIRTIO_GPU_MAX_SCANOUTS = 16;

const VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM = 1;
const VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM = 2;
const VIRTIO_GPU_FORMAT_A8R8G8B8_UNORM = 3;
const VIRTIO_GPU_FORMAT_X8R8G8B8_UNORM = 4;
const VIRTIO_GPU_FORMAT_R8G8B8A8_UNORM = 67;
const VIRTIO_GPU_FORMAT_X8B8G8R8_UNORM = 68;
const VIRTIO_GPU_FORMAT_A8B8G8R8_UNORM = 121;
const VIRTIO_GPU_FORMAT_R8G8B8X8_UNORM = 134;

/**
 * @typedef {
 * {
 *     type: number,
 *     flags: number,
 *     fence_id: number,
 *     ctx_id: number,
 *     ring_idx: number,
 *     packet: !Uint8Array,
 *     bufchain: VirtQueueBufferChain,
 * }}
 */
var IncomingPacket;

/**
 * @typedef {
 * {
 *     flags: (undefined | number),
 *     fence_id: (undefined | number),
 *     ctx_id: (undefined | number),
 *     ring_idx: (undefined | number)
 * }}
 */
var PacketSendOptions;

/**
 * needed because wasm memory resizes invalidate all arraybuffer references
 *
 * @typedef {function(): Uint8Array}
 */
var LazyBuffer;

/**
 * @typedef {
 * {
 *     buffer: LazyBuffer,
 *     alloc: function(number): LazyBuffer,
 *     dealloc: function(LazyBuffer): void,
 * }}
 */
var GpuBackendBuffer;

/**
 * @typedef {
 * {
 *     create_context: function(),
 * }}
 */
var GpuBackendGlAccel;

/**
 * @typedef {
 * {
 *     buffer: (undefined | GpuBackendBuffer),
 *     glaccel: (undefined | GpuBackendGlAccel),
 * }}
 */
var GpuBackend;

/**
 * @typedef {
 * {
 *     x: number,
 *     y: number,
 *     width: number,
 *     height: number,
 *     resource: number,
 * }}
 */
var GpuDisplayScanoutInfo;

/**
 * @typedef {
 * {
 *     screen: (undefined | ScreenAdapter),
 *     width: number,
 *     height: number,
 *     x: number,
 *     y: number,
 *     enabled: boolean,
 *     flags: number,
 *     scanout: (undefined | GpuDisplayScanoutInfo),
 * }}
 */
var GpuDisplay;

/**
 * @typedef {
 * {
 *     address: number,
 *     length: number,
 * }}
 */
var GpuGuestBackingBufferInfo;

/**
 * @typedef {
 * {
 *     format: number,
 *     width: number,
 *     height: number,
 *     guest_backing: !Array<GpuGuestBackingBufferInfo>,
 *     host_backing: LazyBuffer,
 *     host_image_data: ImageData,
 *     host_backing_len: number,
 * }}
 */
var Gpu2dResource;

/**
 * @constructor
 *
 * @param {CPU} cpu
 * @param {BusConnector} bus
 * @param {GpuBackend} backend
 * @param {number} vga_memory_size
 * @param {ScreenAdapter} screen
 * @param {number} width
 * @param {number} height
 */
export function VirtioGpu(cpu, bus, backend, vga_memory_size, screen, width, height) {
    if(!backend) {
        backend = {};
    }

    dbg_assert(backend.glaccel ? !!backend.buffer : true, "virtio-gpu: gpu acceleration requires a custom buffer");

    this.cpu = cpu;

    this.buffer = backend.buffer || {
        buffer: () => new Uint8Array(cpu.wasm_memory.buffer),
        alloc(size) {
            let offset = cpu.wm.exports["v86_malloc"](size);
            return () => this.buffer().subarray(offset, offset + size);
        },
        dealloc(buf) {
            cpu.wm.exports["v86_free"](buf().byteOffset);
        }
    };
    this.glaccel = backend.glaccel;

    this.vga_compat_enabled = true;

    this.events = 0;

    /**
     * @type {!Array<(Gpu2dResource | undefined)>}
     */
    this.resources = [];

    /**
     * @type {!Array<GpuDisplay>}
     */
    this.displays = [
        { screen, width, height, x: 0, y: 0, enabled: true, flags: 0 }
    ];
    for(let i = this.displays.length; i < VIRTIO_GPU_MAX_SCANOUTS; i++) {
        this.displays[i] = { width: 0, height: 0, x: 0, y: 0, enabled: false, flags: 0 };
    }

    this.virtio = new VirtIO(cpu,
        {
            name: "virtio-gpu",
            pci_id: 0x0D << 3,
            device_id: 0x1050,
            subsystem_device_id: 16,
            common:
            {
                bar_override: 1,
                initial_port: 0xE800,
                features:
                    [
                        VIRTIO_F_VERSION_1
                    ],
                queues:
                    [
                        {
                            size_supported: 32,
                            notify_offset: 0,
                        },
                        {
                            size_supported: 32,
                            notify_offset: 1,
                        }
                    ],
                on_driver_ok: () => { }
            },
            notification:
            {
                bar_override: 2,
                initial_port: 0xE900,
                single_handler: true,
                handlers:
                    [
                        (queue) => {
                            while(this.virtio.queues[queue].has_request()) {
                                this.process_request(queue);
                            }
                            this.virtio.queues[queue].flush_replies();
                        }
                    ]
            },
            isr_status:
            {
                bar_override: 3,
                initial_port: 0xE700,
            },
            device_specific:
            {
                bar_override: 4,
                initial_port: 0xE600,
                struct:
                    [
                        {
                            bytes: 4,
                            name: "events_read",
                            read: () => this.events,
                            write: () => { /* read only */ }
                        },
                        {
                            bytes: 4,
                            name: "events_clear",
                            read: () => 0 /* undefined? */,
                            write: (val) => { this.events &= ~val; }
                        },
                        {
                            bytes: 4,
                            name: "num_scanouts",
                            read: () => 1,
                            write: () => { /* read only */ }
                        },
                        {
                            bytes: 4,
                            name: "num_capsets",
                            read: () => 0,
                            write: () => { /* read only */ }
                        }
                    ]
            },
            /*
            shmem:
            {
                bar_override: 5,
                initial_port: 0xC0000000,
                id: VIRTIO_GPU_SHM_ID_HOST_VISIBLE,
                backing: new Uint8Array() // TODO
            }
            */
            custom_register: (virtio) => {
                this.vga = new VGAScreen(cpu, bus, screen, vga_memory_size, (vga) => {
                    // BAR0
                    virtio.pci_bars[0] = vga.pci_bars[0];
                    virtio.pci_space[16] = vga.pci_space[16];
                    virtio.pci_space[17] = vga.pci_space[17];
                    virtio.pci_space[18] = vga.pci_space[18];
                    virtio.pci_space[19] = vga.pci_space[19];

                    virtio.pci_rom_size = vga.pci_rom_size;
                    virtio.pci_rom_address = vga.pci_rom_address;
                });
                // Prog IF - VGA Controller
                virtio.pci_space[9] = 0x0;
                // Subclass - VGA Compatible Controller
                virtio.pci_space[10] = 0x0;
                // Class - Display Controller
                virtio.pci_space[11] = 0x3;

                cpu.devices.pci.register_device(virtio);
            }
        });
}

const CMD_HEADER_SIZE = 4 + 4 + 8 + 4 + 1 + 3;
/**
 * @param {number} queue_id
 *
 * @returns {IncomingPacket}
 */
VirtioGpu.prototype.read_packet = function (queue_id) {
    let queue = this.virtio.queues[queue_id];
    dbg_assert(queue.has_request());
    let bufchain = queue.pop_request();
    let buf = new Uint8Array(bufchain.length_readable);
    let len = bufchain.get_next_blob(buf);

    let [type, flags, fence_id, ctx_id, ring_idx] = marshall.Unmarshall(["w", "w", "d", "w", "b"], buf, { offset: 0 });

    return {
        type, flags, fence_id, ctx_id, ring_idx,
        packet: buf.subarray(CMD_HEADER_SIZE, len),
        bufchain,
    };
};

/**
 * @param {number} queue_id
 * @param {VirtQueueBufferChain} bufchain
 * @param {number} type
 * @param {Uint8Array} payload
 * @param {PacketSendOptions} opts
 */
VirtioGpu.prototype.send_packet = function (queue_id, bufchain, type, payload, opts) {
    opts.flags = opts.flags || 0;
    opts.fence_id = opts.fence_id || 0;
    opts.ctx_id = opts.ctx_id || 0;
    opts.ring_idx = opts.ring_idx || 0;
    dbg_assert(opts.fence_id <= 0xFFFFFFFF, "virtio-gpu: fence_id is currently only 32-bit");

    let queue = this.virtio.queues[queue_id];

    let packet = new Uint8Array(CMD_HEADER_SIZE + payload.byteLength);
    marshall.Marshall(["w", "w", "d", "w", "b"], [type, opts.flags, opts.fence_id, opts.ctx_id, opts.ring_idx], packet, 0);
    packet.set(payload, CMD_HEADER_SIZE);
    bufchain.set_next_blob(packet);

    queue.push_reply(bufchain);
};

/**
 * @param {number} event
 */
VirtioGpu.prototype.send_event = function (event) {
    this.events |= event;
    this.virtio.notify_config_changes();
};

VirtioGpu.prototype.get_copies_for_box = function (buf_width, buf_height, buf_pixel_size, x, y, width, height, pixel_size) {
    dbg_assert(y + height <= buf_height, "virtio-gpu: invalid y offset for box");

    let copies = [];
    for(let i = 0; i < height; i++) {
        copies.push({
            from_offset: ((y + i) * buf_width * buf_pixel_size) + x * buf_pixel_size, from_length: width * buf_pixel_size,
            to_offset: ((y + i) * buf_width * pixel_size) + x * pixel_size,
        });
    }
    return copies;
};

VirtioGpu.prototype.flush_to_imagedata = function (host, backing_width, backing_height, format, image_data, x, y, width, height) {
    let pixel_size = this.pixel_size_from_format(format);
    let image = image_data.data;

    for(let copy of this.get_copies_for_box(backing_width, backing_height, pixel_size, x, y, width, height, 4)) {
        let from = copy.from_offset;
        let to = copy.to_offset;
        let len = copy.from_length;

        while(len !== 0) {
            switch(format) {
                case VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM:
                    image[to    ] = host[from + 2]; // R
                    image[to + 1] = host[from + 1]; // G
                    image[to + 2] = host[from    ]; // B
                    image[to + 3] = 255           ; // A
                    break;
                default:
                    dbg_assert(false, "virtio-gpu: unable to flush format " + h(format) + " to imagedata");
            }
            from += pixel_size;
            to += 4;
            len -= pixel_size;
        }
    }
};

VirtioGpu.prototype.pixel_size_from_format = function (format) {
    // all the current formats are 4 bytes per pixel
    return 4;
};

/**
 * @param {number} queue
 */
VirtioGpu.prototype.process_request = function (queue) {
    // TODO: figure out what to do with the other header data
    let { type, packet, bufchain, ...header } = this.read_packet(queue);

    if(type === VIRTIO_GPU_CMD_GET_DISPLAY_INFO) {
        const DISPLAY_ONE_SIZE = 4 + 4 + 4 + 4 + 4 + 4;
        let payload = new Uint8Array(DISPLAY_ONE_SIZE * VIRTIO_GPU_MAX_SCANOUTS);

        let offset = 0;
        for(let display of this.displays) {
            marshall.Marshall(
                ["w", "w", "w", "w", "w", "w"],
                [display.x, display.y, display.width, display.height, +display.enabled, display.flags],
                payload, offset
            );
            offset += DISPLAY_ONE_SIZE;
        }

        this.send_packet(queue, bufchain, VIRTIO_GPU_RESP_OK_DISPLAY_INFO, payload, {});
    }
    // VIRTIO_GPU_CMD_GET_EDID not supported
    else if(type === VIRTIO_GPU_CMD_RESOURCE_CREATE_2D) {
        let [resource_id, format, width, height] = marshall.Unmarshall(["w", "w", "w", "w"], packet, { offset: 0 });
        dbg_log("Device<virtio-gpu>: rid " + resource_id + " create with format " + h(format) + " width " + width + " and height " + height, LOG_VIRTIO);
        dbg_assert(!this.resources[resource_id], "virtio-gpu: rid " + resource_id + " already exists");

        let host_size = width * height * this.pixel_size_from_format(format);
        let host_backing = this.buffer.alloc(host_size);
        dbg_log("Device<virtio-gpu>: rid " + resource_id + " allocated " + host_size + " bytes for host backing", LOG_VIRTIO);

        this.resources[resource_id] = {
            format,
            width,
            height,
            guest_backing: [],
            host_backing,
            host_image_data: new ImageData(width, height),
            host_backing_len: host_size,
        };
        this.send_packet(queue, bufchain, VIRTIO_GPU_RESP_OK_NODATA, new Uint8Array(0), {});
    }
    else if(type === VIRTIO_GPU_CMD_RESOURCE_UNREF) {
        let [resource_id] = marshall.Unmarshall(["w"], packet, { offset: 0 });
        dbg_log("Device<virtio-gpu>: rid " + resource_id + " delete", LOG_VIRTIO);
        dbg_assert(this.resources[resource_id], "virtio-gpu: rid " + resource_id + " doesn't exist");

        this.resources[resource_id] = undefined;

        this.send_packet(queue, bufchain, VIRTIO_GPU_RESP_OK_NODATA, new Uint8Array(0), {});
    }
    else if(type === VIRTIO_GPU_CMD_SET_SCANOUT) {
        let [x, y, width, height, scanout_id, resource_id] = marshall.Unmarshall(["w", "w", "w", "w", "w", "w"], packet, { offset: 0 });
        dbg_log("Device<virtio-gpu>: rid " + resource_id + " link to display id " + scanout_id + " with rectangle " + [x, y, width, height].join(" "), LOG_VIRTIO);

        let display = this.displays[scanout_id];
        dbg_assert(display, "virtio-gpu: scanout with id " + scanout_id + " doesn't exist");
        dbg_assert(display.enabled, "virtio-gpu: scanout with id " + scanout_id + " isn't enabled");

        if(resource_id === 0) {
            // unlink
            display.scanout = undefined;
        } else {
            dbg_assert(this.resources[resource_id], "virtio-gpu: rid " + resource_id + " doesn't exist");
            dbg_assert(width >= display.width && height >= display.height, "virtio-gpu: scanout rectangle for rid " + resource_id + " doesn't cover display id " + scanout_id);
            this.exit_vga_compat();

            display.scanout = {
                x,
                y,
                width,
                height,
                resource: resource_id,
            };
        }

        this.send_packet(queue, bufchain, VIRTIO_GPU_RESP_OK_NODATA, new Uint8Array(0), {});
    }
    else if(type === VIRTIO_GPU_CMD_RESOURCE_FLUSH) {
        let [x, y, width, height, resource_id] = marshall.Unmarshall(["w", "w", "w", "w", "w"], packet, { offset: 0 });
        dbg_log("Device<virtio-gpu>: rid " + resource_id + " flush with rectangle " + [x, y, width, height].join(" "), LOG_VIRTIO);

        let resource = this.resources[resource_id];
        dbg_assert(resource, "virtio-gpu: rid " + resource_id + " doesn't exist");

        this.flush_to_imagedata(resource.host_backing(), resource.width, resource.height, resource.format, resource.host_image_data, x, y, width, height);

        this.send_packet(queue, bufchain, VIRTIO_GPU_RESP_OK_NODATA, new Uint8Array(0), {});
    }
    else if(type === VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D) {
        let [x, y, width, height, pkt_offset, resource_id] = marshall.Unmarshall(["w", "w", "w", "w", "d", "w"], packet, { offset: 0 });
        dbg_log("Device<virtio-gpu>: rid " + resource_id + " transfer from guest with offset " + pkt_offset + " and rectangle " + [x, y, width, height].join(" "), LOG_VIRTIO);

        let resource = this.resources[resource_id];
        dbg_assert(resource, "virtio-gpu: rid " + resource_id + " doesn't exist");
        dbg_assert(resource.guest_backing.length, "virtio-gpu: rid " + resource_id + " doesn't have backing pages");
        dbg_assert(x + width <= resource.width && y + height <= resource.height, "virtio-gpu: transfer bounds outside resource bounds");

        let pixel_size = this.pixel_size_from_format(resource.format);
        let host = resource.host_backing();
        let backings = resource.guest_backing;

        // don't double count the memory from 0,0 to x,y
        let offset = pkt_offset - ((y * resource.width * pixel_size) + (x * pixel_size));

        for(let copy of this.get_copies_for_box(resource.width, resource.height, pixel_size, x, y, width, height, pixel_size)) {
            let from = copy.from_offset + offset;
            let to = copy.to_offset;
            let len = copy.from_length;

            while(len !== 0) {
                let backing_id = 0;
                while(from >= backings[backing_id].length) {
                    from -= backings[backing_id].length;
                    backing_id++;
                }
                let guest_len = Math.min(backings[backing_id].length - from, len);

                let guest = this.cpu.read_blob(backings[backing_id].address + from, guest_len);
                host.subarray(to).set(guest);

                from = 0;
                to += guest_len;
                len -= guest_len;
            }
        }

        this.send_packet(queue, bufchain, VIRTIO_GPU_RESP_OK_NODATA, new Uint8Array(0), {});
    }
    else if(type === VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING) {
        let state = { offset: 0 };
        let [resource_id, nr_entries] = marshall.Unmarshall(["w", "w"], packet, state);
        dbg_log("Device<virtio-gpu>: rid " + resource_id + " link " + nr_entries + " entries as backing", LOG_VIRTIO);
        let resource = this.resources[resource_id];
        dbg_assert(resource, "virtio-gpu: rid " + resource_id + " doesn't exist");
        dbg_assert(!resource.guest_backing.length, "virtio-gpu: rid " + resource_id + "already has backing pages");

        let backing = [];
        let backing_len = 0;
        for(let i = 0; i < nr_entries; i++) {
            let [addr, length, _padding] = marshall.Unmarshall(["d", "w", "w"], packet, state);
            backing[i] = {
                address: addr, length
            };
            backing_len += length;
        }
        dbg_assert(backing_len === resource.host_backing_len, "virtio-gpu: rid " + resource_id + " backing pages don't match host backing size " + backing_len + " !== " + resource.host_backing_len);
        resource.guest_backing = backing;

        this.send_packet(queue, bufchain, VIRTIO_GPU_RESP_OK_NODATA, new Uint8Array(0), {});
    }
    else if(type === VIRTIO_GPU_CMD_RESOURCE_DETACH_BACKING) {
        let [resource_id] = marshall.Unmarshall(["w"], packet, { offset: 0 });
        dbg_log("Device<virtio-gpu>: rid " + resource_id + " unlink backing entries", LOG_VIRTIO);
        let resource = this.resources[resource_id];
        dbg_assert(resource, "virtio-gpu: rid " + resource_id + " doesn't exist");
        dbg_assert(resource.guest_backing.length, "virtio-gpu: rid " + resource_id + " doesn't have backing pages");

        resource.guest_backing = [];

        this.send_packet(queue, bufchain, VIRTIO_GPU_RESP_OK_NODATA, new Uint8Array(0), {});
    }
    else {
        dbg_assert(false, "virtio-gpu: unimplemented command type " + h(type));
    }
};

VirtioGpu.prototype.exit_vga_compat = function()
{
    if(!this.vga_compat_enabled) return;
    dbg_log("Device<virtio-gpu>: exiting vga compat", LOG_VIRTIO);

    this.vga_compat_enabled = false;
    this.displays[0].screen.set_mode(true);
    this.displays[0].screen.set_size_graphical(this.displays[0].width, this.displays[0].height, this.displays[0].width, this.displays[0].height);
};

VirtioGpu.prototype.screen_fill_buffer = function()
{
    if(this.vga_compat_enabled) {
        this.vga.screen_fill_buffer();
        return;
    }

    const display = this.displays[0];
    if(!display.scanout) return;

    const resource = this.resources[display.scanout.resource];
    if(!resource) return;

    display.screen.update_buffer([{
        image_data: resource.host_image_data,
        screen_x: 0,
        screen_y: 0,
        buffer_x: 0,
        buffer_y: 0,
        buffer_width: resource.width,
        buffer_height: resource.height,
    }]);
};
