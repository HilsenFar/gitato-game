// GITATO COMMAND — Three.js scene: top-down C&C-style camera, procedural neon meshes
'use strict';

RTS.scene3d = (() => {
  const C = RTS.C, K = RTS.KINDS, U = RTS.util;
  const T = C.TILE;
  const TILT = 57 * Math.PI / 180;   // camera elevation angle above the ground
  const BASE_DIST = 620;

  let renderer = null, scene = null, camera = null;
  let ground = null, fogMesh = null, fogTex = null;
  let rocks = null;
  let ghost = null;
  const meshes = new Map();   // ent id -> { group, kind, owner }
  const rings = [];           // selection ring pool
  const projPool = [];        // projectile mesh pool
  let mats = null;

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const tmpV = new THREE.Vector3();

  function init(glCanvas) {
    renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    camera = new THREE.PerspectiveCamera(45, 1, 10, 6000);
  }

  function makeMats() {
    const m = {};
    const mk = (hex, e, ei) => new THREE.MeshStandardMaterial({
      color: hex, emissive: e, emissiveIntensity: ei == null ? 0.55 : ei,
      roughness: 0.45, metalness: 0.25,
    });
    m.p = [
      { body: mk(0x0a4a44, 0x00ffdc), soft: mk(0x083630, 0x00ffdc, 0.3) },
      { body: mk(0x4a0a36, 0xff28b4), soft: mk(0x360826, 0xff28b4, 0.3) },
    ];
    m.crystal = new THREE.MeshStandardMaterial({
      color: 0x1d5a33, emissive: 0x50dc78, emissiveIntensity: 0.8,
      roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.92,
    });
    m.rock = new THREE.MeshStandardMaterial({ color: 0x242348, emissive: 0x121230, emissiveIntensity: 0.35, roughness: 0.9 });
    m.bolt = new THREE.MeshBasicMaterial({ color: 0xeaffff });
    m.shell = new THREE.MeshBasicMaterial({ color: 0xffb050 });
    m.ringSel = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    m.ghostOk = new THREE.MeshBasicMaterial({ color: 0x00ffdc, transparent: true, opacity: 0.4 });
    m.ghostBad = new THREE.MeshBasicMaterial({ color: 0xff4060, transparent: true, opacity: 0.4 });
    return m;
  }

  // fresh scene per match
  function setup(map, terrainCanvas, fogCanvas) {
    disposeScene();
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x04040c);
    scene.fog = new THREE.Fog(0x04040c, 1600, 4200);
    mats = mats || makeMats();

    scene.add(new THREE.AmbientLight(0x8888aa, 0.75));
    const dir = new THREE.DirectionalLight(0xffffff, 0.75);
    dir.position.set(0.4, 1, 0.25);
    scene.add(dir);

    // ground: the procedural 2D terrain canvas becomes the texture
    const gtex = new THREE.CanvasTexture(terrainCanvas);
    gtex.anisotropy = 4;
    const W = map.W * T, H = map.H * T;
    ground = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      new THREE.MeshStandardMaterial({ map: gtex, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(W / 2, 0, H / 2);
    scene.add(ground);

    // rocks: one instanced box per rock tile for relief
    let count = 0;
    for (let i = 0; i < map.rock.length; i++) if (map.rock[i]) count++;
    rocks = new THREE.InstancedMesh(new THREE.BoxGeometry(T * 0.96, 16, T * 0.96), mats.rock, Math.max(1, count));
    const im = new THREE.Matrix4();
    let n = 0;
    const rnd = U.rng(11);
    for (let ty = 0; ty < map.H; ty++) for (let tx = 0; tx < map.W; tx++) {
      if (!map.rock[ty * map.W + tx]) continue;
      const h = 10 + rnd() * 14;
      im.makeScale(1, h / 16, 1);
      im.setPosition((tx + 0.5) * T, h / 2, (ty + 0.5) * T);
      rocks.setMatrixAt(n++, im);
    }
    rocks.instanceMatrix.needsUpdate = true;
    scene.add(rocks);

    // fog of war: dark plane floating above, textured from the fog canvas
    fogTex = new THREE.CanvasTexture(fogCanvas);
    fogTex.magFilter = THREE.LinearFilter;
    fogMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      new THREE.MeshBasicMaterial({ map: fogTex, transparent: true, depthWrite: false }));
    fogMesh.rotation.x = -Math.PI / 2;
    fogMesh.position.set(W / 2, 40, H / 2);
    fogMesh.renderOrder = 10;
    scene.add(fogMesh);

    ghost = null;
    meshes.clear();
    rings.length = 0;
    projPool.length = 0;
  }

  function disposeScene() {
    if (!scene) return;
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.map && o.material.map.dispose) o.material.map.dispose();
    });
    scene = null;
  }

  // ---- mesh factory (all procedural neon primitives) ----
  function buildMesh(kind, owner) {
    const g = new THREE.Group();
    const pm = owner < 2 ? mats.p[owner] : null;
    const add = (geo, mat, x, y, z, ry) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x || 0, y || 0, z || 0);
      if (ry) m.rotation.z = ry;
      g.add(m);
      return m;
    };
    switch (kind) {
      case 'crystal': {
        const m = add(new THREE.OctahedronGeometry(11), mats.crystal, 0, 13, 0);
        m.scale.y = 1.7;
        m.rotation.y = 0.5;
        break;
      }
      case 'worker':
        add(new THREE.SphereGeometry(7, 12, 10), pm.body, 0, 7, 0);
        add(new THREE.BoxGeometry(9, 3, 3), pm.soft, 7, 7, 0);
        break;
      case 'marine': {
        const cone = add(new THREE.ConeGeometry(7, 20, 8), pm.body, 0, 8, 0);
        cone.rotation.z = -Math.PI / 2; // point along +x
        add(new THREE.SphereGeometry(4, 8, 8), pm.soft, -4, 12, 0);
        break;
      }
      case 'brute':
        add(new THREE.DodecahedronGeometry(12), pm.body, 0, 11, 0);
        add(new THREE.BoxGeometry(10, 4, 4), pm.soft, 10, 8, 0);
        break;
      case 'mortar':
        add(new THREE.BoxGeometry(20, 10, 16), pm.body, 0, 6, 0);
        add(new THREE.CylinderGeometry(2.5, 3, 20, 8), pm.soft, 6, 14, 0, -1.0);
        break;
      case 'hq': {
        add(new THREE.CylinderGeometry(T * 1.3, T * 1.45, 30, 6), pm.body, 0, 15, 0);
        add(new THREE.CylinderGeometry(T * 0.55, T * 0.55, 46, 6), pm.soft, 0, 23, 0);
        const torus = add(new THREE.TorusGeometry(T * 0.8, 3, 8, 24), pm.body, 0, 40, 0);
        torus.rotation.x = Math.PI / 2;
        break;
      }
      case 'rax':
        add(new THREE.BoxGeometry(T * 1.9, 26, T * 1.5), pm.body, 0, 13, 0);
        add(new THREE.BoxGeometry(T * 0.7, 12, T * 1.6), pm.soft, 0, 30, 0);
        break;
      case 'fact':
        add(new THREE.BoxGeometry(T * 1.9, 22, T * 1.6), pm.body, 0, 11, 0);
        add(new THREE.CylinderGeometry(5, 6, 26, 10), pm.soft, -T * 0.5, 30, -T * 0.3);
        add(new THREE.CylinderGeometry(5, 6, 34, 10), pm.soft, -T * 0.5, 32, T * 0.3);
        break;
      case 'turret': {
        add(new THREE.CylinderGeometry(12, 14, 12, 12), pm.body, 0, 6, 0);
        add(new THREE.SphereGeometry(8, 12, 10), pm.soft, 0, 15, 0);
        const barrel = add(new THREE.CylinderGeometry(2, 2, 22, 8), pm.body, 11, 15, 0);
        barrel.rotation.z = Math.PI / 2;
        break;
      }
    }
    return g;
  }

  // ---- camera ----
  function updateCamera(cam, w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const dist = BASE_DIST / cam.zoom;
    camera.position.set(cam.x, dist * Math.sin(TILT), cam.y + dist * Math.cos(TILT));
    camera.lookAt(cam.x, 0, cam.y);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  function screenToWorld(sx, sy) {
    const w = renderer.domElement.clientWidth || renderer.domElement.width;
    const h = renderer.domElement.clientHeight || renderer.domElement.height;
    ndc.set((sx / w) * 2 - 1, -(sy / h) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.ray.intersectPlane(groundPlane, tmpV);
    if (!hit) return { x: 0, y: 0 };
    return { x: tmpV.x, y: tmpV.z };
  }

  function worldToScreen(wx, wy, wz) {
    const w = renderer.domElement.clientWidth || renderer.domElement.width;
    const h = renderer.domElement.clientHeight || renderer.domElement.height;
    tmpV.set(wx, wz || 0, wy).project(camera);
    return { x: (tmpV.x * 0.5 + 0.5) * w, y: (-tmpV.y * 0.5 + 0.5) * h, behind: tmpV.z > 1 };
  }

  function worldPerPixel() {
    const w = renderer.domElement.clientWidth || 2;
    const h = renderer.domElement.clientHeight || 2;
    const a = screenToWorld(w / 2 - 5, h / 2), ax = a.x, ay = a.y;
    const b = screenToWorld(w / 2 + 5, h / 2);
    return U.dist(ax, ay, b.x, b.y) / 10;
  }

  // ---- per-frame sync + render ----
  // list: filtered drawable ents; projs: [[x,y,kindIdx]]; placing: {kind,tx,ty,valid}|null; sel: Set
  function render(list, projs, placing, sel) {
    if (!scene) return;
    if (fogTex) fogTex.needsUpdate = true;

    const seen = new Set();
    for (const e of list) {
      seen.add(e.id);
      let m = meshes.get(e.id);
      if (m && (m.kind !== e.kind || m.owner !== e.owner)) {
        scene.remove(m.group); meshes.delete(e.id); m = null;
      }
      if (!m) {
        m = { group: buildMesh(e.kind, e.owner), kind: e.kind, owner: e.owner };
        scene.add(m.group);
        meshes.set(e.id, m);
      }
      m.group.position.set(e.x, 0, e.y);
      if (K[e.kind].unit || e.kind === 'turret') m.group.rotation.y = -e.face;
      if (e.kind === 'crystal') {
        const sc = 0.45 + 0.55 * (e.hp / C.CRYSTAL_AMOUNT);
        m.group.scale.set(sc, sc, sc);
      } else if (e.flags & 2) { // constructing: rise out of the ground
        const p = Math.max(0.15, e.prog / 100);
        m.group.scale.y = p;
      } else if (m.group.scale.y !== 1) m.group.scale.y = 1;
    }
    for (const [id, m] of meshes) {
      if (!seen.has(id)) { scene.remove(m.group); meshes.delete(id); }
    }

    // selection rings
    const selList = list.filter((e) => sel.has(e.id));
    while (rings.length < selList.length) {
      const r = new THREE.Mesh(new THREE.RingGeometry(1, 1.18, 28), mats.ringSel);
      r.rotation.x = -Math.PI / 2;
      r.position.y = 1.5;
      scene.add(r);
      rings.push(r);
    }
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      if (i < selList.length) {
        const e = selList[i];
        const k = K[e.kind];
        const rad = k.bld ? Math.max(k.fw, k.fh) * T * 0.72 : (k.r || 10) + 6;
        r.visible = true;
        r.position.x = e.x; r.position.z = e.y;
        r.scale.set(rad, rad, 1);
      } else r.visible = false;
    }

    // projectiles
    while (projPool.length < projs.length) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(3.4, 8, 8), mats.bolt);
      scene.add(m);
      projPool.push(m);
    }
    for (let i = 0; i < projPool.length; i++) {
      const m = projPool[i];
      if (i < projs.length) {
        m.visible = true;
        m.material = projs[i][2] === 1 ? mats.shell : mats.bolt;
        m.position.set(projs[i][0], 16, projs[i][1]);
      } else m.visible = false;
    }

    // placement ghost
    if (placing) {
      const k = K[placing.kind];
      if (!ghost) {
        ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 18, 1), mats.ghostOk);
        scene.add(ghost);
      }
      ghost.visible = true;
      ghost.material = placing.valid ? mats.ghostOk : mats.ghostBad;
      ghost.scale.set(k.fw * T, 1, k.fh * T);
      ghost.position.set((placing.tx + k.fw / 2) * T, 9, (placing.ty + k.fh / 2) * T);
    } else if (ghost) ghost.visible = false;

    renderer.render(scene, camera);
  }

  return { init, setup, updateCamera, screenToWorld, worldToScreen, worldPerPixel, render };
})();
