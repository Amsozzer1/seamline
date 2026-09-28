import { Grid, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Mesh } from "three";
import type { Seam, Spec, Step, Vec3 } from "../types";

/** Millimetres to scene units (metres). */
const S = 0.001;
/** Seam lines sit this far off the web face and plate so they are not buried in the geometry. */
const LIFT_MM = 5;

export type SeamState = "pending" | "active" | "done" | "skipped" | "plain";

export const COLORS = {
  plate: "#c8cdd3",
  stiffener: "#aeb5bd",
  fillet: "#1f5fa8",
  joint: "#4a4f55",
  pending: "#c2c8cf",
  done: "#1f5fa8",
  active: "#e8590c",
  skipped: "#c92a2a",
  highlight: "#111418",
};

type Props = {
  spec: Spec;
  seams: Seam[];
  state?: Map<string, SeamState>;
  highlight?: string | null;
  highlightParts?: Set<string>;
  showJoints?: boolean;
  torch?: { step: Step; seam: Seam; startedAt: number; durationMs: number } | null;
  onHover?: (seamId: string | null) => void;
  onSelect?: (seamId: string) => void;
};

/** Convert panel coordinates (x along length, y across width, z up) to scene space centred on the plate. */
function toScene(spec: Spec, p: Vec3): [number, number, number] {
  return [(p[0] - spec.plate.length_mm / 2) * S, p[2] * S, (p[1] - spec.plate.width_mm / 2) * S];
}

/** Push a seam off the geometry: away from the web it runs along, and up off the plate. */
function offsetSeam(seam: Seam): [Vec3, Vec3] {
  const along = [seam.end[0] - seam.start[0], seam.end[1] - seam.start[1]];
  const sign = seam.side === "A" ? -1 : 1;
  let dx = 0;
  let dy = 0;
  if (seam.kind === "fillet") {
    if (Math.abs(along[0]) > Math.abs(along[1])) dy = sign * LIFT_MM;
    else dx = sign * LIFT_MM;
  } else {
    // Joint ids end in S/N (which piece end) + A/B (which face of the transverse).
    dx = sign * LIFT_MM;
    dy = seam.id.at(-2) === "S" ? -LIFT_MM : LIFT_MM;
  }
  const lift = seam.kind === "fillet" ? LIFT_MM : 0;
  return [
    [seam.start[0] + dx, seam.start[1] + dy, seam.start[2] + lift],
    [seam.end[0] + dx, seam.end[1] + dy, seam.end[2] + lift],
  ];
}

function portionEnds(step: Step, a: Vec3, b: Vec3): [Vec3, Vec3] {
  const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const [from, to]: [Vec3, Vec3] =
    step.portion === "first_half" ? [a, mid] : step.portion === "second_half" ? [mid, b] : [a, b];
  return step.direction === "reverse" ? [to, from] : [from, to];
}

function Torch({ spec, torch }: { spec: Spec; torch: NonNullable<Props["torch"]> }) {
  const ref = useRef<Mesh>(null);
  const [a, b] = offsetSeam(torch.seam);
  const [from, to] = torch.step.kind === "tack" ? [a, a] : portionEnds(torch.step, a, b);
  const p0 = toScene(spec, from);
  const p1 = toScene(spec, to);
  useFrame(() => {
    if (!ref.current) return;
    const t = Math.min(1, Math.max(0, (Date.now() - torch.startedAt) / torch.durationMs));
    ref.current.position.set(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t);
    const pulse = 1 + 0.25 * Math.sin(Date.now() / 60);
    ref.current.scale.setScalar(pulse);
  });
  return (
    <>
      {torch.step.kind === "weld" && (
        <Line points={[p0, p1]} color={COLORS.active} lineWidth={5} depthTest={false} renderOrder={11} />
      )}
      <mesh ref={ref} position={p0} renderOrder={12}>
        <sphereGeometry args={[0.045, 20, 20]} />
        <meshBasicMaterial color={COLORS.active} depthTest={false} transparent opacity={0.95} />
      </mesh>
    </>
  );
}

function colorFor(seam: Seam, state: SeamState | undefined) {
  switch (state) {
    case "active":
      return COLORS.active;
    case "done":
      return COLORS.done;
    case "skipped":
      return COLORS.skipped;
    case "pending":
      return COLORS.pending;
    default:
      return seam.kind === "fillet" ? COLORS.fillet : COLORS.joint;
  }
}

function Panel({ spec, seams, state, highlight, highlightParts, showJoints = true, torch, onHover, onSelect }: Props) {
  const { plate } = spec;
  const stiffeners = useMemo(
    () =>
      spec.stiffeners.map((s) => {
        const longitudinal = Math.abs(s.end[0] - s.start[0]) > Math.abs(s.end[1] - s.start[1]);
        const len = Math.hypot(s.end[0] - s.start[0], s.end[1] - s.start[1]);
        const mid: Vec3 = [(s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2, s.height_mm / 2];
        const size: [number, number, number] = longitudinal
          ? [len * S, s.height_mm * S, s.thickness_mm * S]
          : [s.thickness_mm * S, s.height_mm * S, len * S];
        return { id: s.id, pos: toScene(spec, mid), size };
      }),
    [spec],
  );

  return (
    <group>
      <mesh position={[0, (-plate.thickness_mm / 2) * S, 0]} receiveShadow>
        <boxGeometry args={[plate.length_mm * S, plate.thickness_mm * S, plate.width_mm * S]} />
        <meshStandardMaterial color={COLORS.plate} metalness={0.35} roughness={0.55} />
      </mesh>
      {stiffeners.map((s) => (
        <mesh key={s.id} position={s.pos} castShadow>
          <boxGeometry args={s.size} />
          <meshStandardMaterial
            color={highlightParts?.has(s.id) ? "#e03131" : COLORS.stiffener}
            metalness={0.35}
            roughness={0.5}
          />
        </mesh>
      ))}
      {seams
        .filter((s) => showJoints || s.kind === "fillet")
        .map((seam) => {
          const st = state?.get(seam.id);
          const [a, b] = offsetSeam(seam);
          const hl = highlight === seam.id;
          const emphasised = hl || st === "active";
          return (
            <Line
              key={seam.id}
              points={[toScene(spec, a), toScene(spec, b)]}
              color={hl ? COLORS.highlight : colorFor(seam, st)}
              lineWidth={emphasised ? 4.5 : st === "pending" ? 1.5 : 2.5}
              depthTest={!emphasised}
              renderOrder={emphasised ? 10 : 1}
              dashed={st === "skipped"}
              dashSize={0.05}
              gapSize={0.03}
              onPointerOver={onHover ? (e) => (e.stopPropagation(), onHover(seam.id)) : undefined}
              onPointerOut={onHover ? () => onHover(null) : undefined}
              onClick={onSelect ? (e) => (e.stopPropagation(), onSelect(seam.id)) : undefined}
            />
          );
        })}
      {torch && <Torch spec={spec} torch={torch} />}
    </group>
  );
}

export function PanelScene(props: Props) {
  const span = Math.max(props.spec.plate.length_mm, props.spec.plate.width_mm) * S;
  return (
    <Canvas
      className="scene"
      camera={{ position: [span * 0.26, span * 0.52, span * 0.82], fov: 38, near: 0.01, far: 200 }}
      dpr={[1, 2]}
      raycaster={{ params: { Line: { threshold: 0.02 } } as never }}
    >
      <color attach="background" args={["#f4f5f7"]} />
      <ambientLight intensity={0.9} />
      <directionalLight position={[4, 8, 5]} intensity={1.6} />
      <directionalLight position={[-6, 4, -4]} intensity={0.5} />
      <Panel {...props} />
      <Grid
        position={[0, -(props.spec.plate.thickness_mm * S) - 0.002, 0]}
        args={[40, 40]}
        cellSize={0.5}
        cellThickness={0.5}
        cellColor="#dde1e6"
        sectionSize={2.5}
        sectionThickness={0.8}
        sectionColor="#c5cbd2"
        fadeDistance={30}
        infiniteGrid
      />
      <OrbitControls makeDefault enableDamping maxPolarAngle={Math.PI / 2.05} />
    </Canvas>
  );
}
