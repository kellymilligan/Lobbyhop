/**
 * TypeScript wrapper over box3d.wasm (Box3D compiled with boxworld.c).
 *
 * The compiled module is injected rather than imported, because each host
 * loads WebAssembly differently:
 *   Cloudflare Worker:  import wasm from './physics/box3d.wasm'   (a WebAssembly.Module)
 *   Node / tests:       new WebAssembly.Module(readFileSync('.../box3d.wasm'))
 * Each `createWorld` call instantiates a fresh module: one world per instance.
 */

const STRIDE = 14;

export interface BoxBody {
  p: [number, number, number];
  q: [number, number, number, number];
  v: [number, number, number];
  w: [number, number, number];
  awake: boolean;
}

export interface NewBox {
  half: [number, number, number];
  density?: number;
  friction?: number;
  p: [number, number, number];
  q?: [number, number, number, number];
  v?: [number, number, number];
  w?: [number, number, number];
  awake?: boolean;
}

interface Exports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  bw_init(gx: number, gy: number, gz: number): void;
  bw_static_box(hx: number, hy: number, hz: number, x: number, y: number, z: number, friction: number): void;
  bw_box(...args: number[]): number;
  bw_step(dt: number, substeps: number): void;
  bw_buffer(): number;
  bw_read(): number;
  bw_drag(h: number, tx: number, ty: number, tz: number, gain: number, maxSpeed: number): void;
  bw_set_rotation(h: number, qx: number, qy: number, qz: number, qw: number): void;
  bw_set_awake(h: number, awake: number): void;
}

let compiled: WebAssembly.Module | null = null;

/** Provide the compiled box3d.wasm module once, at startup (Worker, Node server or test). */
export function setBox3DModule(module: WebAssembly.Module) {
  compiled = module;
}

export function hasBox3DModule() {
  return compiled !== null;
}

/** A Box3D world of boxes. */
export class BoxWorld {
  private constructor(private x: Exports) {}

  static create(gravity: [number, number, number] = [0, -10, 0]): BoxWorld {
    if (!compiled) throw new Error('box3d: call setBox3DModule(module) before creating a world');
    let memory: WebAssembly.Memory | null = null;
    // The three host functions a standalone Emscripten module needs; none matter here.
    const imports = {
      wasi_snapshot_preview1: {
        clock_time_get: (_id: number, _precision: bigint, out: number) => {
          if (memory) new BigUint64Array(memory.buffer, out, 1)[0] = 0n;
          return 0;
        },
        fd_write: () => 0,
        proc_exit: () => {},
      },
      env: { emscripten_notify_memory_growth: () => {} },
    };
    const instance = new WebAssembly.Instance(compiled, imports as unknown as WebAssembly.Imports);
    const x = instance.exports as unknown as Exports;
    memory = x.memory;
    x._initialize?.();
    x.bw_init(...gravity);
    return new BoxWorld(x);
  }

  /** A static box: floors, walls, invisible containers. */
  addStatic(half: [number, number, number], p: [number, number, number], friction = 0.6) {
    this.x.bw_static_box(half[0], half[1], half[2], p[0], p[1], p[2], friction);
  }

  /** A dynamic box. Returns its handle (stable for this world). */
  addBox(b: NewBox): number {
    const q = b.q ?? [0, 0, 0, 1];
    const v = b.v ?? [0, 0, 0];
    const w = b.w ?? [0, 0, 0];
    const h = this.x.bw_box(b.half[0], b.half[1], b.half[2], b.density ?? 1, b.friction ?? 0.6, b.p[0], b.p[1], b.p[2], q[0], q[1], q[2], q[3], v[0], v[1], v[2], w[0], w[1], w[2], b.awake === false ? 0 : 1);
    if (h < 0) throw new Error('box3d: too many bodies');
    return h;
  }

  step(dt: number, substeps = 4) {
    this.x.bw_step(dt, substeps);
  }

  /** Reads every dynamic body (in handle order). */
  read(): BoxBody[] {
    const n = this.x.bw_read();
    // Re-view memory each time: it may have grown.
    const f = new Float32Array(this.x.memory.buffer, this.x.bw_buffer(), n * STRIDE);
    const out: BoxBody[] = [];
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      out.push({ p: [f[o], f[o + 1], f[o + 2]], q: [f[o + 3], f[o + 4], f[o + 5], f[o + 6]], v: [f[o + 7], f[o + 8], f[o + 9]], w: [f[o + 10], f[o + 11], f[o + 12]], awake: f[o + 13] > 0.5 });
    }
    return out;
  }

  /** Pull a body toward a target point (call every tick while held). */
  drag(h: number, target: [number, number, number], gain = 12, maxSpeed = 12) {
    this.x.bw_drag(h, target[0], target[1], target[2], gain, maxSpeed);
  }

  setRotation(h: number, q: [number, number, number, number]) {
    this.x.bw_set_rotation(h, q[0], q[1], q[2], q[3]);
  }

  setAwake(h: number, awake: boolean) {
    this.x.bw_set_awake(h, awake ? 1 : 0);
  }
}
