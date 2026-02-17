/**
 * G-Code Parser
 * Parses G-code into toolpath segments for 3D visualization.
 * Extracts tool info, sheet dimensions, and calculates cycle time.
 * Handles Fanuc-style, LinuxCNC, and Cabinet Vision .anc files.
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
    this.absoluteMode = true;
    this.segments = [];
    this.bounds = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity }
    };
    this.lineCount = 0;
    this.moveCount = 0;
    this._programEnded = false;
    this._lastMoveType = null;

    // Metadata extracted from comments
    this.sheet = { width: null, length: null, thickness: null };
    this.material = null;
    this.jobName = null;
    this.outputDate = null;

    // Tool tracking
    this.tools = {};       // keyed by tool number
    this.currentTool = null;
    this.currentSpindleSpeed = 0;

    // Cycle time tracking
    this.totalCutDist = 0;
    this.totalRapidDist = 0;
    this.feedSegments = []; // { dist, feed } for weighted time calc
    this.rapidRate = 400;   // typical CNC router rapid rate in IPM
    this.toolChangeTime = 8; // seconds per tool change
    this.toolChangeCount = 0;
  }

  parse(gcodeText) {
    this.reset();
    const lines = gcodeText.split('\n');
    this.lineCount = lines.length;

    // First pass: extract metadata from comments
    for (let i = 0; i < lines.length; i++) {
      this.parseComments(lines[i]);
    }

    // Second pass: parse moves
    for (let i = 0; i < lines.length; i++) {
      this.parseLine(lines[i], i + 1);
    }

    this.trimParkMoves();

    return {
      segments: this.segments,
      bounds: this.bounds,
      stats: {
        lineCount: this.lineCount,
        moveCount: this.segments.length,
        bounds: this.bounds
      },
      sheet: this.sheet,
      material: this.material,
      jobName: this.jobName,
      tools: this.tools,
      cycleTime: this.calculateCycleTime()
    };
  }

  parseComments(rawLine) {
    // Extract content inside parentheses
    const comments = [];
    const regex = /\(([^)]*)\)/g;
    let match;
    while ((match = regex.exec(rawLine)) !== null) {
      comments.push(match[1].trim());
    }

    for (const c of comments) {
      // Tool definitions: TOOL:2, OFFSET:2, TNM:2 - 1/2 DOWN SHEER, TD:0.4975
      const toolMatch = c.match(/TOOL\s*:\s*(\d+).*?TNM\s*:\s*\d+\s*-\s*(.+?),\s*TD\s*:\s*([\d.]+)/i);
      if (toolMatch) {
        const num = parseInt(toolMatch[1]);
        this.tools[num] = this.tools[num] || {};
        this.tools[num].number = num;
        this.tools[num].name = toolMatch[2].trim();
        this.tools[num].diameter = parseFloat(toolMatch[3]);
        continue;
      }

      // Sheet dimensions
      const widthMatch = c.match(/Sheet Width.*?:\s*([\d.]+)/i);
      if (widthMatch) { this.sheet.width = parseFloat(widthMatch[1]); continue; }

      const lengthMatch = c.match(/Sheet Length.*?:\s*([\d.]+)/i);
      if (lengthMatch) { this.sheet.length = parseFloat(lengthMatch[1]); continue; }

      const thickMatch = c.match(/Sheet Thickness.*?:\s*([\d.]+)/i);
      if (thickMatch) { this.sheet.thickness = parseFloat(thickMatch[1]); continue; }

      // Material
      const matMatch = c.match(/Material name\s*:\s*(.+)/i);
      if (matMatch) { this.material = matMatch[1].trim(); continue; }

      // Job name
      const jobMatch = c.match(/JOB_NAME\s*:\s*(.+)/i);
      if (jobMatch) { this.jobName = jobMatch[1].trim(); continue; }

      // Output date
      const dateMatch = c.match(/Output ON\s+(.+?)\s+from/i);
      if (dateMatch) { this.outputDate = dateMatch[1].trim(); continue; }
    }
  }

  parseLine(line, lineNumber) {
    if (this._programEnded) return;

    // Strip comments but we already parsed them
    line = line.replace(/;.*$/, '').replace(/\(.*?\)/g, '').trim().toUpperCase();
    if (!line || line.startsWith('%') || line.startsWith('O')) return;

    const words = this.tokenize(line);
    if (!words.length) return;

    let gCodes = [];
    let params = {};

    for (const word of words) {
      const letter = word[0];
      const value = parseFloat(word.substring(1));
      if (letter === 'G') {
        gCodes.push(value);
      } else if (letter === 'N') {
        // Line number
      } else if (letter === 'M') {
        // Handle M codes for tool tracking
        if (value === 6) {
          // Tool change — tool number comes from T param
        } else if (value === 3 || value === 4) {
          // Spindle on — speed from S param
        }
        params[letter] = value;
      } else if (letter === 'T') {
        // Tool change
        const toolNum = Math.floor(value);
        this.currentTool = toolNum;
        this.tools[toolNum] = this.tools[toolNum] || { number: toolNum, name: 'Tool ' + toolNum };
        this.toolChangeCount++;
      } else if (letter === 'S') {
        this.currentSpindleSpeed = value;
        if (this.currentTool && this.tools[this.currentTool]) {
          this.tools[this.currentTool].spindleSpeed = value;
        }
      } else {
        params[letter] = value;
      }
    }

    // Process G codes
    for (const g of gCodes) {
      switch (g) {
        case 90: this.absoluteMode = true; break;
        case 91: this.absoluteMode = false; break;
        case 20: break;
        case 21: break;
        case 28: return;
        case 30: return;
        case 399: return;
        case 40: break;
        case 41: break;
        case 42: break;
        case 43: break;
        case 49: break;
        case 80: break;
        case 17: break;
        case 18: break;
        case 19: break;
        case 54: case 55: case 56: case 57: case 58: case 59: break;
      }
    }

    // Determine move type
    let moveType = null;
    for (const g of gCodes) {
      if (g === 0) moveType = 'rapid';
      else if (g === 1) moveType = 'cut';
      else if (g === 2) moveType = 'cw_arc';
      else if (g === 3) moveType = 'ccw_arc';
    }

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

    if (startX === this.x && startY === this.y && startZ === this.z) return;

    const dist = Math.sqrt(
      (this.x - startX) ** 2 + (this.y - startY) ** 2 + (this.z - startZ) ** 2
    );

    // Track distances for cycle time
    if (type === 'rapid') {
      this.totalRapidDist += dist;
    } else {
      this.totalCutDist += dist;
      this.feedSegments.push({ dist, feed: this.feedRate || 100 });
    }

    this.updateBounds(this.x, this.y, this.z);
    this.moveCount++;

    this.segments.push({
      type: type,
      from: { x: startX, y: startY, z: startZ },
      to: { x: this.x, y: this.y, z: this.z },
      tool: this.currentTool,
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

    const i = params.I ?? 0;
    const j = params.J ?? 0;

    const centerX = startX + i;
    const centerY = startY + j;

    const radius = Math.sqrt(i * i + j * j);
    let startAngle = Math.atan2(startY - centerY, startX - centerX);
    let endAngle = Math.atan2(endY - centerY, endX - centerX);

    const clockwise = (type === 'cw_arc');
    const arcSegments = 32;

    if (clockwise) {
      if (endAngle >= startAngle) endAngle -= 2 * Math.PI;
    } else {
      if (endAngle <= startAngle) endAngle += 2 * Math.PI;
    }

    const angleSpan = endAngle - startAngle;
    const zSpan = endZ - startZ;

    let prevX = startX, prevY = startY, prevZ = startZ;
    let arcDist = 0;

    for (let s = 1; s <= arcSegments; s++) {
      const t = s / arcSegments;
      const angle = startAngle + angleSpan * t;
      const nx = centerX + radius * Math.cos(angle);
      const ny = centerY + radius * Math.sin(angle);
      const nz = startZ + zSpan * t;

      const segDist = Math.sqrt((nx - prevX) ** 2 + (ny - prevY) ** 2 + (nz - prevZ) ** 2);
      arcDist += segDist;

      this.updateBounds(nx, ny, nz);

      this.segments.push({
        type: 'cut',
        from: { x: prevX, y: prevY, z: prevZ },
        to: { x: nx, y: ny, z: nz },
        tool: this.currentTool,
        line: lineNumber
      });

      prevX = nx; prevY = ny; prevZ = nz;
    }

    this.totalCutDist += arcDist;
    this.feedSegments.push({ dist: arcDist, feed: this.feedRate || 100 });

    this.x = endX;
    this.y = endY;
    this.z = endZ;
    this.moveCount++;
  }

  calculateCycleTime() {
    // Rapid time (inches / IPM * 60 = seconds)
    const rapidTimeSec = (this.totalRapidDist / this.rapidRate) * 60;

    // Cut time — weighted by actual feed rates
    let cutTimeSec = 0;
    for (const seg of this.feedSegments) {
      const feed = seg.feed > 0 ? seg.feed : 100;
      cutTimeSec += (seg.dist / feed) * 60;
    }

    // Tool change time
    const tcTime = Math.max(0, this.toolChangeCount - 1) * this.toolChangeTime;

    const totalSec = rapidTimeSec + cutTimeSec + tcTime;

    return {
      rapidTime: rapidTimeSec,
      cutTime: cutTimeSec,
      toolChangeTime: tcTime,
      totalTime: totalSec,
      totalCutDist: this.totalCutDist,
      totalRapidDist: this.totalRapidDist,
      formatted: this.formatTime(totalSec)
    };
  }

  formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    if (m === 0) return s + 's';
    return m + 'm ' + s + 's';
  }

  trimParkMoves() {
    const cutBounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const seg of this.segments) {
      if (seg.type !== 'rapid') {
        cutBounds.minX = Math.min(cutBounds.minX, seg.from.x, seg.to.x);
        cutBounds.maxX = Math.max(cutBounds.maxX, seg.from.x, seg.to.x);
        cutBounds.minY = Math.min(cutBounds.minY, seg.from.y, seg.to.y);
        cutBounds.maxY = Math.max(cutBounds.maxY, seg.from.y, seg.to.y);
      }
    }

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
