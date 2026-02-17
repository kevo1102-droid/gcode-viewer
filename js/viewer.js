/**
 * 3D Viewer
 * Three.js-based renderer for G-code toolpaths.
 * Supports animated playback with speed control.
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
    this.playbackSpeed = 1; // multiplier: 0.25x to 10x
    this.currentSegmentIndex = 0;
    this.segmentProgress = 0; // 0-1 within current segment
    this.lastFrameTime = 0;
    this.onProgress = null; // callback(current, total)
    this.onPlayStateChange = null; // callback(playing)

    // Tool position marker
    this.toolMarker = null;

    // Animated line objects
    this.rapidLine = null;
    this.cutLine = null;
    this.rapidPositions = [];
    this.cutPositions = [];
    this.rapidDrawCount = 0;
    this.cutDrawCount = 0;

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
    // Advance playback
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

    // Speed: segments per second. Base rate scales with total segment count
    // so a 500-segment file and a 50000-segment file both take reasonable time
    const baseRate = Math.max(this.segments.length / 30, 10);
    const segmentsToAdvance = baseRate * this.playbackSpeed * dt;

    let remaining = segmentsToAdvance;

    while (remaining > 0 && this.currentSegmentIndex < this.segments.length) {
      const leftInSegment = 1 - this.segmentProgress;

      if (remaining >= leftInSegment) {
        // Complete this segment
        remaining -= leftInSegment;
        this.segmentProgress = 0;
        this.addSegmentToScene(this.segments[this.currentSegmentIndex]);
        this.currentSegmentIndex++;
      } else {
        // Partial segment — update tool marker position
        this.segmentProgress += remaining;
        remaining = 0;
      }
    }

    // Update tool marker
    this.updateToolMarker();

    // Update draw ranges
    this.updateDrawRanges();

    // Progress callback
    if (this.onProgress) {
      this.onProgress(this.currentSegmentIndex, this.segments.length);
    }

    if (this.currentSegmentIndex >= this.segments.length) {
      this.toolMarker.visible = false;
      this.pause();
    }
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
      this.cutDrawCount++;
      if (this.cutLine) {
        this.cutLine.geometry.attributes.position.needsUpdate = true;
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

  // Set up segments for animated playback
  loadToolpath(segments, bounds) {
    this.clearToolpath();
    this.segments = segments;

    if (!segments.length) return;

    // Count rapids and cuts to pre-allocate buffers
    let rapidCount = 0, cutCount = 0;
    for (const seg of segments) {
      if (seg.type === 'rapid') rapidCount++;
      else cutCount++;
    }

    // Pre-allocate position arrays (6 floats per segment: from xyz + to xyz)
    this.rapidPositions = new Float32Array(rapidCount * 6);
    this.cutPositions = new Float32Array(cutCount * 6);
    this.rapidDrawCount = 0;
    this.cutDrawCount = 0;

    // Create line objects with empty draw range
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

    if (cutCount > 0) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(this.cutPositions, 3));
      geom.setDrawRange(0, 0);
      const mat = new THREE.LineBasicMaterial({ color: 0x44dd88 });
      this.cutLine = new THREE.LineSegments(geom, mat);
      this.toolpathGroup.add(this.cutLine);
    }

    // Scale tool marker to workpiece size
    const sizeX = bounds.max.x - bounds.min.x;
    const sizeY = bounds.max.y - bounds.min.y;
    const sizeZ = bounds.max.z - bounds.min.z;
    const maxDim = Math.max(sizeX, sizeY, sizeZ, 1);
    const markerScale = maxDim * 0.012;
    this.toolMarker.scale.set(markerScale, markerScale, markerScale);

    this.fitCamera(bounds);
  }

  // Render all segments instantly (no animation)
  renderToolpath(segments, bounds) {
    this.loadToolpath(segments, bounds);
    this.showAll();
  }

  // Jump to showing all segments
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
    // If at end, restart
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
    // Zero out position arrays
    this.rapidPositions.fill(0);
    this.cutPositions.fill(0);
    if (this.rapidLine) {
      this.rapidLine.geometry.attributes.position.needsUpdate = true;
      this.rapidLine.geometry.setDrawRange(0, 0);
    }
    if (this.cutLine) {
      this.cutLine.geometry.attributes.position.needsUpdate = true;
      this.cutLine.geometry.setDrawRange(0, 0);
    }
    this.toolMarker.visible = false;
    if (this.onProgress) this.onProgress(0, this.segments.length);
  }

  // Scrub to a specific position (0-1)
  scrubTo(fraction) {
    const targetIndex = Math.floor(fraction * this.segments.length);
    if (targetIndex <= this.currentSegmentIndex) {
      // Need to restart and rebuild up to target
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
  }

  setSpeed(speed) {
    this.playbackSpeed = speed;
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
    this.rapidDrawCount = 0;
    this.cutDrawCount = 0;
    this.currentSegmentIndex = 0;
    this.segmentProgress = 0;
    this.toolMarker.visible = false;
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
    this.controls.update();

    this.camera.near = dist * 0.001;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
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
