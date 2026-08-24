"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

// The level a JSON tree node is rendered at (react-json-view-lite's own
// shouldExpandNode callback) is 0-indexed, so this store's level uses the
// same convention: level 0 means nothing is expanded ("collapse all"), and
// a node at depth N is expanded when N < level.
const MIN_LEVEL = 0;
const MAX_LEVEL = 64; // deep enough for any real request/response payload

interface JsonTreeExpandState {
  /** Current global expand depth, shared by every JSON tree box on the page. */
  level: number;
  collapseAll: () => void;
  collapseOneLevel: () => void;
  expandOneLevel: () => void;
  expandAll: () => void;
}

const useJsonTreeExpandStore = create<JsonTreeExpandState>()(
  persist(
    (set) => ({
      level: 2,
      collapseAll: () => set({ level: MIN_LEVEL }),
      collapseOneLevel: () => set((s) => ({ level: Math.max(MIN_LEVEL, s.level - 1) })),
      expandOneLevel: () => set((s) => ({ level: Math.min(MAX_LEVEL, s.level + 1) })),
      expandAll: () => set({ level: MAX_LEVEL }),
    }),
    {
      name: "omniroute-json-tree-expand-level",
    }
  )
);

export default useJsonTreeExpandStore;
