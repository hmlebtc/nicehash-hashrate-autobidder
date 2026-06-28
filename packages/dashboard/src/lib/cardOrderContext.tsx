// #244 v3: shared dashboard card-order state + rearrange-mode flag.
//
// v1 had a Rearrange toggle; v2 went always-on with a left gutter; v3
// brings the toggle back because the always-on gutter cost was too
// high (especially on mobile, where 20 px off every card hurt). The
// grip handles are kept (small icons, easier to find than v1's full
// title-bar) but only shown in rearrange mode, alongside a small
// visual lift on each draggable card.

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useCardOrder, type CardOrderControls } from './cardOrder';

// Built-in top-level dashboard block order. Each ID is a draggable
// unit; a saved order is reconciled against this list, so adding a
// block here is enough to slot it in for everyone and a saved order
// referencing a removed ID degrades cleanly. `proposals` keeps its
// position even when hidden (no last-tick data this cycle).
export const DEFAULT_BLOCK_ORDER = [
  'hero',
  'period',
  'indicators',
  'hashrate',
  'price',
  'pipeline',
  'bids',
  'finance',
  'proposals',
  'bip110',
  'solo',
] as const;

interface CardOrderContextValue extends CardOrderControls {
  /** Whether the dashboard is in drag-to-reorder mode. */
  rearranging: boolean;
  setRearranging: (v: boolean) => void;
}

const CardOrderContext = createContext<CardOrderContextValue | null>(null);

export function CardOrderProvider({ children }: { children: ReactNode }) {
  const controls = useCardOrder(DEFAULT_BLOCK_ORDER);
  const [rearranging, setRearranging] = useState(false);
  const value: CardOrderContextValue = { ...controls, rearranging, setRearranging };
  return (
    <CardOrderContext.Provider value={value}>{children}</CardOrderContext.Provider>
  );
}

export function useCardOrderContext(): CardOrderContextValue {
  const value = useContext(CardOrderContext);
  if (!value) {
    throw new Error('useCardOrderContext must be used within a CardOrderProvider');
  }
  return value;
}
