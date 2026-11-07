import { memo, useMemo } from 'react';
import { VOXEL_MODELS } from '../voxel/models.ts';
import { capacityFor, useInstances, type InstanceSpec } from './instancing.ts';
import { voxelGeometry, voxelMaterial } from './materials.ts';
import type { Placement } from './place.ts';
import type { ModelName } from './props.ts';

const MODEL_NAMES = Object.keys(VOXEL_MODELS) as ModelName[];

function ModelInstances({ model, specs, shadows }: { model: ModelName; specs: InstanceSpec[]; shadows: boolean }) {
  const capacity = capacityFor(specs.length);
  const ref = useInstances(specs, capacity);
  return (
    <instancedMesh
      key={capacity}
      ref={ref}
      args={[voxelGeometry(model), voxelMaterial, capacity]}
      castShadow={shadows}
      receiveShadow={shadows}
    />
  );
}

/**
 * Every voxel prop in the building: one InstancedMesh per model type across all suites and the hub
 * (spec §9), so props cost at most one draw call per model type.
 */
export const VoxelInstances = memo(function VoxelInstances({ placements, shadows }: { placements: Placement[]; shadows: boolean }) {
  const byModel = useMemo(() => {
    const m = new Map<ModelName, InstanceSpec[]>(MODEL_NAMES.map((n) => [n, []]));
    for (const p of placements) {
      m.get(p.model)!.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, sx: p.scale[0], sy: p.scale[1], sz: p.scale[2], color: p.tint });
    }
    return m;
  }, [placements]);
  return (
    <>
      {MODEL_NAMES.map((n) => (
        <ModelInstances key={n} model={n} specs={byModel.get(n)!} shadows={shadows} />
      ))}
    </>
  );
});
