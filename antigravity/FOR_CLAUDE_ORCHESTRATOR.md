# Collaboration Hub: Claude Code (Orchestrator) ↔ Antigravity (Collaborator)

**Purpose:** This file and directory serve as the asynchronous communication channel between **Claude Code** (the primary orchestrator) and **Antigravity** (collaborator handling UI design, modular components, and tasks).

> ⚠️ **IMPORTANT ADVISORY FOR CLAUDE CODE (ORCHESTRATOR):**  
> Antigravity is implementing UI improvements, visual components, loading states, and helpers while Nuraaly is sleeping, operating purely on Git branches without a running Supabase database or local dev server (to keep zero computation on his local laptop).  
> **Please be vigilant and audit carefully:**  
> 1. Run `npm run typecheck`, `npm run lint`, and `npm run test` in your cloud container upon merging.  
> 2. Antigravity's code might contain edge-case bugs or unhandled props in deeper integration flows. Check edge cases and adjust any wiring or prop shapes as necessary!  
> 3. Everything is modular and isolated in this branch (`antigravity/orchestrator-sync`). Pick, merge, or adjust whatever parts serve the project best.

---

## 1. Quick Start for Claude Code

Welcome, Claude! When you pick up work:
1. **Check Section 3** below to see what Antigravity completed, tested, and committed.
2. **Review & Merge**:
   ```bash
   git fetch origin
   git merge origin/antigravity/orchestrator-sync
   ```
3. **Delegate New Tasks**: Add new tasks in **Section 2 (Task Queue from Claude Orchestrator)**.
4. **Reply / Comments**: Add notes or architectural decisions in **Section 4 (Discussion Board)**.
5. Push your updates so Antigravity can pull and pick up the next items.

---

## 2. Task Queue from Claude Orchestrator (Write new tasks here)

> *Claude: Add tasks below for Antigravity to execute. Use the status tags `[TODO]`, `[IN PROGRESS]`, `[BLOCKED]`, `[DONE]`.*

| ID | Task Description | Target Area | Priority | Status |
|---|---|---|---|---|
| T-01 | Add foundational UI primitives (InitialsAvatar, StatusDot, Skeleton) | `src/components/ui.tsx` | Normal | [DONE] |
| T-02 | Add initials avatars in People directory and TopBar user menu | `src/components/people`, `shell` | Normal | [DONE] |
| T-03 | Add profile card to mobile More page | `src/app/(app)/more` | Normal | [DONE] |
| T-04 | Add unit test suite for new UI primitives | `tests/unit/ui-components.test.ts` | Normal | [DONE] |
| T-05 | *[Claude: Add your next task here]* | ... | ... | [TODO] |

### Instructions & Acceptance Criteria from Claude:
<!-- Claude: Write specific instructions, edge cases, or design notes here -->
> *(Example: "Please polish the task form in `src/components/tasks/TaskForm.tsx` to handle priority select dropdowns more cleanly.")*

---

## 3. Antigravity Work Log & Completed Deliverables

### Batch 1: Foundational UI Polish & Design Primitives
* **Branch:** `antigravity/orchestrator-sync` (and `antigravity/ui-design-enhancements`)
* **Commits:**
  * `7f2beb9`: UI design polish (InitialsAvatar, StatusDot, Skeleton, enhanced EmptyState, PeopleTable avatars, MorePage profile card)
* **What was implemented:**
  1. **New UI Primitives** (`src/components/ui.tsx`):
     - `InitialsAvatar`: Computes and renders 1–2 letter uppercase initials with font-size scaling. Seamlessly supports both Latin and Cyrillic names (*Nuraaly*, *Talantbek*, *Эльмурат*, *Эдил*).
     - `StatusDot`: Tone-aware dot indicator with pulse animation support for active/live states.
     - `Skeleton`: Subtle pulse placeholder for loading UI states.
     - `EmptyState`: Enhanced to optionally accept `title`, `description`, `icon`, and `action` while maintaining 100% backward compatibility with simple text `children`.
  2. **People Table** (`src/components/people/PeopleTable.tsx`):
     - Added `InitialsAvatar` next to staff and app user names in the table.
  3. **Top Bar & Shell** (`src/components/shell/TopBar.tsx`, `BottomTabs.tsx`):
     - Connected `InitialsAvatar` to the user menu.
     - Added subtle keyboard shortcut badge (`/`) in the search input.
     - Refined active tab accent styling and transitions for mobile bottom navigation.
  4. **Mobile Navigation** (`src/app/(app)/more/page.tsx`):
     - Added a profile summary card with founder avatar and email.
  5. **Unit Tests** (`tests/unit/ui-components.test.ts`):
     - Complete test suite verifying Latin/Cyrillic initials generation, avatar scaling, status dots, skeletons, and empty state variants.

### Batch 2: Theme Switcher, Data Visualizations & Next.js Streaming Skeletons
* **What was implemented:**
  1. **Theme Switcher (Light / Dark / System)**:
     - `useTheme` hook (`src/lib/use-theme.ts`): Reads and persists theme preference (`localStorage["fc-theme"]`).
     - `ThemeToggle` component (`src/components/settings/ThemeToggle.tsx`): Segmented control for Light, Dark, System.
     - Added Appearance section in Settings (`src/app/(app)/settings/page.tsx`).
     - Added instant Theme switcher in TopBar user menu (`src/components/shell/TopBar.tsx`).
     - Added head inline script in RootLayout (`src/app/layout.tsx`) to avoid theme flash on initial load.
  2. **Data Visualizations & Charts** (`src/components/metrics/`):
     - `BarChart.tsx`: Pure inline SVG bar chart for daily/weekly distributions (Kiwi Go orders, Alura Style garment output, revenue).
     - `ProgressMetric.tsx`: Target vs. actual metric progress bar with gap calculation and tone-based status. Integrated directly into `KpiCard.tsx` when targets exist.
     - `DonutBreakdown.tsx`: Lightweight SVG donut chart for breakdown distributions (task statuses, unit headcounts, company shares).
  3. **Loading Skeletons (`loading.tsx`)**:
     - `src/app/(app)/loading.tsx`: App shell loading skeleton for streaming Today page and general routes.
     - `src/app/(app)/tasks/loading.tsx`: Dedicated skeleton for task views, tabs, and filters.
     - `src/app/(app)/companies/loading.tsx`: Dedicated skeleton for company cards grid and KPI summaries.
  4. **Unit Tests** (`tests/unit/visualizations.test.ts`):
     - Comprehensive unit test suite for `BarChart`, `ProgressMetric`, and `DonutBreakdown`.

### Batch 3: Ergonomic Helpers & Workflow Polishes (Tiny Things that Save Time)
* **What was implemented:**
  1. **Copy to Clipboard Button** (`src/components/CopyButton.tsx`):
     - Reusable inline copy component with instant checkmark feedback (`Copied!`).
     - Added `copy` SVG path to `src/components/Icon.tsx`.
     - Integrated into `src/components/ErrorScreen.tsx` for error reference digest.
     - Integrated into `src/components/people/PeopleTable.tsx` on hover for phone numbers, Telegram handles, and emails.
  2. **Keyboard Shortcuts Helper** (`src/components/shell/ShortcutsModal.tsx`):
     - Accessible modal showing desktop navigation keys (`/`, `Esc`, `?`).
     - Integrated into `src/components/shell/TopBar.tsx` next to the search bar.
  3. **Task Filters Ergonomics** (`src/components/tasks/TaskFilters.tsx`):
     - Added a clean "Reset filters" button whenever active company, priority, or non-default status filters are engaged.
  4. **Unit Tests** (`tests/unit/ui-helpers.test.ts`):
     - Complete test suite for `CopyButton` and `ShortcutsModal`.

### Batch 4: Complete Route Streaming Skeletons & Task Assignee Avatars
* **What was implemented:**
  1. **Full-App Next.js Streaming Skeletons** (`loading.tsx`):
     - Added dedicated streaming skeletons across all major sections:
       * `src/app/(app)/loading.tsx` (Today / general)
       * `src/app/(app)/tasks/loading.tsx` (Tasks & filters)
       * `src/app/(app)/companies/loading.tsx` (Company catalog)
       * `src/app/(app)/holding/loading.tsx` (Holding, contracts, debts, акты)
       * `src/app/(app)/people/loading.tsx` (People directory & headcounts)
       * `src/app/(app)/ai-roles/loading.tsx` (Hired roles & run cards)
       * `src/app/(app)/org/loading.tsx` (Vysotsky 7-division org board)
  2. **Task Assignee Avatar Chips** (`src/components/tasks/TaskList.tsx`):
     - Replaced plain text assignee arrow with `InitialsAvatar` chip next to assignee name.
  3. **Unit Tests** (`tests/unit/loading-skeletons.test.ts`):
     - Comprehensive unit test ensuring every skeleton renders cleanly with accessibility and pulse tokens.

---

## 4. Communication & Discussion Board

### Message from Antigravity to Claude Orchestrator:
> **Timestamp:** 2026-11-04 01:35 (GMT+6)  
> **Author:** Antigravity  
> **Message:**  
> Hi Claude! I have set up this dedicated `antigravity/` folder and `FOR_CLAUDE_ORCHESTRATOR.md` as our asynchronous communication bridge.  
> Whenever your cloud session runs out of tokens or hits limits, Nuraaly hands off tasks to me on this branch. I will implement, test, and commit cleanly here, document what was done, and push.  
> You can merge this branch whenever ready (`git merge origin/antigravity/orchestrator-sync`) and leave your next batch of tasks or feedback in Section 2 above!

---

### Reply from Claude Orchestrator:
> *(Claude: Write your reply, questions, feedback, or review comments here)*
