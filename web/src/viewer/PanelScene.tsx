import { Grid, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { PerspectiveCamera, Vector3, type Mesh } from "three";
import type { Seam, Spec, Step, Vec3 } from "../types";
import type { Segment, SegmentState } from "./seamState";

/** Millimetres to scene units (metres). */
const S = 0.001;
/** Seam lines sit this far off the web face and plate so they are not buried in the geometry. */
const LIFT_MM = 5;

export const COLORS = {
  plate: "#c8cdd3",
  stiffener: "#aeb5bd",
  fillet: "#1f5fa8",
  joint: "#4a4f55",
  // Must stay readable against the plate: this is "still to weld", not "absent".
  pending: "#2f3944",
  done: "#1f5fa8",
  active: "#e8590c",
  faulted: "#c92a2a",
  skipped: "#c92a2a",
  highlight: "#111418",
};

type Props = {
  spec: Spec;
  seams: Seam[];
  /** Per-seam progress. Without it, seams are coloured by kind. */
  segments?: Map<string, Segment[]>;
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
      <mesh ref={ref} position={p0} renderOrder={12}>
        <sphereGeometry args={[0.045, 20, 20]} />
        <meshBasicMaterial color={COLORS.active} depthTest={false} transparent opacity={0.95} />
      </mesh>
    </>
  );
}

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const STYLE: Record<SegmentState, { color: string; width: number; onTop: boolean }> = {
  pending: { color: COLORS.pending, width: 1.25, onTop: false },
  done: { color: COLORS.done, width: 3, onTop: false },
  active: { color: COLORS.active, width: 4.5, onTop: true },
  faulted: { color: COLORS.faulted, width: 4.5, onTop: true },
  skipped: { color: COLORS.skipped, width: 2, onTop: false },
};

function Panel({ spec, seams, segments, highlight, highlightParts, showJoints = true, torch, onHover, onSelect }: Props) {
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
        .flatMap((seam) => {
          const [a, b] = offsetSeam(seam);
          const hl = highlight === seam.id;
          const handlers = {
            onPointerOver: onHover ? (e: { stopPropagation(): void }) => (e.stopPropagation(), onHover(seam.id)) : undefined,
            onPointerOut: onHover ? () => onHover(null) : undefined,
            onClick: onSelect ? (e: { stopPropagation(): void }) => (e.stopPropagation(), onSelect(seam.id)) : undefined,
          };
          const segs = segments?.get(seam.id);
          if (!segs) {
            return [
              <Line
                key={seam.id}
                points={[toScene(spec, a), toScene(spec, b)]}
                color={hl ? COLORS.highlight : seam.kind === "fillet" ? COLORS.fillet : COLORS.joint}
                lineWidth={hl ? 4.5 : 2.5}
                depthTest={!hl}
                renderOrder={hl ? 10 : 1}
                {...handlers}
              />,
            ];
          }
          return segs.map((seg, i) => {
            const st = STYLE[seg.state];
            const onTop = hl || st.onTop;
            return (
              <Line
                key={`${seam.id}:${i}`}
                points={[toScene(spec, lerp(a, b, seg.from)), toScene(spec, lerp(a, b, seg.to))]}
                color={hl ? COLORS.highlight : st.color}
                lineWidth={hl ? Math.max(st.width, 3.5) : st.width}
                depthTest={!onTop}
                renderOrder={onTop ? 10 : 1}
                dashed={seg.state === "skipped"}
                dashSize={0.05}
                gapSize={0.03}
                {...handlers}
              />
            );
          });
        })}
      {torch && <Torch spec={spec} torch={torch} />}
    </group>
  );
}

const VIEW_DIR = new Vector3(0.26, 0.52, 0.82).normalize();

/**
 * Place the camera so the whole plate fits the viewer, using the viewer's real aspect
 * ratio. Runs on load and on resize only, so it never fights the user's orbiting.
 */
function FitCamera({ length, width }: { length: number; width: number }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const controls = useThree((s) => s.controls) as { target: Vector3; update(): void } | null;
  useEffect(() => {
    // Perspective makes the near corners loom larger than a centre-based estimate allows,
    // so project the plate's corners and scale the distance until they all sit in frame.
    const corners = [-1, 1].flatMap((x) => [-1, 1].flatMap((z) => [0, 0.2].map((y) => new Vector3((x * length) / 2, y, (z * width) / 2))));
    const fill = 0.9;
    let dist = Math.max(length, width);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    for (let i = 0; i < 8; i++) {
      camera.position.copy(VIEW_DIR).multiplyScalar(dist);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      const reach = Math.max(...corners.map((c) => {
        const p = c.clone().project(camera);
        return Math.max(Math.abs(p.x), Math.abs(p.y));
      }));
      dist *= Math.pow(reach / fill, 0.9);
    }
    camera.position.copy(VIEW_DIR).multiplyScalar(dist);
    camera.lookAt(0, 0, 0);
    if (controls) {
      controls.target.set(0, 0, 0);
      controls.update();
    }
  }, [camera, aspect, length, width, controls]);
  return null;
}

export function PanelScene(props: Props) {
  const span = Math.max(props.spec.plate.length_mm, props.spec.plate.width_mm) * S;
  return (
    <Canvas
      style={{ position: "absolute", inset: 0 }}
      camera={{ position: [span * 0.26, span * 0.52, span * 0.82], fov: 38, near: 0.01, far: 200 }}
      dpr={[1, 2]}
      raycaster={{ params: { Line: { threshold: 0.02 } } as never }}
    >
      <color attach="background" args={["#f4f5f7"]} />
      <ambientLight intensity={0.9} />
      <directionalLight position={[4, 8, 5]} intensity={1.6} />
      <directionalLight position={[-6, 4, -4]} intensity={0.5} />
      <FitCamera length={props.spec.plate.length_mm * S} width={props.spec.plate.width_mm * S} />
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
