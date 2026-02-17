/**
 * G-Code Parser
 * Parses G-code into toolpath segments for 3D visualization.
 * Handles Fanuc-style and LinuxCNC dialects.
 */

class GCodeParser {
  constructor() {
    this.reset();
  }

  reset() {
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.feedRate = 0;
    this.absoluteMode = true; // G90 default
    this.segments = [];
    this.bounds = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity }
    };
    this.lineCount = 0;
    this.moveCount = 0;
    this._programEnded = false;
  }

  parse(gcodeText) {
    this.reset();
    const lines = gcodeText.split('\n');
    this.lineCount = lines.length;

    for (let i = 0; i < lines.length; i++) {
      this.parseLine(lines[i], i + 1);
    }

    // Post-process: remove trailing rapids that go far outside the cut envelope
    // (machine park moves at end of CV programs)
    this.trimParkMoves();

    return {
      segments: this.segments,
      bounds: this.bounds,
      stats: {
        lineCount: this.lineCount,
        moveCount: this.segments.length,
        bounds: this.bounds
      }
    };
  }

  parseLine(line, lineNumber) {
    if (this._programEnded) return;

    // Strip comments: anything after ; or inside ()
    line = line.replace(/;.*$/, '').replace(/\(.*?\)/g, '').trim().toUpperCase();
    if (!line || line.startsWith('%') || line.startsWith('O')) return;

    const words = this.tokenize(line);
    if (!words.length) return;

    // Extract G, M codes and parameters
    let gCodes = [];
    let params = {};

    for (const word of words) {
      const letter = word[0];
      const value = parseFloat(word.substring(1));
      if (letter === 'G') {
        gCodes.push(value);
      } else if (letter === 'N') {
        // Line number — skip
      } else {
        params[letter] = value;
      }
    }

    // Process G codes
    for (const g of gCodes) {
      switch (g) {
        case 90: this.absoluteMode = true; break;
        case 91: this.absoluteMode = false; break;
        case 20: break; // Inches
        case 21: break; // Millimeters
        case 28: return; // Machine home — no visible move
        case 30: return; // Program end
        case 399: return; // Custom cycle (CV sweep)
        case 40: break; // Cutter comp cancel
        case 42: break; // Cutter comp right
        case 43: break; // Tool length offset
        case 49: break; // Tool length offset cancel
        case 80: break; // Canned cycle cancel
        case 17: break; // XY plane
        case 18: break; // XZ plane
        case 19: break; // YZ plane
        case 55: break; // Work coordinate system
      }
    }

    // Determine move type from G codes
    let moveType = null;
    for (const g of gCodes) {
      if (g === 0) moveType = 'rapid';
      else if (g === 1) moveType = 'cut';
      else if (g === 2) moveType = 'cw_arc';
      else if (g === 3) moveType = 'ccw_arc';
    }

    // If no explicit G code but has coordinates, treat as linear move (modal behavior)
    if (moveType === null && ('X' in params || 'Y' in params || 'Z' in params)) {
      moveType = this._lastMoveType || 'cut';
    }

    if (moveType) {
      this._lastMoveType = moveType;
      if (moveType === 'cw_arc' || moveType === 'ccw_arc') {
        this.processArc(moveType, params, lineNumber);
      } else {
        this.processLinearMove(moveType, params, lineNumber);
      }
    }

    if ('F' in params) this.feedRate = params.F;

    // M30/M02 = program end — stop parsing to skip park/home moves
    for (const word of words) {
      if (word === 'M30' || word === 'M02') this._programEnded = true;
    }
  }

  tokenize(line) {
    const words = [];
    const regex = /([A-Z])-?[\d.]+/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      words.push(match[0]);
    }
    return words;
  }

  processLinearMove(type, params, lineNumber) {
    const startX = this.x;
    const startY = this.y;
    const startZ = this.z;

    if (this.absoluteMode) {
      if ('X' in params) this.x = params.X;
      if ('Y' in params) this.y = params.Y;
      if ('Z' in params) this.z = params.Z;
    } else {
      if ('X' in params) this.x += params.X;
      if ('Y' in params) this.y += params.Y;
      if ('Z' in params) this.z += params.Z;
    }

    // Skip zero-length moves
    if (startX === this.x && startY === this.y && startZ === this.z) return;

    this.updateBounds(this.x, this.y, this.z);
    this.moveCount++;

    this.segments.push({
      type: type,
      from: { x: startX, y: startY, z: startZ },
      to: { x: this.x, y: this.y, z: this.z },
      line: lineNumber
    });
  }

  processArc(type, params, lineNumber) {
    const startX = this.x;
    const startY = this.y;
    const startZ = this.z;

    const endX = this.absoluteMode ? (params.X ?? this.x) : this.x + (params.X ?? 0);
    const endY = this.absoluteMode ? (params.Y ?? this.y) : this.y + (params.Y ?? 0);
    const endZ = this.absoluteMode ? (params.Z ?? this.z) : this.z + (params.Z ?? 0);

    // I, J, K are always incremental offsets to arc center
    const i = params.I ?? 0;
    const j = params.J ?? 0;

    const centerX = startX + i;
    const centerY = startY + j;

    const radius = Math.sqrt(i * i + j * j);
    let startAngle = Math.atan2(startY - centerY, startX - centerX);
    let endAngle = Math.atan2(endY - centerY, endX - centerX);

    const clockwise = (type === 'cw_arc');

    // Linearize the arc into small line segments
    const arcSegments = 32;

    if (clockwise) {
      if (endAngle >= startAngle) endAngle -= 2 * Math.PI;
    } else {
      if (endAngle <= startAngle) endAngle += 2 * Math.PI;
    }

    const angleSpan = endAngle - startAngle;
    const zSpan = endZ - startZ;

    let prevX = startX, prevY = startY, prevZ = startZ;

    for (let s = 1; s <= arcSegments; s++) {
      const t = s / arcSegments;
      const angle = startAngle + angleSpan * t;
      const nx = centerX + radius * Math.cos(angle);
      const ny = centerY + radius * Math.sin(angle);
      const nz = startZ + zSpan * t;

      this.updateBounds(nx, ny, nz);

      this.segments.push({
        type: 'cut',
        from: { x: prevX, y: prevY, z: prevZ },
        to: { x: nx, y: ny, z: nz },
        line: lineNumber
      });

      prevX = nx; prevY = ny; prevZ = nz;
    }

    this.x = endX;
    this.y = endY;
    this.z = endZ;
    this.moveCount++;
  }

  trimParkMoves() {
    // Compute bounds from cut moves only
    const cutBounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const seg of this.segments) {
      if (seg.type !== 'rapid') {
        cutBounds.minX = Math.min(cutBounds.minX, seg.from.x, seg.to.x);
        cutBounds.maxX = Math.max(cutBounds.maxX, seg.from.x, seg.to.x);
        cutBounds.minY = Math.min(cutBounds.minY, seg.from.y, seg.to.y);
        cutBounds.maxY = Math.max(cutBounds.maxY, seg.from.y, seg.to.y);
      }
    }

    // Remove trailing rapid moves that go outside the cut envelope
    // Use a tight margin — park moves on CNC routers are well beyond the sheet
    const margin = Math.max((cutBounds.maxX - cutBounds.minX) * 0.1, 5);
    while (this.segments.length > 0) {
      const last = this.segments[this.segments.length - 1];
      if (last.type === 'rapid' &&
          (last.to.x > cutBounds.maxX + margin || last.to.x < cutBounds.minX - margin ||
           last.to.y > cutBounds.maxY + margin || last.to.y < cutBounds.minY - margin)) {
        this.segments.pop();
      } else {
        break;
      }
    }

    // Recalculate bounds from remaining segments
    this.bounds = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity }
    };
    for (const seg of this.segments) {
      this.updateBounds(seg.from.x, seg.from.y, seg.from.z);
      this.updateBounds(seg.to.x, seg.to.y, seg.to.z);
    }
  }

  updateBounds(x, y, z) {
    this.bounds.min.x = Math.min(this.bounds.min.x, x);
    this.bounds.min.y = Math.min(this.bounds.min.y, y);
    this.bounds.min.z = Math.min(this.bounds.min.z, z);
    this.bounds.max.x = Math.max(this.bounds.max.x, x);
    this.bounds.max.y = Math.max(this.bounds.max.y, y);
    this.bounds.max.z = Math.max(this.bounds.max.z, z);
  }
}
