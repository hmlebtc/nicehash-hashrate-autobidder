// #244 v3: drag-to-reorder for the top-level dashboard blocks, gated
// behind a Rearrange toggle in the header.
//
// v1 used a whole-card title-bar as the drag affordance and rendered
// the card content as pointer-events:none while editing - charts and
// buttons inside the card couldn't be interacted with mid-edit, and
// the title-bar chrome was bulky.
//
// v2 went always-on: a slim 20 px gutter to the LEFT of every card,
// holding a grip handle. The handles were discoverable but the
// permanent gutter ate too much horizontal space (especially on
// mobile) for an affordance the operator uses three times in a
// dashboard's life.
//
// v3 reverts to the gated approach but with the v2 grip-only idiom:
//   - Outside rearrange mode: cards render plain. Zero overhead, no
//     gutter, no handles, no DnD listeners mounted.
//   - Inside rearrange mode: each card grows a temporary left gutter
//     with a prominent amber grip. Drag listeners are bound to the
//     grip button only, so the card body stays interactive (you can
//     still hover charts and read tooltips while reordering).
//
// Persistence + reconciliation against the live block set lives in
// lib/cardOrder.ts; this component is purely the drag surface.

import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { t } from '@lingui/core/macro';

export interface DashboardBlock {
  /** Stable block ID, persisted in the saved order. */
  id: string;
  /** Human-readable, translated label shown on the grip's tooltip / aria. */
  label: string;
  /** The rendered block. */
  node: React.ReactNode;
}

function GripIcon() {
  // Lucide grip-vertical, slightly larger than v2 so it reads as a
  // clear handle in rearrange mode rather than dust in the corner.
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <circle cx="9" cy="5" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="19" r="1" />
      <circle cx="15" cy="5" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="19" r="1" />
    </svg>
  );
}

function SortableItem({ block }: { block: DashboardBlock }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: block.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.9 : 1,
    zIndex: isDragging ? 30 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-stretch gap-2 rounded-lg ${
        isDragging ? 'ring-2 ring-amber-500 shadow-lg shadow-black/40' : ''
      }`}
    >
      {/* Visible-while-editing grip. Amber + subtle glow so the
          affordance is unmistakable. Drag listeners are bound here
          only, so chart pan/zoom and panel buttons stay interactive
          inside the card body while the operator is reordering. */}
      <div className="flex-none w-6 flex justify-center pt-4">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`${t`Drag to reorder`}: ${block.label}`}
          title={`${t`Drag to reorder`}: ${block.label}`}
          className={`p-1 rounded text-amber-300 cursor-grab active:cursor-grabbing touch-none transition drop-shadow-[0_0_4px_rgba(252,211,77,0.35)] hover:bg-slate-800/60 hover:drop-shadow-[0_0_6px_rgba(252,211,77,0.6)] ${
            isDragging ? 'drop-shadow-[0_0_6px_rgba(252,211,77,0.6)]' : ''
          }`}
        >
          <GripIcon />
        </button>
      </div>
      <div className="min-w-0 flex-1">{block.node}</div>
    </div>
  );
}

export function SortableDashboard({
  blocks,
  editing,
  onReorder,
}: {
  blocks: DashboardBlock[];
  editing: boolean;
  onReorder: (ids: string[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 6 px gate so a click near the grip doesn't become a drag.
      activationConstraint: { distance: 6 },
    }),
    useSensor(TouchSensor, {
      // Press-and-hold to start on touch so vertical scrolling isn't
      // hijacked by an accidental long-touch on the grip.
      activationConstraint: { delay: 180, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!editing) {
    // Zero-overhead path: render plain divs, no DnD context, no
    // gutter, no grips. Mirrors v1's idle path.
    return (
      <>
        {blocks.map((b) => (
          <div key={b.id}>{b.node}</div>
        ))}
      </>
    );
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = blocks.map((b) => b.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onReorder(arrayMove(ids, from, to));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={blocks.map((b) => b.id)}
        strategy={verticalListSortingStrategy}
      >
        {blocks.map((b) => (
          <SortableItem key={b.id} block={b} />
        ))}
      </SortableContext>
    </DndContext>
  );
}
