/**
 * Blocks client: renders the shared world with three.js (WebGPU, falling back
 * to WebGL 2) and turns pointer input into intent. Physics runs only on the
 * server; this page interpolates between the views it receives.
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { joinRoom, roomFromUrl } from 'lobbyhop/client';
import { mountStatus } from 'lobbyhop/lobby-ui';
import { BOUNDS, COLOURS, game } from './game';
import type { Quat, Vec3, View } from './game';

const room = joinRoom(game, { room: roomFromUrl() ?? 'world', host: import.meta.env.VITE_ROOM_HOST });
mountStatus(room, { pause: false });

/** Some Chromium builds expose WebGPU but reject descriptor fields three.js uses; start on WebGL 2 there. */
async function webgpuUsable(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return false;
    const device = await adapter.requestDevice();
    try {
      const tex = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
      tex.createView({ swizzle: 'rgba' } as GPUTextureViewDescriptor);
      tex.destroy();
      return true;
    } finally {
      device.destroy();
    }
  } catch {
    return false;
  }
}

const forced = new URLSearchParams(location.search).get('renderer');
const useWebGPU = forced === 'webgpu' || (forced !== 'webgl' && (await webgpuUsable()));
// Transparent canvas over a CSS gradient sky.
const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true, forceWebGL: !useWebGPU });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.prepend(renderer.domElement);
await renderer.init();
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200);
// Portrait screens need to stand further back to see the whole world.
const framing = () => camera.position.set(15, 13, 19).multiplyScalar(camera.aspect < 1 ? 1.7 : 1);
framing();
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.5, 0);
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 6;
controls.maxDistance = 45;
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight('#ffffff', '#b8a58c', 1.4));
const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
sun.position.set(8, 18, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 50 });
sun.shadow.bias = -0.0005;
scene.add(sun);

// The ground: a soft slab. The walls and ceiling are invisible; a faint rim marks the edge.
const floor = new THREE.Mesh(new THREE.BoxGeometry(BOUNDS.x * 2, 0.6, BOUNDS.z * 2), new THREE.MeshStandardMaterial({ color: '#f4efe6', roughness: 0.95 }));
floor.position.y = -0.3;
floor.receiveShadow = true;
scene.add(floor);
const rim = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(BOUNDS.x * 2, BOUNDS.height, BOUNDS.z * 2)),
  new THREE.LineBasicMaterial({ color: '#9fb3c8', transparent: true, opacity: 0.18 }),
);
rim.position.y = BOUNDS.height / 2;
scene.add(rim);

// --- Blocks ---------------------------------------------------------------
const unit = new THREE.BoxGeometry(1, 1, 1);
const meshes = new Map<string, THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>>();
function meshFor(id: string, b: View['blocks'][string]) {
  let m = meshes.get(id);
  if (!m) {
    m = new THREE.Mesh(unit, new THREE.MeshStandardMaterial({ color: COLOURS[b.c % COLOURS.length], roughness: 0.55 }));
    m.scale.set(b.s[0] * 2, b.s[1] * 2, b.s[2] * 2);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.id = id;
    scene.add(m);
    meshes.set(id, m);
  }
  return m;
}

// The ghost: your carried block, drawn at your hand immediately (the real one follows ~100–200 ms later).
const ghost = new THREE.Mesh(unit, new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, depthWrite: false }));
ghost.visible = false;
scene.add(ghost);

// Other visitors' pointers.
const cursorGeo = new THREE.SphereGeometry(0.16, 16, 12);
const cursors = new Map<string, { mesh: THREE.Mesh; label: HTMLDivElement }>();
const labels = document.querySelector<HTMLDivElement>('#labels')!;

// --- Input: intent only, throttled -------------------------------------------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let drag: { id: string; height: number; offset: THREE.Vector3; target: THREE.Vector3 } | null = null;
let lastDragSent = 0;
let lastAimSent = 0;
let aimPoint: Vec3 | null = null;

function pointerRay(e: PointerEvent) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
function onPlane(height: number) {
  const hit = new THREE.Vector3();
  return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -height), hit) ? hit : null;
}
const toVec = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

/**
 * Auto-lift: carry the block just high enough to clear whatever is under it,
 * so stacking works without a scroll wheel (touch) and blocks don't plough
 * through the pile. The wheel can still raise it further.
 */
const down = new THREE.Raycaster();
function clearance(x: number, z: number, carriedId: string, halfHeight: number) {
  down.set(new THREE.Vector3(x, BOUNDS.height + 1, z), new THREE.Vector3(0, -1, 0));
  const others = [...meshes.values()].filter((m) => m.userData.id !== carriedId);
  const hit = down.intersectObjects(others, false)[0];
  return (hit ? hit.point.y : 0) + halfHeight + 0.15;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || room.seat === null) return;
  pointerRay(e);
  const hit = ray.intersectObjects([...meshes.values()], false)[0];
  if (!hit) return;
  const id = hit.object.userData.id as string;
  const v = room.state as View | null;
  if (v && Object.entries(v.holds).some(([seat, held]) => held === id && seat !== String(room.seat))) return;
  // Carry on a horizontal plane just above where it was grabbed, keeping the grab offset.
  const height = Math.min(BOUNDS.height - 1, hit.object.position.y + 0.4);
  const p = onPlane(height) ?? hit.point.clone();
  const offset = new THREE.Vector3(hit.object.position.x - p.x, 0, hit.object.position.z - p.z);
  const target = new THREE.Vector3(hit.object.position.x, height, hit.object.position.z);
  drag = { id, height, offset, target };
  room.submit({ type: 'grab', id, t: toVec(target) });
  controls.enabled = false;
  renderer.domElement.setPointerCapture(e.pointerId);
});

renderer.domElement.addEventListener('pointermove', (e) => {
  pointerRay(e);
  const now = performance.now();
  if (drag) {
    const p = onPlane(drag.height);
    if (p) {
      drag.target.set(p.x + drag.offset.x, drag.height, p.z + drag.offset.z);
      drag.target.x = THREE.MathUtils.clamp(drag.target.x, -BOUNDS.x + 0.5, BOUNDS.x - 0.5);
      drag.target.z = THREE.MathUtils.clamp(drag.target.z, -BOUNDS.z + 0.5, BOUNDS.z - 0.5);
      const carried = meshes.get(drag.id);
      if (carried) drag.target.y = Math.max(drag.height, clearance(drag.target.x, drag.target.z, drag.id, carried.scale.y / 2));
      aimPoint = toVec(drag.target);
    }
  } else {
    const hit = ray.intersectObjects([...meshes.values(), floor], false)[0];
    aimPoint = hit ? toVec(hit.point) : null;
  }
  if (drag && now - lastDragSent > 66) {
    room.submit({ type: 'drag', t: toVec(drag.target) });
    lastDragSent = now;
  }
  if (aimPoint && now - lastAimSent > 100) {
    room.submit({ type: 'aim', p: aimPoint });
    lastAimSent = now;
  }
});

const endDrag = () => {
  if (!drag) return;
  room.submit({ type: 'drag', t: toVec(drag.target) });
  room.submit({ type: 'release' });
  drag = null;
  controls.enabled = true;
};
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);
renderer.domElement.addEventListener(
  'wheel',
  (e) => {
    if (!drag) return;
    // While carrying, the wheel lifts and lowers instead of zooming.
    e.preventDefault();
    e.stopImmediatePropagation();
    drag.height = THREE.MathUtils.clamp(drag.height - e.deltaY * 0.004, 0.4, BOUNDS.height - 1);
    drag.target.y = Math.max(drag.height, drag.target.y - (e.deltaY > 0 ? 0.4 : 0));
    room.submit({ type: 'drag', t: toVec(drag.target) });
  },
  { passive: false, capture: true },
);
addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key.toLowerCase() === 'r' && drag) room.submit({ type: 'turn' });
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- HUD ----------------------------------------------------------------
const count = document.querySelector<HTMLSpanElement>('#count')!;
const nameInput = document.querySelector<HTMLInputElement>('#name')!;
const share = document.querySelector<HTMLButtonElement>('#share')!;
nameInput.value = room.profile.name;
nameInput.onchange = () => room.setProfile({ name: nameInput.value });
share.onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    share.textContent = 'Copied';
    setTimeout(() => (share.textContent = 'Copy link'), 1500);
  } catch {
    // Clipboard blocked; the address bar is the link.
  }
};
room.on('change', () => (count.textContent = `${room.members.filter((m) => m.connected).length} here${room.spectating ? ' · watching (world is full)' : ''}`));

// --- Frame loop ---------------------------------------------------------------
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
const lerp3 = (a: Vec3, b: Vec3, t: number, out: THREE.Vector3) => out.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
const setQuat = (a: Quat, b: Quat, t: number, out: THREE.Quaternion) => out.copy(qa.set(a[0], a[1], a[2], a[3])).slerp(qb.set(b[0], b[1], b[2], b[3]), t);

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  // Pass the real elapsed time: advance() clamps and catches up on its own.
  const { state, prev, alpha } = room.advance((now - last) / 1000);
  last = now;
  const v = state as View | null;
  const pv = prev as View | null;
  if (v) {
    for (const [id, b] of Object.entries(v.blocks)) {
      const m = meshFor(id, b);
      const was = pv?.blocks[id] ?? b;
      lerp3(was.p, b.p, alpha, m.position);
      setQuat(was.q, b.q, alpha, m.quaternion);
      const holder = Object.entries(v.holds).find(([, held]) => held === id)?.[0];
      const colour = holder === undefined ? null : room.members.find((mm) => String(mm.seat) === holder)?.colour;
      m.material.emissive.set(colour ?? '#000000');
      m.material.emissiveIntensity = colour ? 0.35 : 0;
    }
    // Ghost of the block you're carrying, at your hand right now.
    const carried = drag ? meshes.get(drag.id) : undefined;
    ghost.visible = !!(drag && carried);
    if (drag && carried) {
      ghost.position.copy(drag.target);
      ghost.quaternion.copy(carried.quaternion);
      ghost.scale.copy(carried.scale);
    }
    // Other visitors' pointers with name labels.
    const seen = new Set<string>();
    for (const [seat, p] of Object.entries(v.cursors)) {
      if (seat === String(room.seat)) continue;
      const member = room.members.find((mm) => String(mm.seat) === seat);
      if (!member) continue;
      seen.add(seat);
      let c = cursors.get(seat);
      if (!c) {
        const mesh = new THREE.Mesh(cursorGeo, new THREE.MeshBasicMaterial({ color: member.colour }));
        scene.add(mesh);
        const label = document.createElement('div');
        label.className = 'label';
        labels.append(label);
        c = { mesh, label };
        cursors.set(seat, c);
      }
      const was = pv?.cursors[seat] ?? p;
      lerp3(was, p, alpha, c.mesh.position);
      c.label.textContent = member.name;
      c.label.style.color = member.colour;
      const s = c.mesh.position.clone().project(camera);
      c.label.style.transform = `translate(${((s.x + 1) / 2) * innerWidth}px, ${((1 - s.y) / 2) * innerHeight - 24}px) translateX(-50%)`;
      c.label.style.display = s.z < 1 ? '' : 'none';
    }
    for (const [seat, c] of cursors) {
      if (seen.has(seat)) continue;
      scene.remove(c.mesh);
      c.label.remove();
      cursors.delete(seat);
    }
  }
  controls.update();
  renderer.render(scene, camera);
});

// Debug handle for e2e tests and the console.
(window as unknown as { lobbyhop: unknown }).lobbyhop = { room, backend, camera, meshes };
