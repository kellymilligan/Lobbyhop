// A tiny flat C API over Box3D for a world of boxes, compiled to a standalone
// WebAssembly module (see build.sh). One world per module instance.
// Handles are small integers (indices into `bodies`), stable for the world's life.
#include "box3d/box3d.h"
#include <emscripten/emscripten.h>
#include <math.h>

#define MAX_BODIES 4096
#define STRIDE 14 // px py pz qx qy qz qw vx vy vz wx wy wz awake

static b3WorldId world;
static b3BodyId bodies[MAX_BODIES];
static int count = 0;
static float buffer[MAX_BODIES * STRIDE];

EMSCRIPTEN_KEEPALIVE void bw_init(float gx, float gy, float gz) {
  b3WorldDef def = b3DefaultWorldDef();
  def.gravity = (b3Vec3){ gx, gy, gz };
  world = b3CreateWorld(&def);
  count = 0;
}

// A static box (floor, walls). Returns nothing: static bodies aren't read back.
EMSCRIPTEN_KEEPALIVE void bw_static_box(float hx, float hy, float hz, float x, float y, float z, float friction) {
  b3BodyDef bd = b3DefaultBodyDef();
  bd.position = (b3Vec3){ x, y, z };
  b3BodyId id = b3CreateBody(world, &bd);
  b3BoxHull hull = b3MakeBoxHull(hx, hy, hz);
  b3ShapeDef sd = b3DefaultShapeDef();
  sd.baseMaterial.friction = friction;
  b3CreateHullShape(id, &sd, &hull.base);
}

// A dynamic box. Returns its handle, or -1 when full.
EMSCRIPTEN_KEEPALIVE int bw_box(float hx, float hy, float hz, float density, float friction, float x, float y, float z, float qx, float qy, float qz,
                                float qw, float vx, float vy, float vz, float wx, float wy, float wz, int awake) {
  if (count >= MAX_BODIES) return -1;
  b3BodyDef bd = b3DefaultBodyDef();
  bd.type = b3_dynamicBody;
  bd.position = (b3Vec3){ x, y, z };
  bd.rotation = (b3Quat){ { qx, qy, qz }, qw };
  bd.linearVelocity = (b3Vec3){ vx, vy, vz };
  bd.angularVelocity = (b3Vec3){ wx, wy, wz };
  bd.isAwake = awake != 0;
  b3BodyId id = b3CreateBody(world, &bd);
  b3BoxHull hull = b3MakeBoxHull(hx, hy, hz);
  b3ShapeDef sd = b3DefaultShapeDef();
  sd.density = density;
  sd.baseMaterial.friction = friction;
  b3CreateHullShape(id, &sd, &hull.base);
  bodies[count] = id;
  return count++;
}

EMSCRIPTEN_KEEPALIVE void bw_step(float dt, int substeps) { b3World_Step(world, dt, substeps); }

EMSCRIPTEN_KEEPALIVE float* bw_buffer(void) { return buffer; }

// Writes every dynamic body's state into the buffer (STRIDE floats each). Returns the count.
EMSCRIPTEN_KEEPALIVE int bw_read(void) {
  for (int i = 0; i < count; i++) {
    b3BodyId id = bodies[i];
    b3WorldTransform t = b3Body_GetTransform(id);
    b3Vec3 v = b3Body_GetLinearVelocity(id);
    b3Vec3 w = b3Body_GetAngularVelocity(id);
    float* o = buffer + i * STRIDE;
    o[0] = t.p.x; o[1] = t.p.y; o[2] = t.p.z;
    o[3] = t.q.v.x; o[4] = t.q.v.y; o[5] = t.q.v.z; o[6] = t.q.s;
    o[7] = v.x; o[8] = v.y; o[9] = v.z;
    o[10] = w.x; o[11] = w.y; o[12] = w.z;
    o[13] = b3Body_IsAwake(id) ? 1.0f : 0.0f;
  }
  return count;
}

// Drag a body toward a target point: a critically damped velocity toward the
// target (capped), with its spin damped so carried blocks stay calm.
EMSCRIPTEN_KEEPALIVE void bw_drag(int h, float tx, float ty, float tz, float gain, float maxSpeed) {
  if (h < 0 || h >= count) return;
  b3BodyId id = bodies[h];
  b3WorldTransform t = b3Body_GetTransform(id);
  b3Vec3 v = { (tx - t.p.x) * gain, (ty - t.p.y) * gain, (tz - t.p.z) * gain };
  float s = sqrtf(v.x * v.x + v.y * v.y + v.z * v.z);
  if (s > maxSpeed) { v.x *= maxSpeed / s; v.y *= maxSpeed / s; v.z *= maxSpeed / s; }
  b3Body_SetLinearVelocity(id, v);
  b3Vec3 w = b3Body_GetAngularVelocity(id);
  b3Body_SetAngularVelocity(id, (b3Vec3){ w.x * 0.8f, w.y * 0.8f, w.z * 0.8f });
  b3Body_SetAwake(id, true);
}

// Sets a body's rotation about the vertical axis, keeping its position (for turning a held block).
EMSCRIPTEN_KEEPALIVE void bw_set_rotation(int h, float qx, float qy, float qz, float qw) {
  if (h < 0 || h >= count) return;
  b3BodyId id = bodies[h];
  b3WorldTransform t = b3Body_GetTransform(id);
  b3Body_SetTransform(id, t.p, (b3Quat){ { qx, qy, qz }, qw });
  b3Body_SetAngularVelocity(id, (b3Vec3){ 0, 0, 0 });
}

EMSCRIPTEN_KEEPALIVE void bw_set_awake(int h, int awake) {
  if (h >= 0 && h < count) b3Body_SetAwake(bodies[h], awake != 0);
}
