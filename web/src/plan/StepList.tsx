import { closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import { portionLabel } from "../core";
import type { Seam, Step } from "../types";

type Props = {
  steps: Step[];
  seams: Map<string, Seam>;
  editable: boolean;
  cursor: number | null;
  highlight: string | null;
  onChange: (steps: Step[]) => void;
  onHover: (seamId: string | null) => void;
};

const stepKey = (s: Step) => `${s.kind}:${s.seam_id}:${s.portion}`;

function Row({ step, index, seam, editable, active, highlighted, onHover }: {
  step: Step;
  index: number;
  seam?: Seam;
  editable: boolean;
  active: boolean;
  highlighted: boolean;
  onHover: (id: string | null) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: stepKey(step), disabled: !editable });
  const arrow = step.direction === "reverse" ? "←" : "→";
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`step${active ? " is-active" : ""}${highlighted ? " is-hl" : ""}${isDragging ? " is-dragging" : ""}`}
      onMouseEnter={() => onHover(step.seam_id)}
      onMouseLeave={() => onHover(null)}
    >
      {editable && (
        <button className="handle" aria-label={`Move step ${index + 1}`} {...attributes} {...listeners}>
          ⋮⋮
        </button>
      )}
      <span className="step-n">{index + 1}</span>
      <span className="mono step-id">{step.seam_id}</span>
      <span className="step-kind">{portionLabel(step)}</span>
      {step.kind === "weld" && <span className="step-dir" title={`direction: ${step.direction}`}>{arrow}</span>}
      <span className="step-len">{seam ? `${Math.round(step.portion === "full" ? seam.length_mm : seam.length_mm / 2)} mm` : ""}</span>
    </li>
  );
}

/**
 * The plan as two phases. Reordering happens within a phase, which keeps every tack
 * ahead of every weld by construction; the Rust check still guards the saved plan.
 */
export function StepList({ steps, seams, editable, cursor, highlight, onChange, onHover }: Props) {
  const [showTacks, setShowTacks] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const firstWeld = steps.findIndex((s) => s.kind === "weld");
  const split = firstWeld < 0 ? steps.length : firstWeld;
  const tacks = steps.slice(0, split);
  const welds = steps.slice(split);

  const onDragEnd = (group: Step[], offset: number) => (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = group.findIndex((s) => stepKey(s) === e.active.id);
    const to = group.findIndex((s) => stepKey(s) === e.over!.id);
    if (from < 0 || to < 0) return;
    const next = [...steps];
    next.splice(offset, group.length, ...arrayMove(group, from, to));
    onChange(next);
  };

  const list = (group: Step[], offset: number) => (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd(group, offset)}>
      <SortableContext items={group.map(stepKey)} strategy={verticalListSortingStrategy}>
        <ol className="steps">
          {group.map((s, i) => (
            <Row
              key={stepKey(s)}
              step={s}
              index={offset + i}
              seam={seams.get(s.seam_id)}
              editable={editable}
              active={cursor === offset + i}
              highlighted={highlight === s.seam_id}
              onHover={onHover}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );

  return (
    <div className="steplist">
      <button className="phase" onClick={() => setShowTacks((v) => !v)} aria-expanded={showTacks}>
        <span>{showTacks ? "▾" : "▸"} Tack</span>
        <span className="muted">{tacks.length} steps</span>
      </button>
      {showTacks && list(tacks, 0)}
      <div className="phase phase-static">
        <span>Weld</span>
        <span className="muted">{welds.length} steps{editable ? ", drag to reorder" : ""}</span>
      </div>
      {list(welds, split)}
    </div>
  );
}
