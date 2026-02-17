/**
 * 3D Viewer
 * Three.js-based renderer for G-code toolpaths.
 * Supports animated playback with speed control.
 * Z-depth color mapping on cut moves.
 */

class GCodeViewer {
  constructor(container) {
    this.container = container;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.toolpathGroup = null;

    // Animation state
    this.segments = [];
    this.playing = false;
    this.playbackSpeed = 1;
    this.currentSegmentIndex = 0;
    this.segmentProgress = 0;
    this.lastFrameTime = 0;
    this.onProgress = null; // callback(current, total)
    this.onPlayStateChange = null; // callback(playing)
    this.onLineChange = null; // callback(lineNumber) for G-code panel

    // Tool position marker
    this.toolMarker = null;

    // Animated line objects
    this.rapidLine = null;
    this.cutLine = null;
    this.rapidPositions = [];
    this.cutPositions = [];
    this.cutColors = [];
    this.rapidDrawCount = 0;
    this.cutDrawCount = 0;

    // Z-depth color range
    this.zMin = 0;
    this.zMax = 0;

    // Saved perspective camera state for toggling
    this._savedCamState = null;
    this._isTopDown = false;

    // Bounds reference for top-down view
    this._lastBounds = null;

    this.init();
  }

  init() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);

    this.camera = new THREE.PerspectiveCamera(
      50,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      100000
    );
    this.camera.position.set(100, 100, 100);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.container.appendChild(this.renderer.domElement);

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.screenSpacePanning = true;

    const grid = new THREE.GridHelper(500, 50, 0x444466, 0x333355);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);

    const axes = new THREE.AxesHelper(50);
    this.scene.add(axes);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));

    this.toolpathGroup = new THREE.Group();
    this.scene.add(this.toolpathGroup);

    // Tool position marker — yellow sphere
    const markerGeom = new THREE.SphereGeometry(1, 12, 12);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0xffdd44 });
    this.toolMarker = new THREE.Mesh(markerGeom, markerMat);
    this.toolMarker.visible = false;
    this.scene.add(this.toolMarker);

    // Sheet outline group
    this.sheetGroup = new THREE.Group();
    this.scene.add(this.sheetGroup);

    window.addEventListener('resize', () => this.onResize());

    this.animate();
  }

  onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  animate() {
    requestAnimationFrame((time) => {
      this.animateFrame(time);
      this.animate();
    });
  }

  animateFrame(time) {
    if (this.playing && this.segments.length > 0) {
      const dt = this.lastFrameTime ? (time - this.lastFrameTime) / 1000 : 0;
      this.lastFrameTime = time;
      this.advancePlayback(dt);
    } else {
      this.lastFrameTime = time;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  advancePlayback(dt) {
    if (this.currentSegmentIndex >= this.segments.length) {
      this.pause();
      return;
    }

    const baseRate = Math.max(this.segments.length / 30, 10);
    const segmentsToAdvance = baseRate * this.playbackSpeed * dt;

    let remaining = segmentsToAdvance;
    let lastLine = -1;

    while (remaining > 0 && this.currentSegmentIndex < this.segments.length) {
      const leftInSegment = 1 - this.segmentProgress;

      if (remaining >= leftInSegment) {
        remaining -= leftInSegment;
        this.segmentProgress = 0;
        const seg = this.segments[this.currentSegmentIndex];
        this.addSegmentToScene(seg);
        lastLine = seg.line;
        this.currentSegmentIndex++;
      } else {
        this.segmentProgress += remaining;
        remaining = 0;
      }
    }

    this.updateToolMarker();
    this.updateDrawRanges();

    // Line change callback for G-code panel
    if (lastLine === -1 && this.currentSegmentIndex < this.segments.length) {
      lastLine = this.segments[this.currentSegmentIndex].line;
    }
    if (this.onLineChange && lastLine > 0) {
      this.onLineChange(lastLine);
    }

    if (this.onProgress) {
      this.onProgress(this.currentSegmentIndex, this.segments.length);
    }

    if (this.currentSegmentIndex >= this.segments.length) {
      this.toolMarker.visible = false;
      this.pause();
    }
  }

  // Map a Z value to an RGB color: green (shallow/0) → yellow → red (deep/negative)
  zDepthColor(z) {
    const range = this.zMax - this.zMin;
    if (range === 0) return { r: 0.27, g: 0.87, b: 0.53 }; // default green

    // t=0 at zMax (surface), t=1 at zMin (deepest)
    const t = Math.max(0, Math.min(1, (this.zMax - z) / range));

    // Green → Yellow → Orange → Red
    let r, g, b;
    if (t < 0.33) {
      const s = t / 0.33;
      r = 0.27 + s * 0.73; g = 0.87; b = 0.53 - s * 0.53;
    } else if (t < 0.66) {
      const s = (t - 0.33) / 0.33;
      r = 1.0; g = 0.87 - s * 0.37; b = 0;
    } else {
      const s = (t - 0.66) / 0.34;
      r = 1.0; g = 0.5 - s * 0.2; b = 0;
    }
    return { r, g, b };
  }

  addSegmentToScene(seg) {
    if (seg.type === 'rapid') {
      const i = this.rapidDrawCount * 6;
      this.rapidPositions[i]     = seg.from.x;
      this.rapidPositions[i + 1] = seg.from.y;
      this.rapidPositions[i + 2] = seg.from.z;
      this.rapidPositions[i + 3] = seg.to.x;
      this.rapidPositions[i + 4] = seg.to.y;
      this.rapidPositions[i + 5] = seg.to.z;
      this.rapidDrawCount++;
      if (this.rapidLine) {
        this.rapidLine.geometry.attributes.position.needsUpdate = true;
        this.rapidLine.geometry.setDrawRange(0, this.rapidDrawCount * 2);
      }
    } else {
      const i = this.cutDrawCount * 6;
      this.cutPositions[i]     = seg.from.x;
      this.cutPositions[i + 1] = seg.from.y;
      this.cutPositions[i + 2] = seg.from.z;
      this.cutPositions[i + 3] = seg.to.x;
      this.cutPositions[i + 4] = seg.to.y;
      this.cutPositions[i + 5] = seg.to.z;

      // Z-depth vertex colors (color both from and to vertices)
      const cFrom = this.zDepthColor(seg.from.z);
      const cTo = this.zDepthColor(seg.to.z);
      this.cutColors[i]     = cFrom.r;
      this.cutColors[i + 1] = cFrom.g;
      this.cutColors[i + 2] = cFrom.b;
      this.cutColors[i + 3] = cTo.r;
      this.cutColors[i + 4] = cTo.g;
      this.cutColors[i + 5] = cTo.b;

      this.cutDrawCount++;
      if (this.cutLine) {
        this.cutLine.geometry.attributes.position.needsUpdate = true;
        this.cutLine.geometry.attributes.color.needsUpdate = true;
        this.cutLine.geometry.setDrawRange(0, this.cutDrawCount * 2);
      }
    }
  }

  updateDrawRanges() {
    if (this.rapidLine) {
      this.rapidLine.geometry.setDrawRange(0, this.rapidDrawCount * 2);
    }
    if (this.cutLine) {
      this.cutLine.geometry.setDrawRange(0, this.cutDrawCount * 2);
    }
  }

  updateToolMarker() {
    if (this.currentSegmentIndex >= this.segments.length) return;

    const seg = this.segments[this.currentSegmentIndex];
    const t = this.segmentProgress;
    this.toolMarker.position.set(
      seg.from.x + (seg.to.x - seg.from.x) * t,
      seg.from.y + (seg.to.y - seg.from.y) * t,
      seg.from.z + (seg.to.z - seg.from.z) * t
    );
    this.toolMarker.visible = true;
  }

  loadToolpath(segments, bounds) {
    this.clearToolpath();
    this.segments = segments;
    this._lastBounds = bounds;

    if (!segments.length) return;

    // Z range for depth coloring
    this.zMin = bounds.min.z;
    this.zMax = bounds.max.z;

    let rapidCount = 0, cutCount = 0;
    for (const seg of segments) {
      if (seg.type === 'rapid') rapidCount++;
      else cutCount++;
    }

    this.rapidPositions = new Float32Array(rapidCount * 6);
    this.cutPositions = new Float32Array(cutCount * 6);
    this.cutColors = new Float32Array(cutCount * 6);
    this.rapidDrawCount = 0;
    this.cutDrawCount = 0;

    // Rapid lines — blue, no vertex colors
    if (rapidCount > 0) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(this.rapidPositions, 3));
      geom.setDrawRange(0, 0);
      const mat = new THREE.LineBasicMaterial({
        color: 0x4488ff,
        transparent: true,
        opacity: 0.4
      });
      this.rapidLine = new THREE.LineSegments(geom, mat);
      this.toolpathGroup.add(this.rapidLine);
    }

    // Cut lines — vertex-colored by Z depth
    if (cutCount > 0) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(this.cutPositions, 3));
      geom.setAttribute('color', new THREE.BufferAttribute(this.cutColors, 3));
      geom.setDrawRange(0, 0);
      const mat = new THREE.LineBasicMaterial({ vertexColors: true });
      this.cutLine = new THREE.LineSegments(geom, mat);
      this.toolpathGroup.add(this.cutLine);
    }

    // Scale tool marker
    const sizeX = bounds.max.x - bounds.min.x;
    const sizeY = bounds.max.y - bounds.min.y;
    const sizeZ = bounds.max.z - bounds.min.z;
    const maxDim = Math.max(sizeX, sizeY, sizeZ, 1);
    const markerScale = maxDim * 0.012;
    this.toolMarker.scale.set(markerScale, markerScale, markerScale);

    this.fitCamera(bounds);
  }

  renderToolpath(segments, bounds) {
    this.loadToolpath(segments, bounds);
    this.showAll();
  }

  showAll() {
    this.pause();
    for (let i = this.currentSegmentIndex; i < this.segments.length; i++) {
      this.addSegmentToScene(this.segments[i]);
    }
    this.currentSegmentIndex = this.segments.length;
    this.segmentProgress = 0;
    this.toolMarker.visible = false;
    this.updateDrawRanges();
    if (this.onProgress) {
      this.onProgress(this.segments.length, this.segments.length);
    }
  }

  play() {
    if (!this.segments.length) return;
    if (this.currentSegmentIndex >= this.segments.length) {
      this.restart();
    }
    this.playing = true;
    this.lastFrameTime = 0;
    if (this.onPlayStateChange) this.onPlayStateChange(true);
  }

  pause() {
    this.playing = false;
    if (this.onPlayStateChange) this.onPlayStateChange(false);
  }

  togglePlay() {
    if (this.playing) this.pause();
    else this.play();
  }

  restart() {
    this.pause();
    this.currentSegmentIndex = 0;
    this.segmentProgress = 0;
    this.rapidDrawCount = 0;
    this.cutDrawCount = 0;
    this.rapidPositions.fill(0);
    this.cutPositions.fill(0);
    this.cutColors.fill(0);
    if (this.rapidLine) {
      this.rapidLine.geometry.attributes.position.needsUpdate = true;
      this.rapidLine.geometry.setDrawRange(0, 0);
    }
    if (this.cutLine) {
      this.cutLine.geometry.attributes.position.needsUpdate = true;
      this.cutLine.geometry.attributes.color.needsUpdate = true;
      this.cutLine.geometry.setDrawRange(0, 0);
    }
    this.toolMarker.visible = false;
    if (this.onProgress) this.onProgress(0, this.segments.length);
  }

  scrubTo(fraction) {
    const targetIndex = Math.floor(fraction * this.segments.length);
    if (targetIndex <= this.currentSegmentIndex) {
      this.restart();
    }
    for (let i = this.currentSegmentIndex; i < targetIndex && i < this.segments.length; i++) {
      this.addSegmentToScene(this.segments[i]);
    }
    this.currentSegmentIndex = targetIndex;
    this.segmentProgress = 0;
    this.updateDrawRanges();
    this.updateToolMarker();
    if (this.onProgress) {
      this.onProgress(this.currentSegmentIndex, this.segments.length);
    }
    // Update G-code panel on scrub
    if (this.onLineChange && targetIndex < this.segments.length) {
      this.onLineChange(this.segments[targetIndex].line);
    }
  }

  setSpeed(speed) {
    this.playbackSpeed = speed;
  }

  // Toggle between 3D perspective and top-down orthographic view
  toggleTopDown() {
    if (this._isTopDown) {
      // Restore perspective view
      if (this._savedCamState) {
        this.camera.position.copy(this._savedCamState.pos);
        this.controls.target.copy(this._savedCamState.target);
        this.camera.up.set(0, 0, 1);
        this.controls.enableRotate = true;
        this.controls.update();
      }
      this._isTopDown = false;
      return false;
    }

    // Save current camera state
    this._savedCamState = {
      pos: this.camera.position.clone(),
      target: this.controls.target.clone()
    };

    const bounds = this._lastBounds;
    if (!bounds) return false;

    const cx = (bounds.min.x + bounds.max.x) / 2;
    const cy = (bounds.min.y + bounds.max.y) / 2;
    const sizeX = bounds.max.x - bounds.min.x;
    const sizeY = bounds.max.y - bounds.min.y;
    const maxDim = Math.max(sizeX, sizeY, 1);

    // Position camera directly above looking down
    const dist = maxDim * 1.2;
    this.camera.position.set(cx, cy, dist);
    this.controls.target.set(cx, cy, 0);
    this.camera.up.set(0, 1, 0);
    this.controls.enableRotate = false; // lock to top-down pan/zoom only
    this.controls.update();

    this._isTopDown = true;
    return true;
  }

  clearToolpath() {
    this.pause();
    while (this.toolpathGroup.children.length) {
      const child = this.toolpathGroup.children[0];
      child.geometry?.dispose();
      child.material?.dispose();
      this.toolpathGroup.remove(child);
    }
    this.segments = [];
    this.rapidLine = null;
    this.cutLine = null;
    this.rapidPositions = [];
    this.cutPositions = [];
    this.cutColors = [];
    this.rapidDrawCount = 0;
    this.cutDrawCount = 0;
    this.currentSegmentIndex = 0;
    this.segmentProgress = 0;
    this.toolMarker.visible = false;
    this._isTopDown = false;
    this._savedCamState = null;
  }

  fitCamera(bounds) {
    const centerX = (bounds.min.x + bounds.max.x) / 2;
    const centerY = (bounds.min.y + bounds.max.y) / 2;
    const centerZ = (bounds.min.z + bounds.max.z) / 2;

    const sizeX = bounds.max.x - bounds.min.x;
    const sizeY = bounds.max.y - bounds.min.y;
    const sizeZ = bounds.max.z - bounds.min.z;
    const maxDim = Math.max(sizeX, sizeY, sizeZ, 1);

    // Update grid
    const gridSize = Math.ceil(maxDim * 1.5 / 10) * 10;
    this.scene.children.forEach(child => {
      if (child instanceof THREE.GridHelper) {
        this.scene.remove(child);
      }
    });
    const grid = new THREE.GridHelper(gridSize, Math.min(gridSize / 10, 50), 0x444466, 0x333355);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(centerX, centerY, 0);
    this.scene.add(grid);

    const dist = maxDim * 1.5;
    this.camera.position.set(centerX + dist * 0.6, centerY - dist * 0.6, centerZ + dist * 0.8);
    this.controls.target.set(centerX, centerY, centerZ);
    this.controls.enableRotate = true;
    this.controls.update();

    this.camera.near = dist * 0.001;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();

    this._isTopDown = false;
  }

  showSheet(sheet) {
    while (this.sheetGroup.children.length) {
      const child = this.sheetGroup.children[0];
      child.geometry?.dispose();
      child.material?.dispose();
      this.sheetGroup.remove(child);
    }

    if (!sheet || !sheet.width || !sheet.length) return;

    const w = sheet.length;
    const h = sheet.width;

    const planeGeom = new THREE.PlaneGeometry(w, h);
    const planeMat = new THREE.MeshBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const plane = new THREE.Mesh(planeGeom, planeMat);
    plane.position.set(w / 2, h / 2, 0);
    this.sheetGroup.add(plane);

    const pts = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(w, 0, 0),
      new THREE.Vector3(w, h, 0),
      new THREE.Vector3(0, h, 0),
      new THREE.Vector3(0, 0, 0)
    ];
    const lineGeom = new THREE.BufferGeometry().setFromPoints(pts);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.5
    });
    const outline = new THREE.Line(lineGeom, lineMat);
    this.sheetGroup.add(outline);

    const tickSize = Math.max(w, h) * 0.015;
    const tickPts = [
      new THREE.Vector3(0, -tickSize, 0), new THREE.Vector3(0, tickSize, 0),
      new THREE.Vector3(w, -tickSize, 0), new THREE.Vector3(w, tickSize, 0),
      new THREE.Vector3(-tickSize, 0, 0), new THREE.Vector3(tickSize, 0, 0),
      new THREE.Vector3(-tickSize, h, 0), new THREE.Vector3(tickSize, h, 0)
    ];
    const tickGeom = new THREE.BufferGeometry().setFromPoints(tickPts);
    const tickMat = new THREE.LineBasicMaterial({ color: 0x4488ff, opacity: 0.4, transparent: true });
    const ticks = new THREE.LineSegments(tickGeom, tickMat);
    this.sheetGroup.add(ticks);
  }

  resetView() {
    if (this.toolpathGroup.children.length) {
      const box = new THREE.Box3().setFromObject(this.toolpathGroup);
      this.fitCamera({
        min: { x: box.min.x, y: box.min.y, z: box.min.z },
        max: { x: box.max.x, y: box.max.y, z: box.max.z }
      });
    }
  }
}
