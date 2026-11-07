import { BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, MeshBasicMaterial, MeshLambertMaterial, NearestFilter, PlaneGeometry, RingGeometry, SRGBColorSpace } from 'three';
import { meshVoxels } from '../voxel/mesh.ts';
import { VOXEL_MODELS } from '../voxel/models.ts';
import type { Ctx2D } from '../screens/pixel-font.ts';
import type { ModelName } from './props.ts';

/**
 * Shared geometries and materials (spec §9: shared materials, one geometry per voxel model). They are
 * module singletons: React Three Fiber never disposes objects passed through `args`/props, and three.js
 * re-uploads them to a new WebGL context when the canvas is recreated (quality change).
 */

let voxelGeoms: Map<ModelName, BufferGeometry> | null = null;

/** Meshed once per model type; re-centred on x/z with the base at y = 0 (props.ts convention). */
export function voxelGeometry(name: ModelName): BufferGeometry {
  voxelGeoms ??= new Map();
  let g = voxelGeoms.get(name);
  if (!g) {
    const m = meshVoxels(VOXEL_MODELS[name]);
    g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new BufferAttribute(m.normals, 3));
    g.setAttribute('color', new BufferAttribute(m.colors, 3));
    g.setIndex(new BufferAttribute(m.indices, 1));
    const [sx, , sz] = VOXEL_MODELS[name].size;
    g.translate((-sx * 0.25) / 2, 0, (-sz * 0.25) / 2);
    g.computeBoundingSphere();
    voxelGeoms.set(name, g);
  }
  return g;
}

/** Flat per-face shading is baked into the vertex colours, so a Lambert material keeps the voxel look cheap. */
export const voxelMaterial = new MeshLambertMaterial({ vertexColors: true });

/** Unit cube centred on the origin (walls, glass, frames: positioned/scaled per instance). */
export const unitBox = new BoxGeometry(1, 1, 1);
/** Unit floor quad in the xz plane, facing up. */
export const unitFloor = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
/** Status ring on the floor, facing up. */
export const ringGeometry = new RingGeometry(0.34, 0.46, 24).rotateX(-Math.PI / 2);

export const solidMaterial = new MeshLambertMaterial();
export const frameMaterial = new MeshLambertMaterial();
/** Unlit so status colours read the same under any light. */
export const ringMaterial = new MeshBasicMaterial({ toneMapped: false });
export const lightMaterial = new MeshBasicMaterial({ toneMapped: false });

/** Floor with a faint 1 m tile grid computed from world position (works across instances, no texture). */
export const floorMaterial = new MeshLambertMaterial();
floorMaterial.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vGridPos;')
    .replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      vec4 gridWorld = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        gridWorld = instanceMatrix * gridWorld;
      #endif
      vGridPos = (modelMatrix * gridWorld).xz;`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vGridPos;')
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      vec2 gridCell = abs(fract(vGridPos) - 0.5);
      vec2 gridW = fwidth(vGridPos) * 1.2;
      float gridLine = max(smoothstep(0.5 - gridW.x - 0.012, 0.5 - 0.012, gridCell.x), smoothstep(0.5 - gridW.y - 0.012, 0.5 - 0.012, gridCell.y));
      diffuseColor.rgb *= 1.0 - 0.18 * gridLine;`,
    );
};
floorMaterial.customProgramCacheKey = () => 'office-floor-grid';

const glassCache = new Map<string, MeshLambertMaterial>();
/** Glass: transparent at Medium/High, an opaque blue-grey tint at Low (`opacity === null`). */
export function glassMaterial(opacity: number | null): MeshLambertMaterial {
  const key = String(opacity);
  let m = glassCache.get(key);
  if (!m) {
    m =
      opacity === null
        ? new MeshLambertMaterial({ color: new Color('#4b6584') })
        : new MeshLambertMaterial({ color: new Color('#a5d8ff'), transparent: true, opacity, depthWrite: false });
    glassCache.set(key, m);
  }
  return m;
}

/** An in-memory canvas + pixel-art texture (CSP: never blob: URLs). */
export function pixelCanvasTexture(w: number, h: number): { canvas: HTMLCanvasElement; ctx: Ctx2D; texture: CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = SRGBColorSpace;
  // The painters only set string fill colours, so the 2D context satisfies the narrow Ctx2D shape.
  return { canvas, ctx: ctx as unknown as Ctx2D, texture };
}
