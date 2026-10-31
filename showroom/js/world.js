// The 3D showroom: hall, cars, the robot (with its live HTML screen), the guest, navigation and cameras.
import { CARS, byId } from "./cars.js";

const { THREE, OrbitControls, GLTFLoader, RoomEnvironment, CSS3DRenderer, CSS3DObject } = window.RobotDeps;
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

const HALL = { x0: -16, x1: 16, z0: -10, z1: 10 };
const DOOR = { x0: -6, x1: -2 };                       // gap in the front glass
const HOME = { pos: V3(-10.6, 0, 5.4), yaw: 0.9 };     // robot's spot by the reception desk
const GUEST_START = V3(-9.3, 0, 6.6);
const ROBOT_SCALE = 1.2, CAR_LEN = 4.5;
const SPEED = 1.25, ACCEL = 0.9;

export async function createWorld({ stage, pip, onEvent }) {
  const emit = (t, d) => onEvent && onEvent(t, d);

  // ---------- renderer, scene, light ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  stage.appendChild(renderer.domElement);
  const cssRenderer = new CSS3DRenderer();
  cssRenderer.domElement.className = "css3d";
  stage.appendChild(cssRenderer.domElement);
  const labels = document.createElement("div"); labels.className = "labels"; stage.appendChild(labels);

  const scene = new THREE.Scene(), cssScene = new THREE.Scene();
  scene.background = new THREE.Color("#dcdedb");
  scene.fog = new THREE.Fog("#dcdedb", 45, 95);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment();
  scene.environment = pmrem.fromScene(roomEnv, 0.04).texture; scene.environmentIntensity = 0.6;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8f969c, 0.7));
  const sun = new THREE.DirectionalLight(0xfff4e6, 1.7);
  sun.position.set(9, 18, 12); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -19, right: 19, top: 14, bottom: -14, near: 1, far: 50 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  camera.position.set(-2, 9, 18);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true; orbit.maxPolarAngle = Math.PI * 0.48; orbit.minDistance = 2; orbit.maxDistance = 45; orbit.enabled = false;

  const occluders = [];
  buildHall(scene, occluders);

  // ---------- loading ----------
  // the single-file build embeds every model as a data URL in window.SIM_ASSETS
  const embedded = window.SIM_ASSETS || {}, manager = new THREE.LoadingManager();
  manager.setURLModifier(u => { for (const k in embedded) if (u.endsWith(k)) return embedded[k]; return u; });
  const loader = new GLTFLoader(manager);
  const load = url => new Promise((res, rej) => loader.load(url, res, undefined, rej));
  const [robotGltf, personGltf, ...carGltfs] = await Promise.all([
    load("assets/robot.glb"), load("assets/person.glb"), ...CARS.map(c => load("assets/cars/" + c.file)),
  ]);

  // ---------- cars ----------
  const carObjs = {};
  CARS.forEach((c, i) => {
    const root = carGltfs[i].scene;
    paintCar(root, c.paint);
    const box = new THREE.Box3().setFromObject(root), size = box.getSize(V3());
    const s = CAR_LEN / Math.max(size.x, size.z);
    root.scale.setScalar(s);
    const g = new THREE.Group(); g.add(root);
    root.position.set(-(box.min.x + box.max.x) / 2 * s, -box.min.y * s + 0.08, -(box.min.z + box.max.z) / 2 * s);
    g.position.set(c.spot[0], 0, c.spot[1]); g.rotation.y = c.yaw;
    root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; occluders.push(o); } });
    scene.add(g); scene.add(plinth(c.spot));
    const aisle = c.spot[1] < 0 ? 1 : -1;
    scene.add(standCard(c, cardPos(c), aisle));
    carObjs[c.id] = { g, root, aisle };
    const el = document.createElement("div"); el.className = "carlabel"; el.innerHTML = `<b>${c.name}</b><span>${c.seats} seats</span>`;
    labels.appendChild(el); carObjs[c.id].label = el;
  });

  // ---------- robot ----------
  const robot = new THREE.Group(); scene.add(robot);
  const rb = robotGltf.scene; rb.scale.setScalar(ROBOT_SCALE); robot.add(rb);
  const wheels = [], leds = [];
  const woodSet = new Set();
  rb.traverse(o => {
    if (o.name.startsWith("Face") || o.name.startsWith("Wordmark")) o.visible = false;
    if (o.name.startsWith("Drive wheel")) wheels.push(o);
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    for (const m of [].concat(o.material)) {
      if (m.name.includes("Wood") && !woodSet.has(m)) { woodSet.add(m); woodShader(m); }
      if (m.name.includes("LED")) { m.emissiveIntensity = 2.3; leds.push(m); }
      if (m.name.includes("Display | dark")) { m.metalness = 0; m.roughness = 0.38; m.envMapIntensity = 0.12; }
    }
  });
  rb.add(wordmark("SADEEM"));
  const screen3d = robotScreen(rb);

  // ---------- guest ----------
  const guest = new THREE.Group(); scene.add(guest);
  const person = personGltf.scene; guest.add(person);
  person.traverse(o => {
    if (!o.isMesh) return; o.castShadow = true; o.frustumCulled = false;
    o.material = o.material.clone();
    if (o.material.name.includes("Joints")) o.material.color.set("#3a3f46"); else o.material.color.set("#d9d3c9");
    o.material.roughness = 0.55; o.material.metalness = 0.05;
  });
  const mixer = new THREE.AnimationMixer(person);
  const clip = n => personGltf.animations.find(a => a.name === n);
  const actIdle = mixer.clipAction(clip("idle")), actWalk = mixer.clipAction(clip("walk"));
  actIdle.play(); actWalk.play(); actWalk.setEffectiveWeight(0);

  // ---------- state ----------
  const R = { pos: HOME.pos.clone(), yaw: HOME.yaw, v: 0, path: null, s: 0, len: 0, done: null, target: null, finalYaw: null, purpose: null };
  const G = { pos: GUEST_START.clone(), yaw: -2.2, vel: V3(), mode: "stand", look: null, side: 1, goal: null, final: null, maxV: 1.9 };
  G.look = R.pos;
  let presenting = null;     // car id the pair is standing at
  const grid = navGrid();

  // ---------- robot screen frames (3D + picture-in-picture) ----------
  const frames = [screen3d.iframe, pip];
  const screenState = { init: null, view: { t: "view", view: "eyes" } };
  const post = m => frames.forEach(f => f.contentWindow && f.contentWindow.postMessage(m, "*"));
  addEventListener("message", e => {
    const m = e.data || {};
    if (m.t === "screen-ready") { if (screenState.init) e.source.postMessage(screenState.init, "*"); e.source.postMessage(screenState.view, "*"); }
    if (m.t === "tap") emit("tap", m.car);
  });
  if (window.SIM_SCREEN_HTML) pip.srcdoc = screen3d.iframe.srcdoc = window.SIM_SCREEN_HTML;
  else pip.src = screen3d.iframe.src = "screen.html";
  const thumbs = carThumbs();
  screenState.init = { t: "init", cars: CARS, thumbs };
  post(screenState.init);
  function screen(view, car) { screenState.view = { t: "view", view, car }; post(screenState.view); }

  // ---------- navigation ----------
  function navGrid() {
    const cs = 0.25, W = Math.round((HALL.x1 - HALL.x0) / cs), H = Math.round((HALL.z1 - HALL.z0 + 6) / cs);
    const z0 = HALL.z0, block = new Uint8Array(W * H);
    const cellXZ = (i, j) => [HALL.x0 + (i + 0.5) * cs, z0 + (j + 0.5) * cs];
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const [x, z] = cellXZ(i, j); let b = false;
      if (x < HALL.x0 + 0.9 || x > HALL.x1 - 0.9 || z < HALL.z0 + 0.9) b = true;
      if (Math.abs(z - HALL.z1) < 0.9 && !(x > DOOR.x0 + 0.5 && x < DOOR.x1 - 0.5)) b = true;
      for (const c of CARS) if (Math.hypot(x - c.spot[0], z - c.spot[1]) < 3.55) b = true;
      for (const c of CARS) { const p = cardPos(c); if (Math.hypot(x - p.x, z - p.z) < 0.75) b = true; }
      if (x < -11.6 && z > 3.6 && z < 9.4) b = true;    // reception desk
      block[j * W + i] = b ? 1 : 0;
    }
    const toCell = p => [Math.max(0, Math.min(W - 1, Math.floor((p.x - HALL.x0) / cs))), Math.max(0, Math.min(H - 1, Math.floor((p.z - z0) / cs)))];
    const free = (i, j) => i >= 0 && j >= 0 && i < W && j < H && !block[j * W + i];
    function nearestFree([i, j]) {
      if (free(i, j)) return [i, j];
      for (let r = 1; r < 30; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) if (free(i + di, j + dj)) return [i + di, j + dj];
      return [i, j];
    }
    function los(a, b) {
      const n = Math.ceil(a.distanceTo(b) / (cs * 0.5));
      for (let k = 0; k <= n; k++) { const p = a.clone().lerp(b, k / n), [i, j] = toCell(p); if (!free(i, j)) return false; }
      return true;
    }
    function find(from, to) {
      const s = nearestFree(toCell(from)), t = nearestFree(toCell(to));
      const idx = (i, j) => j * W + i, gS = new Float32Array(W * H).fill(Infinity), prev = new Int32Array(W * H).fill(-1);
      const open = [[0, s[0], s[1]]]; gS[idx(...s)] = 0;
      const hx = (i, j) => Math.hypot(i - t[0], j - t[1]);
      while (open.length) {
        let bi = 0; for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
        const [, i, j] = open.splice(bi, 1)[0];
        if (i === t[0] && j === t[1]) break;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue; const ni = i + di, nj = j + dj; if (!free(ni, nj)) continue;
          const ng = gS[idx(i, j)] + (di && dj ? 1.4142 : 1);
          if (ng < gS[idx(ni, nj)]) { gS[idx(ni, nj)] = ng; prev[idx(ni, nj)] = idx(i, j); open.push([ng + hx(ni, nj), ni, nj]); }
        }
      }
      const cells = []; let k = idx(...t);
      if (prev[k] < 0 && k !== idx(...s)) return [from.clone(), to.clone()];
      while (k >= 0) { cells.push(k); k = prev[k]; }
      cells.reverse();
      const pts = [from.clone()];
      for (const c of cells) { const [x, z] = cellXZ(c % W, Math.floor(c / W)); pts.push(V3(x, 0, z)); }
      pts.push(to.clone());
      const out = [pts[0]]; let a = 0;                      // string pulling
      while (a < pts.length - 1) { let b = pts.length - 1; while (b > a + 1 && !los(pts[a], pts[b])) b--; out.push(pts[b]); a = b; }
      return out;
    }
    return { find };
  }

  function smoothPath(pts) {
    let p = pts;
    for (let it = 0; it < 3; it++) {                        // Chaikin corner cutting keeps the ends fixed
      const q = [p[0]];
      for (let i = 0; i < p.length - 1; i++) { q.push(p[i].clone().lerp(p[i + 1], 0.25)); q.push(p[i].clone().lerp(p[i + 1], 0.75)); }
      q.push(p[p.length - 1]); p = q;
    }
    const cum = [0]; for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + p[i].distanceTo(p[i - 1]));
    return { pts: p, cum, len: cum[cum.length - 1] };
  }
  function pathAt(path, s) {
    s = Math.max(0, Math.min(path.len, s));
    let i = 1; while (i < path.cum.length - 1 && path.cum[i] < s) i++;
    const a = path.pts[i - 1], b = path.pts[i], seg = path.cum[i] - path.cum[i - 1] || 1;
    return a.clone().lerp(b, (s - path.cum[i - 1]) / seg);
  }

  function driveTo(target, finalYaw, purpose) {
    const raw = grid.find(R.pos, target);
    R.path = smoothPath(raw); R.s = 0; R.target = target.clone(); R.finalYaw = finalYaw; R.purpose = purpose;
    if (R.done) R.done(false);
    return new Promise(res => { R.done = ok => { R.done = null; res(ok); }; });
  }

  // car viewing spots: the guest in front, the robot to one side, both facing the car
  function carSpots(c) {
    const o = carObjs[c.id], center = V3(c.spot[0], 0, c.spot[1]);
    const dir = V3(0, 0, o.aisle), lat = V3(-dir.z, 0, dir.x);
    const gPos = center.clone().addScaledVector(dir, 3.85).addScaledVector(lat, -0.3);
    const rPos = center.clone().addScaledVector(dir, 4.05).addScaledVector(lat, 1.15);
    const facing = lerpYaw(yawTo(rPos, center), yawTo(rPos, gPos), 0.55);
    return { center, dir, lat, gPos, rPos, rYaw: facing };
  }

  async function walkToCar(id, { withGuest = true } = {}) {
    const c = byId(id); if (!c) return false;
    const sp = carSpots(c);
    presenting = null;
    if (withGuest) {
      G.mode = "follow"; G.final = { pos: sp.gPos, look: sp.center };
      const end = sp.rPos.clone().sub(R.pos), side = Math.sign(end.x * (sp.gPos.z - sp.rPos.z) - end.z * (sp.gPos.x - sp.rPos.x)) || 1;
      G.side = -side;
    }
    screen("walk", id); emit("walk", { car: id, eta: Math.round(estimate(sp.rPos)) });
    const ok = await driveTo(sp.rPos, sp.rYaw, "car:" + id);
    if (ok) { presenting = id; screen("car", id); emit("arrive", { car: id }); }
    return ok;
  }
  function estimate(target) { const p = smoothPath(grid.find(R.pos, target)); return p.len / SPEED + 1.5; }

  async function goHome() {
    presenting = null; G.mode = "stand"; G.look = R.pos;
    screen("eyes");
    const ok = await driveTo(HOME.pos, HOME.yaw, "home");
    if (ok) emit("home");
    return ok;
  }

  // a new guest walks in through the door; the robot meets them a couple of metres inside
  async function guestArrives() {
    presenting = null;
    if (R.done) R.done(false); R.path = null;
    G.mode = "goto"; G.pos.set(-4, 0, 14.5); G.vel.set(0, 0, 0); G.yaw = Math.PI; G.goal = V3(-4.6, 0, 6.2); G.maxV = 1.25;
    emit("guest-in");
    await new Promise(r => { const t = setInterval(() => { if (G.pos.z < 9.6) { clearInterval(t); r(); } }, 100); });
    const meet = V3(-5.6, 0, 4.9);
    const ok = await driveTo(meet, yawTo(meet, G.goal), "greet");
    G.mode = "stand"; G.look = R.pos; G.maxV = 1.9;
    if (ok) { screen("hello"); emit("greeted"); }
    return ok;
  }

  function stop() { if (R.done) R.done(false); R.path = null; }

  // attract mode (behind the password card): the robot tours the cars on its own while the camera sweeps the floor
  let attracting = false;
  async function attract(on) {
    attracting = on;
    if (!on) {
      stop(); presenting = null;
      R.pos.copy(HOME.pos); R.yaw = HOME.yaw; R.finalYaw = HOME.yaw;
      G.mode = "stand"; G.pos.copy(GUEST_START); G.vel.set(0, 0, 0); G.look = R.pos;
      screen("eyes"); setCamera("follow"); camPos.copy(camGoal().pos);
      return;
    }
    camMode = "cinematic"; orbit.enabled = false; G.mode = "stand"; G.look = R.pos;
    const tour = ["atlas7", "meridian", "caravan8", "pulse", "stradagt", "summit"];
    for (let i = 0; attracting; i++) {
      const c = byId(tour[i % tour.length]), sp = carSpots(c);
      screen("walk", c.id);
      const ok = await driveTo(sp.rPos, yawTo(sp.rPos, sp.center), "car:" + c.id);
      if (!attracting || !ok) break;
      presenting = c.id; screen("car", c.id);
      await new Promise(r => setTimeout(r, 2800));
      presenting = null;
    }
  }

  // ---------- per-frame motion ----------
  function stepRobot(dt) {
    if (!R.path) {
      if (R.finalYaw != null) R.yaw = turn(R.yaw, R.finalYaw, 2.4 * dt);
      R.v = 0; return 0;
    }
    const rem = R.path.len - R.s;
    const ahead = pathAt(R.path, R.s + 0.6), want = rem > 0.3 ? yawTo(R.pos, ahead) : R.yaw;
    const err = Math.abs(angDiff(R.yaw, want));
    R.yaw = turn(R.yaw, want, 2.2 * dt);
    let vmax = Math.min(SPEED, Math.sqrt(2 * ACCEL * Math.max(0, rem)) + 0.05);
    if (err > 0.5) vmax = Math.min(vmax, 0.15);               // turn on the spot first
    R.v = Math.min(vmax, R.v + ACCEL * dt);
    const ds = R.v * dt; R.s += ds;
    R.pos.copy(pathAt(R.path, R.s));
    emit("progress", R.s / R.path.len);
    if (R.purpose && R.purpose.startsWith("car:")) post({ t: "progress", p: R.s / R.path.len });
    if (R.s >= R.path.len - 0.01) { R.path = null; R.v = 0; R.done && R.done(true); }
    return ds;
  }

  function stepGuest(dt) {
    let target = null, look = G.look;
    if (G.mode === "follow") {
      const fwd = V3(Math.sin(R.yaw), 0, Math.cos(R.yaw)), left = V3(fwd.z, 0, -fwd.x);
      target = R.pos.clone().addScaledVector(left, 0.95 * G.side).addScaledVector(fwd, -0.15);
      if (G.final) {
        const rem = R.path ? R.path.len - R.s : 0;
        const k = R.path ? Math.min(1, Math.max(0, 1 - (rem - 0.4) / 2.2)) : 1;
        target.lerp(G.final.pos, k);
        if (!R.path && G.pos.distanceTo(G.final.pos) < 0.2) look = G.final.look;
      }
    } else if (G.mode === "goto") {
      target = G.goal;
      if (G.pos.distanceTo(G.goal) < 0.15) { G.mode = "stand"; look = R.pos; }
    }
    if (target) {
      const d = target.clone().sub(G.pos); d.y = 0;
      const want = d.multiplyScalar(2.4); if (want.length() > G.maxV) want.setLength(G.maxV);
      if (G.mode === "follow" && d.length() < 0.06) want.set(0, 0, 0);
      G.vel.lerp(want, 1 - Math.exp(-5 * dt));
    } else G.vel.multiplyScalar(Math.exp(-8 * dt));
    G.pos.addScaledVector(G.vel, dt);
    // never stand inside the robot
    const away = G.pos.clone().sub(R.pos); away.y = 0; const dd = away.length();
    if (dd < 0.75 && dd > 1e-3) G.pos.addScaledVector(away.normalize(), 0.75 - dd);
    const sp = G.vel.length();
    const faceYaw = sp > 0.25 ? Math.atan2(G.vel.x, G.vel.z) : look ? yawTo(G.pos, look) : G.yaw;
    G.yaw = turn(G.yaw, faceYaw, (sp > 0.25 ? 6 : 3) * dt);
    const w = Math.min(1, sp / 0.7);
    actWalk.setEffectiveWeight(w); actIdle.setEffectiveWeight(1 - w);
    actWalk.timeScale = Math.max(0.6, sp / 1.25);
    mixer.update(dt);
    if (G.mode === "follow" && G.final && !R.path) {
      if (G.pos.distanceTo(G.final.pos) < 0.06 && sp < 0.05) G.vel.set(0, 0, 0);
    }
  }

  // ---------- cameras ----------
  let camMode = "follow";
  const camPos = camera.position.clone(), camLook = V3(-6, 1, 3);
  const OVERVIEW = { pos: V3(0, 25, 20.5), look: V3(0, 0, -0.5) };
  function setCamera(mode) {
    camMode = mode; orbit.enabled = mode === "free";
    if (mode === "free") { orbit.target.copy(camLook); }
    emit("camera", mode);
  }
  renderer.domElement.addEventListener("pointerdown", () => { if (camMode !== "free") setCamera("free"); });
  renderer.domElement.addEventListener("wheel", () => { if (camMode !== "free") setCamera("free"); }, { passive: true });

  function camGoal() {
    if (camMode === "overview") return OVERVIEW;
    if (camMode === "cinematic") {
      const t = performance.now() / 1000;
      return { pos: V3(Math.sin(t * 0.07) * 12.5, 6.2 + Math.sin(t * 0.13) * 1.1, 1 + Math.cos(t * 0.07) * 7.5),
               look: V3(0, 0.8, -1).lerp(R.pos, 0.55).setY(1) };
    }
    const mid = R.pos.clone().lerp(G.pos, 0.5);
    if (presenting && !R.path) {
      const sp = carSpots(byId(presenting));
      return { pos: sp.center.clone().addScaledVector(sp.dir, 8.6).addScaledVector(sp.lat, -5.2).setY(3.9),
               look: sp.center.clone().lerp(mid, 0.45).setY(0.9) };
    }
    const fwd = V3(Math.sin(R.yaw), 0, Math.cos(R.yaw)), left = V3(fwd.z, 0, -fwd.x);
    if (R.path) return { pos: mid.clone().addScaledVector(fwd, -6.2).addScaledVector(left, 2.8 * G.side).setY(3.6),
                         look: mid.clone().addScaledVector(fwd, 2.5).setY(0.9) };
    return { pos: mid.clone().add(V3(5.2, 2.7, -3.6)), look: mid.clone().setY(1.0) };
  }

  // ---------- frame loop ----------
  const ray = new THREE.Raycaster(); let frame = 0, last = performance.now(), speaking = false;
  function resize() {
    const { width, height } = stage.getBoundingClientRect();
    renderer.setSize(width, height); cssRenderer.setSize(width, height);
    camera.aspect = width / height; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage); resize();

  function tick() {
    // the walk runs in real time even when frames are slow: step the motion in small fixed slices
    const now = performance.now(), total = Math.min(1, (now - last) / 1000), n = Math.max(1, Math.ceil(total / 0.04)), dt = total / n;
    last = now; frame++;
    let ds = 0;
    for (let i = 0; i < n; i++) { ds += stepRobot(dt); stepGuest(dt); }
    for (const w of wheels) w.rotation.x += ds / (0.047 * ROBOT_SCALE);
    robot.position.copy(R.pos); robot.rotation.y = R.yaw;
    guest.position.copy(G.pos); guest.rotation.y = G.yaw;
    const glow = speaking ? 2.3 + Math.sin(now / 90) * 1.4 : 2.3;
    for (const m of leds) m.emissiveIntensity = glow;

    if (camMode !== "free") {
      const g = camGoal(), k = 1 - Math.exp(-(camMode === "overview" ? 2.5 : 1.6) * total);
      if (camMode === "follow") { g.pos.x = Math.max(HALL.x0 + 1.2, Math.min(HALL.x1 - 1.2, g.pos.x)); g.pos.z = Math.max(HALL.z0 + 1.2, Math.min(HALL.z1 - 0.8, g.pos.z)); }
      camPos.lerp(g.pos, k); camLook.lerp(g.look, k);
      camera.position.copy(camPos); camera.lookAt(camLook);
    } else { orbit.update(); camPos.copy(camera.position); camLook.copy(orbit.target); }

    robot.updateMatrixWorld(true);
    screen3d.update(camera, frame % 3 === 0 ? ray : null);
    renderer.render(scene, camera); cssRenderer.render(cssScene, camera);
    if (frame % 2 === 0) placeLabels();
  }
  renderer.setAnimationLoop(tick);
  // animation frames pause when the page is hidden; keep the robot walking (and in step with its voice) anyway
  setInterval(() => { if (performance.now() - last > 150) tick(); }, 50);

  const tmp = V3();
  function placeLabels() {
    const { width, height } = stage.getBoundingClientRect();
    for (const c of CARS) {
      const o = carObjs[c.id]; tmp.set(c.spot[0], 2.6, c.spot[1]).project(camera);
      const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
      o.label.style.display = vis ? "" : "none";
      if (vis) o.label.style.transform = `translate(${(tmp.x + 1) / 2 * width}px,${(1 - tmp.y) / 2 * height}px) translate(-50%,-100%)`;
      o.label.classList.toggle("on", presenting === c.id || (R.purpose === "car:" + c.id && !!R.path));
    }
  }

  // ---------- builders ----------
  function robotScreen(rbRoot) {
    rbRoot.updateMatrixWorld(true);
    let glass; rbRoot.traverse(o => { if (o.name.includes("glass screen") || o.name.includes("glass_screen")) glass = o; });
    const iframe = document.createElement("iframe");
    iframe.title = "Robot screen";
    iframe.style.cssText = "width:1024px;height:576px;border:0;background:#17181a;display:block;backface-visibility:hidden;pointer-events:auto";
    const obj = new CSS3DObject(iframe); obj.matrixAutoUpdate = false; cssScene.add(obj);
    // screen pose in robot coordinates (robot group at the origin while we measure)
    const q = new THREE.Quaternion(); glass.getWorldQuaternion(q);
    const normal = V3(0, 1, 0).applyQuaternion(q), up = V3(0, 0, -1).applyQuaternion(q), right = V3(1, 0, 0).applyQuaternion(q);
    const p = V3(); glass.getWorldPosition(p); p.addScaledVector(normal, 0.0015 * ROBOT_SCALE);
    const local = new THREE.Matrix4().makeBasis(right, up, normal).setPosition(p)
      .multiply(new THREE.Matrix4().makeScale(0.257 * ROBOT_SCALE / 1024, 0.144 * ROBOT_SCALE / 576, 1));
    const worldN = V3(), worldP = V3();
    return {
      iframe,
      update(cam, rayc) {
        obj.matrix.multiplyMatrices(robot.matrixWorld, local);
        worldP.setFromMatrixPosition(obj.matrix);
        worldN.copy(normal).applyQuaternion(robot.quaternion);
        let vis = worldN.dot(cam.position.clone().sub(worldP)) > 0.01 && cam.position.distanceTo(worldP) < 30;
        if (vis && rayc) {
          const d = worldP.clone().sub(cam.position), dist = d.length();
          rayc.set(cam.position, d.normalize()); rayc.far = dist - 0.3;
          obj.userData.hidden = rayc.intersectObjects(occluders, false).length > 0;
        }
        obj.visible = vis && !obj.userData.hidden;
      },
    };
  }

  function wordmark(text) {
    const cv = document.createElement("canvas"); cv.width = 512; cv.height = 2048;
    const ctx = cv.getContext("2d"); ctx.translate(256, 1024); ctx.rotate(Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#51402d"; ctx.font = "400 300px Arial, sans-serif";
    const s = Math.min(1, 1800 / ctx.measureText(text).width); ctx.scale(s, s); ctx.fillText(text, 0, 0);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(1, 1, 20, 100), pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {                   // wrap onto the curved shell (same fit as the model viewer)
      const x = (uv.getX(i) - 0.5) * 0.055, y = (uv.getY(i) - 0.5) * 0.21 + 0.72;
      const t = (y - 0.302) / (0.987 - 0.11 - 0.302), r = 0.245 - 0.064 * Math.sin(Math.PI * 0.8 * t) + 0.0086 * t;
      pos.setXYZ(i, x, y, Math.sqrt(Math.max(0.001, r * r - x * x)) + 0.0027);
    }
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.05, roughness: 0.35, metalness: 0.35, side: THREE.DoubleSide }));
  }

  function carThumbs() {
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setSize(640, 360); r.toneMapping = THREE.ACESFilmicToneMapping;
    const sc = new THREE.Scene(); sc.environment = scene.environment; sc.environmentIntensity = 0.8;
    sc.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
    const d = new THREE.DirectionalLight(0xffffff, 2); d.position.set(4, 6, 5); sc.add(d);
    const cam = new THREE.PerspectiveCamera(30, 640 / 360, 0.1, 50);
    const out = {};
    for (const c of CARS) {
      const g = carObjs[c.id].g.clone(); g.position.set(0, 0, 0); g.rotation.y = 0; sc.add(g);
      cam.position.set(5.4, 2.2, 6.6); cam.lookAt(0, 0.75, 0);
      r.render(sc, cam); out[c.id] = r.domElement.toDataURL("image/png"); sc.remove(g);
    }
    r.dispose();
    return out;
  }

  return {
    walkToCar, goHome, guestArrives, stop, screen, setCamera, attract,
    setSpeaking(on) { speaking = on; post({ t: "speaking", on }); },
    caption(text) { post({ t: "caption", text }); },
    get presenting() { return presenting; },
    get moving() { return !!R.path; },
    thumbs,
    debug: () => ({ R, G, camMode }),
  };
}

// ---------- helpers ----------
function cardPos(c) { const aisle = c.spot[1] < 0 ? 1 : -1; return V3(c.spot[0] - 2.9, 0, c.spot[1] + aisle * 2.6); }
function yawTo(a, b) { return Math.atan2(b.x - a.x, b.z - a.z); }
function angDiff(a, b) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
function turn(a, b, max) { const d = angDiff(a, b); return a + Math.max(-max, Math.min(max, d)); }
function lerpYaw(a, b, t) { return a + angDiff(a, b) * t; }

function buildHall(scene, occluders) {
  const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...o });
  // outside ground, then the polished hall floor with a faint tile grid
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), mat("#c9ccca", { roughness: 0.9 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; ground.receiveShadow = true; scene.add(ground);
  const cv = document.createElement("canvas"); cv.width = cv.height = 256;
  const c = cv.getContext("2d"); c.fillStyle = "#ecebe7"; c.fillRect(0, 0, 256, 256);
  c.strokeStyle = "rgba(120,120,115,.22)"; c.lineWidth = 2; c.strokeRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(32 / 1.6, 20 / 1.6);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(32, 20), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.22, metalness: 0.05 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);

  const wall = (w, h, d, x, y, z, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.receiveShadow = true; scene.add(b); occluders.push(b); return b; };
  const wm = mat("#e3e0da", { roughness: 0.85 });
  wall(32.4, 4.6, 0.3, 0, 2.3, -10.15, wm);
  wall(0.3, 4.6, 20.3, -16.15, 2.3, 0, wm);
  wall(0.3, 4.6, 20.3, 16.15, 2.3, 0, wm);
  // back wall feature: dark panel with a warm light line
  wall(20, 2.6, 0.06, 0, 2.2, -9.97, mat("#2a2c2f", { roughness: 0.5 }));
  const strip = new THREE.Mesh(new THREE.BoxGeometry(20, 0.05, 0.05), new THREE.MeshStandardMaterial({ color: "#000", emissive: "#ffcf9a", emissiveIntensity: 3 }));
  strip.position.set(0, 3.55, -9.92); scene.add(strip);
  // front glass with mullions and a door gap
  const glass = new THREE.MeshPhysicalMaterial({ color: "#cfe2e8", transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0, depthWrite: false });
  const frame = mat("#3b3e42", { roughness: 0.4, metalness: 0.6 });
  for (const [x0, x1] of [[-16, -6], [-2, 16]]) {
    const g = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 4.6, 0.04), glass); g.position.set((x0 + x1) / 2, 2.3, 10); scene.add(g);
    for (let x = x0; x <= x1 + 0.01; x += (x1 - x0) / Math.round((x1 - x0) / 3)) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.05, 4.6, 0.06), frame); m.position.set(x, 2.3, 10); scene.add(m); }
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.5, 0.14), frame); lintel.position.set(-4, 4.35, 10); scene.add(lintel);
  const mat2 = new THREE.Mesh(new THREE.PlaneGeometry(4, 2.4), mat("#3f4246", { roughness: 0.95 })); mat2.rotation.x = -Math.PI / 2; mat2.position.set(-4, 0.004, 8.9); mat2.receiveShadow = true; scene.add(mat2);

  // reception desk
  const desk = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 4.6), mat("#c99f6e", { roughness: 0.45 })); top.position.y = 1.1; desk.add(top);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.06, 4.4), mat("#f2efe9", { roughness: 0.5 })); body.position.y = 0.53; desk.add(body);
  desk.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; occluders.push(o); } });
  desk.position.set(-13.4, 0, 6.5); scene.add(desk);
  // plants for scale
  for (const [x, z] of [[-14.8, -8.6], [14.8, -8.6], [14.8, 8.4], [-14.8, 9.2]]) {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.26, 0.6, 24), mat("#d8d3ca")); pot.position.set(x, 0.3, z);
    const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 1), mat("#5f7d5a", { flatShading: true })); leaf.position.set(x, 1.15, z); leaf.scale.set(1, 1.4, 1);
    for (const m of [pot, leaf]) { m.castShadow = true; scene.add(m); }
  }
}

function plinth([x, z]) {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.15, 0.08, 72), new THREE.MeshStandardMaterial({ color: "#f7f6f3", roughness: 0.18, metalness: 0.1 }));
  disc.position.y = 0.04; disc.receiveShadow = true; g.add(disc);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(3.12, 0.018, 8, 120), new THREE.MeshStandardMaterial({ color: "#000", emissive: "#e3a876", emissiveIntensity: 2.2 }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.075; g.add(ring);
  g.position.set(x, 0, z); return g;
}

function standCard(c, pos, aisle) {
  const cv = document.createElement("canvas"); cv.width = 512; cv.height = 640;
  const x = cv.getContext("2d");
  x.fillStyle = "#1b1c1f"; x.fillRect(0, 0, 512, 640);
  x.fillStyle = "#c78e66"; x.fillRect(0, 632, 120, 8);
  x.fillStyle = "#f4f2ef"; x.font = "600 64px Segoe UI, sans-serif"; x.fillText(c.name, 40, 120);
  x.fillStyle = "#8a9099"; x.font = "400 30px Segoe UI, sans-serif"; x.fillText(c.type, 40, 172);
  x.strokeStyle = "#2e3033"; x.lineWidth = 2;
  c.key.forEach(([v, u], i) => {
    const y = 250 + i * 110; x.beginPath(); x.moveTo(40, y - 60); x.lineTo(472, y - 60); x.stroke();
    x.fillStyle = "#f4f2ef"; x.font = "600 58px Segoe UI, sans-serif"; x.fillText(v, 40, y + 20);
    const w = x.measureText(v).width; x.fillStyle = "#8a9099"; x.font = "400 28px Segoe UI, sans-serif"; x.fillText(u, 56 + w, y + 20);
  });
  x.fillStyle = "#c78e66"; x.font = "500 32px Segoe UI, sans-serif"; x.fillText(c.price, 40, 600);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const g = new THREE.Group();
  const card = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.0), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  card.position.y = 1.25; g.add(card);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.84, 1.04, 0.03), new THREE.MeshStandardMaterial({ color: "#2a2c2f" })); back.position.set(0, 1.25, -0.02); g.add(back);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.75, 12), new THREE.MeshStandardMaterial({ color: "#3b3e42", metalness: 0.7, roughness: 0.3 })); pole.position.y = 0.37; g.add(pole);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.03, 24), new THREE.MeshStandardMaterial({ color: "#3b3e42" })); base.position.y = 0.015; g.add(base);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.position.copy(pos); g.rotation.y = aisle > 0 ? 0.35 : Math.PI - 0.35;
  return g;
}

// Kenney cars share one colour-atlas texture: bake it into vertex colours, swap the main body colour for our paint,
// darken the glass, and give the body a clear-coat finish.
function paintCar(root, paint) {
  const paintC = new THREE.Color(paint);
  let px = null, W = 0, H = 0;
  const meshes = []; root.traverse(o => { if (o.isMesh) meshes.push(o); });
  for (const o of meshes) {
    const img = o.material.map && o.material.map.image;
    if (!img) continue;
    if (!px) { const cv = document.createElement("canvas"); W = cv.width = img.width; H = cv.height = img.height; const c = cv.getContext("2d"); c.drawImage(img, 0, 0); px = c.getImageData(0, 0, W, H).data; }
  }
  if (!px) return;
  const sample = (u, v) => { const x = Math.min(W - 1, Math.max(0, Math.floor(u * W))), y = Math.min(H - 1, Math.max(0, Math.floor(v * H))), i = (y * W + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  const sat = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx ? (mx - mn) / mx : 0; };
  const hue = ([r, g, b]) => { const c = new THREE.Color(r / 255, g / 255, b / 255), h = {}; c.getHSL(h); return h.h * 360; };
  const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  // dominant saturated hue on the body = the paint (the atlas paints it as a gradient, so match by hue, not exact colour)
  const bins = new Array(24).fill(0), lum = new Array(24).fill(0);
  for (const o of meshes) {
    if (!/body/i.test(o.name)) continue;
    const uv = o.geometry.attributes.uv; if (!uv) continue;
    for (let i = 0; i < uv.count; i++) {
      const s = sample(uv.getX(i), uv.getY(i)); if (sat(s) < 0.3) continue;
      const k = Math.floor(hue(s) / 15) % 24; bins[k]++; lum[k] += Math.max(...s) / 255;
    }
  }
  const best = bins.indexOf(Math.max(...bins)), paintHue = best * 15 + 7.5, meanL = bins[best] ? lum[best] / bins[best] : 1;
  const tmp = new THREE.Color();
  for (const o of meshes) {
    const geo = o.geometry, uv = geo.attributes.uv; if (!uv || geo.userData.painted) continue;
    geo.userData.painted = true;
    const col = new Float32Array(uv.count * 3);
    for (let i = 0; i < uv.count; i++) {
      const s = sample(uv.getX(i), uv.getY(i));
      if (bins[best] && sat(s) >= 0.3 && hueDist(hue(s), paintHue) < 24) tmp.copy(paintC).multiplyScalar(Math.min(1.25, Math.max(0.7, Math.max(...s) / 255 / meanL)));
      else tmp.setRGB(s[0] / 255, s[1] / 255, s[2] / 255, THREE.SRGBColorSpace);
      col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const wheel = /wheel/i.test(o.name) || /wheel/i.test(o.parent?.name || "");
    o.material = wheel
      ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2 })
      : new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.45, clearcoat: 1, clearcoatRoughness: 0.06 });
  }
}

function woodShader(m) {
  m.color.setRGB(0.8, 0.62, 0.38); m.roughness = 0.45;
  m.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vWoodWorld;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWoodWorld=(vec4(transformed,1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vWoodWorld;
float hashWood(vec3 p){p=fract(p*.3183099+vec3(.1,.2,.3));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noiseWood(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hashWood(i),hashWood(i+vec3(1,0,0)),f.x),mix(hashWood(i+vec3(0,1,0)),hashWood(i+vec3(1,1,0)),f.x),f.y),mix(mix(hashWood(i+vec3(0,0,1)),hashWood(i+vec3(1,0,1)),f.x),mix(hashWood(i+vec3(0,1,1)),hashWood(i+vec3(1,1,1)),f.x),f.y),f.z);}
`).replace("#include <color_fragment>", `#include <color_fragment>
vec3 wp=vec3(vWoodWorld.x*850.,vWoodWorld.z*7.,vWoodWorld.y*1.5);
float grain=noiseWood(wp)*.7+noiseWood(wp*2.7)*.3;
diffuseColor.rgb=mix(vec3(.48,.31,.14),vec3(.70,.52,.29),smoothstep(.12,.85,grain));`);
  };
}
