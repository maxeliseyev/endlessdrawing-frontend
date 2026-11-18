import { backingSize, intersects, visibleBounds, type Viewport } from '../camera';
import { strokeExtent, type Extent, type Stroke, type StrokeDraft } from '../model';
import type { FrameInput, SceneRenderer } from '../scene-renderer';
import { TILE_SIZE } from '../tiles';
import { packMesh, STROKE_COLUMNS } from './batch';
import { splitFloat } from './float';
import { prepareStroke, type PreparedStroke } from './stroke';
import {
  planView, strokeDepth, tileOrigin, tilePlacement, tileUpdates,
  MIN_CACHED_TILES, TILE_BUDGET_MS, type TileCoord, type ViewPlan, type ZoomClock,
} from './tile-plan';
const QUAD = new Float32Array([
  -1, -1, 1, -1, -1, 1,
  1, -1, 1, 1, -1, 1,
]);

/** One stroke in a coverage pass. Depth 0 is NDC z = -1, the near clip plane. */
const COVERAGE_DEPTH = 0.75;

const PROJECT = `
vec2 sub2(vec2 a, vec2 b) {
  float hi = a.x - b.x;
  float lo = (a.y - b.y) + ((a.x - hi) - b.x);
  float z = hi + lo;
  return vec2(z, lo - (z - hi));
}
vec2 add1(vec2 a, float b) {
  float hi = a.x + b;
  float lo = a.y + ((a.x - hi) + b);
  float z = hi + lo;
  return vec2(z, lo - (z - hi));
}
uniform vec4 u_cam;
uniform vec2 u_css;
uniform vec2 u_backing;
uniform float u_scale;
uniform highp sampler2D u_strokes;
uniform int u_count;
uniform int u_useUniform;
uniform vec4 u_origin;
uniform vec4 u_color;
uniform float u_depth;
vec2 project(vec2 local, vec4 origin) {
  vec2 dx = add1(sub2(origin.xy, u_cam.xy), local.x);
  vec2 dy = add1(sub2(origin.zw, u_cam.zw), local.y);
  float x = dx.x * u_scale + dx.y * u_scale + u_css.x;
  float y = dy.x * u_scale + dy.y * u_scale + u_css.y;
  return vec2(x / u_backing.x * 2.0 - 1.0, 1.0 - y / u_backing.y * 2.0);
}
void fetchStroke(int index, out vec4 origin, out vec4 color, out float depth) {
  if (u_useUniform == 1) {
    origin = u_origin;
    color = u_color;
    depth = u_depth;
    return;
  }
  int col = index % ${STROKE_COLUMNS};
  int row = index / ${STROKE_COLUMNS};
  origin = texelFetch(u_strokes, ivec2(col * 2, row), 0);
  color = texelFetch(u_strokes, ivec2(col * 2 + 1, row), 0);
  depth = 0.5 + 0.5 * (1.0 - (float(index) + 1.0) / (float(u_count) + 1.0));
}
`;

const MESH_VS = `#version 300 es
precision highp float;
${PROJECT}
in vec2 a_local;
in float a_index;
flat out vec4 v_color;
void main() {
  vec4 origin, color;
  float depth;
  fetchStroke(int(a_index + 0.5), origin, color, depth);
  v_color = color;
  gl_Position = vec4(project(a_local, origin), depth * 2.0 - 1.0, 1.0);
}
`;

const MESH_FS = `#version 300 es
precision highp float;
flat in vec4 v_color;
uniform int u_opaquePass;
out vec4 fragColor;
void main() {
  vec3 rgb = floor(v_color.rgb * 255.0 + 0.5) / 255.0;
  float alpha = u_opaquePass == 1 ? 1.0 : v_color.a;
  fragColor = vec4(rgb * alpha, alpha);
}
`;

const CIRCLE_VS = `#version 300 es
precision highp float;
${PROJECT}
in vec2 a_corner;
in vec4 a_circle;
uniform float u_pad;
flat out vec4 v_color;
flat out float v_radius;
out vec2 v_delta;
void main() {
  vec4 origin, color;
  float depth;
  fetchStroke(int(a_circle.w + 0.5), origin, color, depth);
  v_color = color;
  v_radius = a_circle.z;
  float reach = a_circle.z + u_pad;
  v_delta = a_corner * reach;
  gl_Position = vec4(project(a_circle.xy + v_delta, origin), depth * 2.0 - 1.0, 1.0);
}
`;

const CIRCLE_FS = `#version 300 es
precision highp float;
flat in vec4 v_color;
flat in float v_radius;
in vec2 v_delta;
uniform int u_opaquePass;
out vec4 fragColor;
void main() {
  float dist = length(v_delta);
  float coverage = clamp((v_radius - dist) / max(fwidth(dist), 1e-4) + 0.5, 0.0, 1.0);
  vec3 rgb = floor(v_color.rgb * 255.0 + 0.5) / 255.0;
  float alpha = coverage * (u_opaquePass == 1 ? 1.0 : v_color.a);
  fragColor = vec4(rgb * alpha, alpha);
}
`;

const COMPOSITE_VS = `#version 300 es
in vec2 a_clip;
out vec2 v_uv;
void main() {
  v_uv = a_clip * 0.5 + 0.5;
  gl_Position = vec4(a_clip, 0.0, 1.0);
}
`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_cover;
uniform float u_opacity;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec4 texel = texture(u_cover, v_uv);
  float alpha = texel.a * u_opacity;
  fragColor = vec4(texel.rgb * u_opacity, alpha);
}
`;

const PLACE_VS = `#version 300 es
in vec2 a_clip;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_clip, 0.0, 1.0);
}
`;

interface Uniforms {
  cam: WebGLUniformLocation | null;
  css: WebGLUniformLocation | null;
  backing: WebGLUniformLocation | null;
  scale: WebGLUniformLocation | null;
  pad: WebGLUniformLocation | null;
  strokes: WebGLUniformLocation | null;
  count: WebGLUniformLocation | null;
  useUniform: WebGLUniformLocation | null;
  opaquePass: WebGLUniformLocation | null;
  origin: WebGLUniformLocation | null;
  color: WebGLUniformLocation | null;
  depth: WebGLUniformLocation | null;
  cover: WebGLUniformLocation | null;
  opacity: WebGLUniformLocation | null;
}

interface Shader {
  program: WebGLProgram;
  loc: Uniforms;
}

interface CachedStroke extends PreparedStroke {
  extent: Extent;
  originV: Float32Array;
  colorV: Float32Array;
  triBuffer: WebGLBuffer | null;
  triCount: number;
  circleBuffer: WebGLBuffer | null;
  circleCount: number;
}

interface GpuTarget {
  texture: WebGLTexture;
  depth: WebGLRenderbuffer;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
}

interface GpuTile {
  key: string;
  scale: number;
  tx: number;
  ty: number;
  bounds: TileCoord['bounds'];
  maxSeq: number;
  adds: CachedStroke[];
  dirty: boolean;
  used: number;
  texture: WebGLTexture;
  depth: WebGLRenderbuffer;
  fbo: WebGLFramebuffer;
}

interface OverlayDraw {
  opacity: number;
  depth: number;
  origin: Float32Array;
  color: Float32Array;
  triFirst: number;
  triCount: number;
  circleFirst: number;
  circleCount: number;
}

interface Pass {
  uniform: boolean;
  opaquePass: boolean;
  origin: Float32Array;
  color: Float32Array;
  depth: number;
}

type GLCanvas = HTMLCanvasElement & { __gl?: WebGL2RenderingContext };

export function createWebGLSceneRenderer(canvas: HTMLCanvasElement, input: FrameInput): WebGLSceneRenderer | undefined {
  if (typeof WebGL2RenderingContext === 'undefined') return undefined;
  let gl: WebGL2RenderingContext | null;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      depth: true,
      stencil: false,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
  } catch {
    return undefined;
  }
  if (!gl) return undefined;
  return new WebGLSceneRenderer(canvas, gl, input);
}

export class WebGLSceneRenderer implements SceneRenderer {
  readonly kind = 'webgl';
  private readonly cache = new Map<string, CachedStroke>();
  private ordered: CachedStroke[] = [];
  private readonly gpuTiles = new Map<string, GpuTile>();
  private lost = false;
  private disposed = false;
  private direct = false;
  private frame: number | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private dpr = 1;
  private scale = 1;
  private pad = 1;
  private tileFrame = 0;
  private zoomClock: ZoomClock = { zoom: undefined, zoomedAt: -Infinity };
  private readonly cam = new Float32Array(4);
  private readonly css = new Float32Array(2);
  private readonly backing = new Float32Array(2);
  private readonly placeData = new Float32Array(24);
  private mesh!: Shader;
  private circle!: Shader;
  private blit!: Shader;
  private place!: Shader;
  private quadBuffer: WebGLBuffer | null = null;
  private placeBuffer: WebGLBuffer | null = null;
  private overlayTris: WebGLBuffer | null = null;
  private overlayCircles: WebGLBuffer | null = null;
  private screenCover: GpuTarget | null = null;
  private tileCover: GpuTarget | null = null;
  /** Bound while a stroke shader runs, so the pass never samples its own target. */
  private idleTexture: WebGLTexture | null = null;
  private destFbo: WebGLFramebuffer | null = null;
  private destW = 0;
  private destH = 0;
  private overlayKey = '';
  private overlayDraws: OverlayDraw[] = [];
  private readonly pass: Pass = {
    uniform: false,
    opaquePass: false,
    origin: new Float32Array(4),
    color: new Float32Array(4),
    depth: 0,
  };

  constructor(
    private readonly canvas: GLCanvas,
    private readonly gl: WebGL2RenderingContext,
    private readonly input: FrameInput,
  ) {
    canvas.__gl = gl;
    canvas.dataset.renderer = 'webgl';
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.initResources();
  }

  added(stroke: Stroke): void {
    const prepared = prepareStroke(stroke, stroke.seq);
    const cached: CachedStroke = {
      ...prepared,
      extent: strokeExtent(stroke),
      originV: new Float32Array(prepared.origin),
      colorV: new Float32Array(prepared.color),
      triBuffer: null, triCount: 0, circleBuffer: null, circleCount: 0,
    };
    if (!this.lost) this.upload(cached);
    this.cache.set(stroke.id, cached);
    this.insert(cached);
    this.retouch(cached, false);
  }

  removed(stroke: Stroke): void {
    const cached = this.cache.get(stroke.id);
    if (!cached) return;
    this.retouch(cached, true);
    this.cache.delete(stroke.id);
    const index = this.ordered.indexOf(cached);
    if (index >= 0) this.ordered.splice(index, 1);
    if (!this.lost) {
      this.gl.deleteBuffer(cached.triBuffer);
      this.gl.deleteBuffer(cached.circleBuffer);
    }
  }

  resize(viewport: Viewport, dpr: number): void {
    this.dpr = dpr;
    const size = backingSize(viewport, dpr);
    if (this.canvas.width !== size.width || this.canvas.height !== size.height) {
      this.canvas.width = size.width;
      this.canvas.height = size.height;
      this.dropCoverage(this.screenCover);
      this.screenCover = null;
    }
    this.invalidate();
  }

  invalidate(): void {
    if (this.disposed || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.paint();
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    clearTimeout(this.settleTimer);
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (!this.lost) {
      this.releaseAllTiles();
      this.gl.deleteTexture(this.idleTexture);
    }
  }

  private readonly onLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
  };

  private readonly onRestored = (): void => {
    this.lost = false;
    this.direct = false;
    this.gpuTiles.clear();
    this.screenCover = null;
    this.tileCover = null;
    this.initResources();
    for (const stroke of this.cache.values()) {
      stroke.triBuffer = null;
      stroke.circleBuffer = null;
      this.upload(stroke);
    }
    this.invalidate();
  };

  private initResources(): void {
    const gl = this.gl;
    this.mesh = link(gl, MESH_VS, MESH_FS, ['a_local', 'a_index']);
    this.circle = link(gl, CIRCLE_VS, CIRCLE_FS, ['a_corner', 'a_circle']);
    this.blit = link(gl, COMPOSITE_VS, COMPOSITE_FS, ['a_clip']);
    this.place = link(gl, PLACE_VS, COMPOSITE_FS, ['a_clip', 'a_uv']);
    this.quadBuffer = gl.createBuffer();
    this.placeBuffer = gl.createBuffer();
    this.overlayTris = gl.createBuffer();
    this.overlayCircles = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    this.idleTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.idleTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.overlayKey = '';
  }

  private paint(): void {
    if (this.lost || this.disposed) return;
    const { input } = this;
    const viewport = input.viewport();
    const plan = planView(input.camera(), viewport, this.dpr, performance.now(), this.zoomClock);
    this.zoomClock = plan.clock;
    if (this.direct) this.drawScene(plan, viewport);
    else {
      const prepared = this.prepareTiles(plan, viewport);
      if (this.direct) this.drawScene(plan, viewport);
      else {
        this.presentTiles(prepared.tiles, plan);
        this.evict(prepared.cap, prepared.frame, plan.scale);
        clearTimeout(this.settleTimer);
        if (prepared.busy) this.invalidate();
        else if (plan.settleIn !== undefined) {
          this.settleTimer = setTimeout(() => this.invalidate(), plan.settleIn + 1);
        }
      }
    }
    this.drawOverlays(plan, viewport, input.overlays());
    input.painted?.();
  }

  private resetPassState(): void {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
  }

  private drawScene(plan: ViewPlan, viewport: Viewport): void {
    this.bindDest(null, this.canvas.width, this.canvas.height);
    this.resetPassState();
    const gl = this.gl;
    gl.clearColor(1, 1, 1, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.setScreen(plan, viewport);
    const bounds = visibleBounds(plan.snapped, viewport);
    this.drawStrokeList(this.ordered.filter((stroke) => intersects(bounds, stroke.extent)));
  }

  private prepareTiles(plan: ViewPlan, viewport: Viewport): { tiles: GpuTile[]; busy: boolean; cap: number; frame: number } {
    const frame = ++this.tileFrame;
    const started = performance.now();
    const spent = () => performance.now() - started > TILE_BUDGET_MS;
    let busy = false;
    let rendered = 0;
    const tiles: GpuTile[] = [];
    const view = visibleBounds(plan.snapped, viewport);
    const ensure = (coord: TileCoord, countBudget: boolean): GpuTile | undefined => {
      let tile = this.gpuTiles.get(coord.key);
      if (!tile || tile.dirty) {
        if (countBudget && rendered > 0 && spent()) {
          busy = true;
          return tile;
        }
        if (!tile) {
          tile = this.createTile(coord);
          if (!tile) return undefined;
        }
        this.renderTile(tile);
        rendered++;
      } else if (tile.adds.length) this.applyAdds(tile);
      return tile;
    };
    // Older scales only cover holes while the requested tiles are being built.
    // Once the view is ready, every fallback copy would be covered again.
    const complete = plan.needed.every((coord) => this.gpuTiles.get(coord.key)?.dirty === false);
    const fallbacks = complete ? [] : [...this.gpuTiles.values()]
      .filter((tile) => tile.scale !== plan.scale && !tile.dirty && intersects(tile.bounds, view))
      .sort((a, b) => Math.abs(Math.log(b.scale / plan.scale)) - Math.abs(Math.log(a.scale / plan.scale)));
    for (const tile of fallbacks) {
      tile.used = frame;
      tiles.push(tile);
    }
    for (const coord of plan.needed) {
      const tile = ensure(coord, true);
      if (this.direct) return { tiles: [], busy: false, cap: 0, frame };
      if (!tile) continue;
      tile.used = frame;
      tiles.push(tile);
    }
    if (plan.scale === plan.exact) {
      for (const coord of plan.ring) {
        let tile = this.gpuTiles.get(coord.key);
        if ((!tile || tile.dirty) && !busy) {
          if (spent()) busy = true;
          else {
            tile = ensure(coord, false);
            if (this.direct) return { tiles: [], busy: false, cap: 0, frame };
          }
        }
        if (tile) tile.used = frame;
      }
    }
    const cap = Math.max(MIN_CACHED_TILES, Math.ceil(plan.ring.length * 1.2));
    return { tiles, busy, cap, frame };
  }

  private presentTiles(tiles: readonly GpuTile[], plan: ViewPlan): void {
    const gl = this.gl;
    this.bindDest(null, this.canvas.width, this.canvas.height);
    this.resetPassState();
    gl.clearColor(1, 1, 1, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    for (const tile of tiles) {
      const place = tilePlacement(tile.tx, tile.ty, tile.scale, plan.exact, plan.ox, plan.oy);
      if (place.x1 <= place.x0 || place.y1 <= place.y0) continue;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tile.texture);
      this.drawTileQuad(place.x0, place.y0, place.x1, place.y1);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  private drawOverlays(plan: ViewPlan, viewport: Viewport, drafts: readonly StrokeDraft[]): void {
    this.bindDest(null, this.canvas.width, this.canvas.height);
    this.resetPassState();
    this.setScreen(plan, viewport);
    for (const overlay of this.syncOverlays(drafts)) {
      const draw = () => this.drawRange(this.overlayTris, this.overlayCircles, overlay, overlay, overlay.opacity < 1, overlay);
      if (overlay.opacity >= 1) draw();
      else this.cover(draw, overlay.opacity);
    }
  }

  private renderTile(tile: GpuTile): void {
    this.bindDest(tile.fbo, TILE_SIZE, TILE_SIZE);
    this.resetPassState();
    const gl = this.gl;
    gl.clearColor(1, 1, 1, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.setTile(tile);
    const strokes = this.ordered.filter((stroke) => intersects(tile.bounds, stroke.extent));
    this.drawStrokeList(strokes);
    tile.maxSeq = strokes.reduce((max, stroke) => Math.max(max, stroke.seq), 0);
    tile.adds = [];
    tile.dirty = false;
  }

  private applyAdds(tile: GpuTile): void {
    this.bindDest(tile.fbo, TILE_SIZE, TILE_SIZE);
    this.resetPassState();
    this.setTile(tile);
    for (const stroke of tile.adds) this.cover(() => this.drawSolid(stroke, COVERAGE_DEPTH, true), stroke.opacity);
    tile.adds = [];
  }

  private drawStrokeList(strokes: readonly CachedStroke[]): void {
    for (let index = 0; index < strokes.length; index++) {
      const stroke = strokes[index]!;
      if (stroke.opacity < 1) this.cover(() => this.drawSolid(stroke, COVERAGE_DEPTH, true), stroke.opacity);
      else this.drawSolid(stroke, strokeDepth(index, strokes.length), false);
    }
  }

  private drawSolid(stroke: CachedStroke, depth: number, opaquePass: boolean): void {
    this.pass.uniform = true;
    this.pass.opaquePass = opaquePass;
    this.pass.origin = stroke.originV;
    this.pass.color = stroke.colorV;
    this.pass.depth = depth;
    const gl = this.gl;
    if (stroke.triCount > 0) {
      this.bindMesh(stroke.triBuffer);
      gl.drawArrays(gl.TRIANGLES, 0, stroke.triCount);
    }
    if (stroke.circleCount > 0) {
      this.bindCircles(stroke.circleBuffer, 0);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, stroke.circleCount);
    }
  }

  private cover(draw: () => void, opacity: number): void {
    const gl = this.gl;
    const coverage = this.coverageFor(this.destW, this.destH);
    if (!coverage) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, coverage.fbo);
    gl.viewport(0, 0, this.destW, this.destH);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    draw();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.destFbo);
    gl.viewport(0, 0, this.destW, this.destH);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, coverage.texture);
    gl.useProgram(this.blit.program);
    gl.uniform1i(this.blit.loc.cover, 0);
    gl.uniform1f(this.blit.loc.opacity, opacity);
    this.drawUnitQuad();
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  private drawRange(
    triBuffer: WebGLBuffer | null, circleBuffer: WebGLBuffer | null,
    first: { triFirst: number; triCount: number; circleFirst: number; circleCount: number },
    last: { triFirst: number; triCount: number; circleFirst: number; circleCount: number },
    opaquePass: boolean, uniform?: OverlayDraw,
  ): void {
    this.pass.opaquePass = opaquePass;
    this.pass.uniform = uniform !== undefined;
    if (uniform) {
      this.pass.origin = uniform.origin;
      this.pass.color = uniform.color;
      this.pass.depth = uniform.depth;
    }
    const triCount = last.triFirst + last.triCount - first.triFirst;
    if (triCount > 0) {
      this.bindMesh(triBuffer);
      this.gl.drawArrays(this.gl.TRIANGLES, first.triFirst, triCount);
    }
    const circleCount = last.circleFirst + last.circleCount - first.circleFirst;
    if (circleCount > 0) {
      this.bindCircles(circleBuffer, first.circleFirst);
      this.gl.drawArraysInstanced(this.gl.TRIANGLES, 0, 6, circleCount);
    }
  }

  private bindMesh(buffer: WebGLBuffer | null): void {
    const gl = this.gl;
    this.apply(this.mesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    gl.vertexAttribDivisor(1, 0);
  }

  private bindCircles(buffer: WebGLBuffer | null, first: number): void {
    const gl = this.gl;
    this.apply(this.circle);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, first * 16);
    gl.vertexAttribDivisor(1, 1);
  }

  private apply(shader: Shader): void {
    const gl = this.gl;
    const { loc } = shader;
    gl.useProgram(shader.program);
    // Stroke shaders reference u_strokes. Sampling the texture attached to the
    // draw framebuffer is a feedback loop: the pass is discarded and the tile stays clear.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.idleTexture);
    gl.uniform4fv(loc.cam, this.cam);
    gl.uniform2fv(loc.css, this.css);
    gl.uniform2fv(loc.backing, this.backing);
    gl.uniform1f(loc.scale, this.scale);
    gl.uniform1f(loc.pad, this.pad);
    gl.uniform1i(loc.strokes, 0);
    gl.uniform1i(loc.count, Math.max(1, this.ordered.length));
    gl.uniform1i(loc.useUniform, this.pass.uniform ? 1 : 0);
    gl.uniform1i(loc.opaquePass, this.pass.opaquePass ? 1 : 0);
    if (this.pass.uniform) {
      // Subtract absolute world coordinates in JS float64 before the GPU sees
      // them. Some drivers lose small offsets while subtracting large uniforms.
      const origin = this.pass.origin;
      const [x, xLo] = splitFloat(origin[0]! + origin[1]! - (this.cam[0]! + this.cam[1]!));
      const [y, yLo] = splitFloat(origin[2]! + origin[3]! - (this.cam[2]! + this.cam[3]!));
      gl.uniform4f(loc.cam, 0, 0, 0, 0);
      gl.uniform4f(loc.origin, x, xLo, y, yLo);
      gl.uniform4fv(loc.color, this.pass.color);
      gl.uniform1f(loc.depth, this.pass.depth);
    }
  }

  private setScreen(plan: ViewPlan, viewport: Viewport): void {
    this.setProjection(
      plan.snapped.x, plan.snapped.y,
      viewport.width / 2 * this.dpr, viewport.height / 2 * this.dpr,
      this.canvas.width, this.canvas.height, plan.exact,
    );
  }

  private setTile(tile: GpuTile): void {
    const [x, y] = tileOrigin(tile.scale, tile.tx, tile.ty);
    this.setProjection(x, y, 0, 0, TILE_SIZE, TILE_SIZE, tile.scale);
  }

  private setProjection(x: number, y: number, cssX: number, cssY: number, backingW: number, backingH: number, scale: number): void {
    const [cx, cxLo] = splitFloat(x);
    const [cy, cyLo] = splitFloat(y);
    this.cam.set([cx, cxLo, cy, cyLo]);
    this.css[0] = cssX;
    this.css[1] = cssY;
    this.backing[0] = backingW;
    this.backing[1] = backingH;
    this.scale = scale;
    this.pad = 1 / scale;
  }

  private upload(stroke: CachedStroke): void {
    const packed = packMesh([{ triangles: stroke.triangles, circles: stroke.circles, index: 0 }]);
    const gl = this.gl;
    stroke.triBuffer ??= gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, stroke.triBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, packed.triangles, gl.STATIC_DRAW);
    stroke.triCount = packed.ranges[0]?.triCount ?? 0;
    stroke.circleCount = packed.ranges[0]?.circleCount ?? 0;
    if (stroke.circleCount > 0) {
      stroke.circleBuffer ??= gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, stroke.circleBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, packed.circles, gl.STATIC_DRAW);
    }
  }

  private insert(stroke: CachedStroke): void {
    let index = 0;
    while (index < this.ordered.length) {
      const other = this.ordered[index]!;
      if (other.seq > stroke.seq || (other.seq === stroke.seq && other.id > stroke.id)) break;
      index++;
    }
    this.ordered.splice(index, 0, stroke);
  }

  private retouch(stroke: CachedStroke, removed: boolean): void {
    const residents = [...this.gpuTiles.values()].map((tile) => ({
      key: tile.key, bounds: tile.bounds, dirty: tile.dirty, maxSeq: tile.maxSeq, adds: tile.adds.length,
    }));
    for (const update of tileUpdates(residents, stroke.extent, stroke.seq, removed)) {
      const tile = this.gpuTiles.get(update.key);
      if (!tile) continue;
      if (update.spoil) {
        tile.dirty = true;
        tile.adds = [];
      } else {
        tile.adds.push(stroke);
        tile.maxSeq = stroke.seq;
      }
    }
  }

  private createTile(coord: TileCoord): GpuTile | undefined {
    const target = this.makeTarget(TILE_SIZE, TILE_SIZE);
    if (!target) return undefined;
    const tile: GpuTile = {
      key: coord.key, scale: coord.scale, tx: coord.tx, ty: coord.ty, bounds: coord.bounds,
      maxSeq: 0, adds: [], dirty: true, used: 0,
      texture: target.texture, depth: target.depth, fbo: target.fbo,
    };
    this.gpuTiles.set(tile.key, tile);
    return tile;
  }

  private bindDest(fbo: WebGLFramebuffer | null, width: number, height: number): void {
    this.destFbo = fbo;
    this.destW = width;
    this.destH = height;
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fbo);
    this.gl.viewport(0, 0, width, height);
  }

  private coverageFor(width: number, height: number): GpuTarget | null {
    const tileSized = width === TILE_SIZE && height === TILE_SIZE;
    const current = tileSized ? this.tileCover : this.screenCover;
    if (current && current.width === width && current.height === height) return current;
    if (tileSized) this.tileCover = null;
    else this.screenCover = null;
    this.dropCoverage(current);
    const created = this.makeTarget(width, height);
    if (!created) return null;
    if (tileSized) this.tileCover = created;
    else this.screenCover = created;
    return created;
  }

  private makeTarget(width: number, height: number): GpuTarget | null {
    const gl = this.gl;
    const texture = gl.createTexture();
    const depth = gl.createRenderbuffer();
    const fbo = gl.createFramebuffer();
    if (!texture || !depth || !fbo) {
      if (texture) gl.deleteTexture(texture);
      if (depth) gl.deleteRenderbuffer(depth);
      if (fbo) gl.deleteFramebuffer(fbo);
      this.failTiles();
      return null;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(texture);
      gl.deleteRenderbuffer(depth);
      gl.deleteFramebuffer(fbo);
      this.failTiles();
      return null;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { texture, depth, fbo, width, height };
  }

  private drawUnitQuad(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawTileQuad(x0: number, y0: number, x1: number, y1: number): void {
    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const left = x0 / width * 2 - 1;
    const right = x1 / width * 2 - 1;
    const top = 1 - y0 / height * 2;
    const bottom = 1 - y1 / height * 2;
    const data = this.placeData;
    const write = (offset: number, x: number, y: number, u: number, v: number) => {
      data[offset] = x; data[offset + 1] = y; data[offset + 2] = u; data[offset + 3] = v;
    };
    write(0, left, top, 0, 1);
    write(4, right, top, 1, 1);
    write(8, left, bottom, 0, 0);
    write(12, right, top, 1, 1);
    write(16, right, bottom, 1, 0);
    write(20, left, bottom, 0, 0);
    gl.useProgram(this.place.program);
    gl.uniform1i(this.place.loc.cover, 0);
    gl.uniform1f(this.place.loc.opacity, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.placeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.vertexAttribDivisor(1, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private evict(cap: number, frame: number, scale: number): void {
    for (const tile of [...this.gpuTiles.values()]) {
      if (tile.dirty && tile.used !== frame) this.releaseTile(tile);
    }
    if (this.gpuTiles.size <= cap) return;
    const order = [...this.gpuTiles.values()]
      .filter((tile) => !(tile.used === frame && tile.scale === scale))
      .sort((a, b) => a.used - b.used);
    for (const tile of order) {
      if (this.gpuTiles.size <= cap) break;
      this.releaseTile(tile);
    }
  }

  private releaseTile(tile: GpuTile): void {
    this.gpuTiles.delete(tile.key);
    if (this.lost) return;
    this.gl.deleteTexture(tile.texture);
    this.gl.deleteRenderbuffer(tile.depth);
    this.gl.deleteFramebuffer(tile.fbo);
  }

  private releaseAllTiles(): void {
    for (const tile of [...this.gpuTiles.values()]) this.releaseTile(tile);
    this.dropCoverage(this.screenCover);
    this.dropCoverage(this.tileCover);
    this.screenCover = null;
    this.tileCover = null;
  }

  private dropCoverage(target: GpuTarget | null): void {
    if (!target || this.lost) return;
    this.gl.deleteTexture(target.texture);
    this.gl.deleteRenderbuffer(target.depth);
    this.gl.deleteFramebuffer(target.fbo);
  }

  private failTiles(): void {
    if (this.direct) return;
    this.direct = true;
    this.releaseAllTiles();
  }

  private syncOverlays(drafts: readonly StrokeDraft[]): readonly OverlayDraw[] {
    const key = drafts.map(signature).join(';');
    if (key === this.overlayKey) return this.overlayDraws;
    this.overlayKey = key;
    const prepared = drafts.map((draft) => prepareStroke(draft));
    const packed = packMesh(prepared.map((stroke) => ({
      triangles: stroke.triangles, circles: stroke.circles, index: 0,
    })));
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayTris);
    gl.bufferData(gl.ARRAY_BUFFER, packed.triangles, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayCircles);
    gl.bufferData(gl.ARRAY_BUFFER, packed.circles, gl.DYNAMIC_DRAW);
    this.overlayDraws = prepared.map((stroke, index) => ({
      opacity: stroke.opacity,
      depth: 0.4 - index * 0.001,
      origin: new Float32Array(stroke.origin),
      color: new Float32Array(stroke.color),
      ...packed.ranges[index]!,
    }));
    return this.overlayDraws;
  }
}

function signature(stroke: StrokeDraft): string {
  const last = stroke.points.at(-1);
  return `${stroke.id}|${stroke.points.length}|${last?.[0] ?? ''}|${last?.[1] ?? ''}|${stroke.width}|${stroke.brush}|${stroke.color}|${stroke.opacity}`;
}

const UNIFORMS = ['cam', 'css', 'backing', 'scale', 'pad', 'strokes', 'count', 'useUniform', 'opaquePass', 'origin', 'color', 'depth', 'cover', 'opacity'] as const;

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string, attributes: readonly string[]): Shader {
  const program = gl.createProgram();
  if (!program) throw new Error('WebGL program allocation failed');
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  attributes.forEach((name, index) => gl.bindAttribLocation(program, index, name));
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '';
    gl.deleteProgram(program);
    throw new Error(log || 'WebGL program link failed');
  }
  const loc = {} as Uniforms;
  for (const name of UNIFORMS) loc[name] = gl.getUniformLocation(program, `u_${name}`);
  return { program, loc };
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL shader allocation failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    throw new Error(log || 'WebGL shader compile failed');
  }
  return shader;
}
