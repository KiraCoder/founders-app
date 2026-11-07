"use client";

import dynamic from "next/dynamic";

/**
 * The org board (drag-and-drop editor, @dnd-kit) as its own chunk: pages that link to the org
 * chart without showing it (the company page's other tabs) no longer ship it in their first
 * load. Still rendered on the server, so the board's HTML arrives at once.
 */
export const OrgBoardLazy = dynamic(() => import("./OrgBoard").then((m) => m.OrgBoard), {
  loading: () => <div className="card h-64 bg-sunk" aria-busy="true" />,
});
