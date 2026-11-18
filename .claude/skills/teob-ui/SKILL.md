---
name: teob-ui
description: >
  Design, adapt, synthesize, prototype, promote, audit, and harvest user interfaces across all teob projects
  (teob-ai, memory-console, memory-view, agent-mcr) using the @teob/ui Atomic Design system,
  aiforui.dev skills (emilkowalski/skills), UI Skills (ui-skills.com / npx ui-skills),
  ReUI blocks/MCP, AffectUI/TuffUI/BeautifulUI, 21st.dev, and Dribbble metaphors.
  Enforces a 7-Stage Pipeline: Stage 0 (User Priorities & Scope Triage), Stage 1 (Code & Capability Audit),
  Stage 2 (Pattern Selection + UI Skills & aiforui.dev Craft Loading), Stage 3 (Multi-Variant Live
  Prototyping via <PrototypeSwitcher /> + break-ui), Stage 4 (Promotion), Stage 5 (Live Browser
  Verification, Deduplication, remove-animations & Simplification Pass), and Stage 6 (Atomic Library
  Harvesting — registering any new Token, Atom, Molecule, Organism, or Template into @teob/ui and #/ui).
version: 0.5.0
---

# teob-ui: User-Priority Driven Atomic UI System for `teob`

You design, implement, refine, and harvest user interfaces for `teob` products (`memory-console`, `agent-mcr`, `memory-view`, `memory-site`).
Instead of blindly translating existing code into new styles or forcing complex synthesis everywhere, you always:
1. Start by **identifying the user's real priorities** (what to drop, what to add, what stays on Layer 1 vs. Layer 2/3).
2. Organize and reuse components strictly according to **Atomic Design** (`0. Tokens → 1. Atoms → 2. Molecules → 3. Organisms → 4. Templates`).
3. Orchestrate specialized craft skills from **[`aiforui.dev/skills`](https://aiforui.dev/skills)** and **[`ui-skills.com`](https://www.ui-skills.com/)** at each stage of the pipeline.
4. Choose pragmatically between **direct block adoption** and **macro/micro synthesis**.
5. Perform a **Live Verification, Deduplication & Simplification pass** in the running browser.
6. **Harvest new building blocks back into `@teob/ui`**: whenever a task introduces a new Token, Atom, Molecule, Organism, or Template, extract it into the library (`src/ui/`), export it under its Atomic tier in `src/ui/index.ts`, and add a live interactive demo to `Showcase.tsx` (`#/ui`).

---

## 1. Core Doctrine

### A. User Priorities First (Subtract, Add, or Reframe Before Designing)
Existing code is evidence of what the backend can do, **not** a mandate of what the screen should show:
- **Cut (Subtract)**: Drop redundant widgets, duplicated counters, rarely used filters, or legacy concepts that do not serve the user's top priorities.
- **Add (Elevate)**: Surface missing high-priority signals, quick actions, or cross-links that the user actually needs to do their job faster.
- **Demote (Progressive Disclosure)**: Move secondary configuration, debug data, and raw payloads out of the primary flow into Layer 2/3 windows.

### B. Atomic Design Hierarchy (`@teob/ui`)
Every element in `src/ui/` and `#/ui` (`Showcase.tsx`) belongs to one of five levels:
- **`0. Tokens`**: `tokens.css` (surfaces, semantic pairs, typography scale `--fs-11..24`, spacing, radii, motion curves, and host bridges `--mv-*` / `--sc-*`).
- **`1. Atoms`**: Indivisible primitives (`Button`, `Input`, `Select`, `Textarea`, `Checkbox`, `Badge`, `Avatar`, `Kbd`, `Tooltip`, `Progress`, `Skeleton`, `Icon`, `InlineError`).
- **`2. Molecules`**: Focused combinations of atoms (`Tabs`, `SegmentedControl`, `StatTile`, `Card`, `Combobox`, `Menu`, `FilterMenu`, `Popover`, `Notice`, `Toast`, `CodeBlock`, `DiffView`, `DescList`, `SettingRow`, `Disclosure`, `FormActions`, `State`).
- **`3. Organisms`**: Self-contained composite domain blocks (`PageHeader`, `Section`, `DataTable` + `DetailPanel`, `ApprovalCard`, `Checklist`, `Stepper`, `BarChart`, `Dialog`, `ConfirmDialog`, `RawPayloadModal`).
- **`4. Templates & Harnesses`**: Page-level macro-metaphors (`Split Cockpit`, `Decision Inbox`, `Compact Pulse Strip`) and `<PrototypeSwitcher />`.

### C. Pragmatic Execution: Direct Block Adoption vs. Synthesis
Synthesis is a powerful tool, **not a mandatory ritual**:
1. **Direct Adoption (Default when a proven pattern fits)**: If an existing `@teob/ui` organism/template, ReUI block, AffectUI/TuffUI pattern, or Dribbble macro-metaphor already solves the user's priority cleanly, adapt it directly onto `@teob/ui` tokens without over-engineering.
2. **Dual-Level Synthesis (When no single block fits the domain)**: When a screen bridges multiple workflows, synthesize macro-metaphors and micro-patterns from multiple sources into a new organism or template.

### D. 3-Layer Progressive Disclosure ("Calm Surface, Complete Depth")

| Layer | Name | What Lives Here | Atomic Components |
| :--- | :--- | :--- | :--- |
| **Layer 1** | **Calm Primary Surface** | Only what serves the user's #1 and #2 priorities in <3 seconds: object identity, status/health, the core metaphor, and 1–2 primary actions. | `PageHeader`, `SegmentedControl`, `StatTile`, `DataTable`, `ApprovalCard` |
| **Layer 2** | **Contextual Inspector** | Provenance, "Why" explanations, entity relationships, step details, and targeted mutations. URL-driven (`?entry=`) and dismissible via `Esc`. | `DetailPanel`, `Popover`, `DescList`, `DiffView` |
| **Layer 3** | **Deep Escape Hatch** | Everything secondary or low-level: raw JSON payloads, full system prompts, CLI commands, SQLite/journal internals, granular model/profile settings. | `RawPayloadModal`, `Dialog`, `Disclosure` ("Advanced"), `CodeBlock` |

---

## 2. Skill Orchestration Matrix (`aiforui.dev/skills` + `ui-skills.com`)

At each stage of development, load the matching specialized skill(s) already installed in your environment:

| Pipeline Stage | `aiforui.dev/skills` (Emil Kowalski) | `ui-skills.com` (`npx ui-skills`) & `better-*` | Purpose |
| :--- | :--- | :--- | :--- |
| **Stage 0 & 1: Before You Build** | `animation-vocabulary` (name motion concepts), `/prototype` mindset | `ui-skills-root` (`npx ui-skills start` / `categories`) | Clarify intent, vocabulary, and select the smallest useful skill context. |
| **Stage 2: Building & Crafting** | `emil-design-eng` (invisible polish, optical alignment, restraint), `apple-design` (spatial consistency, depth), `animate`, `choreograph`, `gestures`, `ask-sonner` (toasts), `mobile-native` | `npx ui-skills get <slug>`, `better-layout`, `better-typography`, `better-colors`, `better-ui`, `better-writing`, `transitions-dev` | Ensure high-craft implementation, proper easing/duration curves, and clean layout hierarchy. |
| **Stage 3: Prototyping & Stress-Testing** | `/prototype` (`<PrototypeSwitcher />` variants), `break-ui` (worst-case strings, 0 items, huge counts) | — | Build 2–3 distinct options and try to break them with extreme edge-case data (`?dataset=worst`). |
| **Stage 4 & 5: Live Verification, Deduplication & Simplification** | `remove-animations` (strip unnecessary motion on high-frequency keyboard/data surfaces), `animation-performance` (60fps composite-only check), `improve-animations` | `better-interface`, `better-accessibility`, `transitions-polish` | Audit the live browser view, remove duplicate buttons/facts, strip noisy animations, and verify WCAG 2.2 AA & keyboard flow. |
| **Stage 6: Atomic Library Harvesting** | `emil-design-eng` (API & prop cleanliness) | — | Extract any new Token, Atom, Molecule, Organism, or Template into `@teob/ui` and `#/ui`. |

---

## 3. The 7-Stage Pipeline (Stages 0 → 6)

### Stage 0: User Priorities & Scope Triage (`Prioritize` — MANDATORY FIRST STEP)
Before choosing components or writing UI code, establish the **Priority Contract**:
1. **Rank User Priorities**: Who uses this screen and what are their top 1–3 jobs-to-be-done in order of frequency and urgency?
2. **Cut / Add / Demote Ledger**:
   - **DROP (Refuse/Remove)**: What in the current UI is noise, redundant, or low-value and should be removed completely?
   - **ADD (Missing High-Value)**: What critical signal, shortcut, or status is missing today and must be added to serve the top priority?
   - **KEEP ON LAYER 1 (Primary Surface)**: The 4–5 core elements that stay visible at all times.
   - **DEMOTE TO LAYER 2 / LAYER 3**: What moves into `DetailPanel` (`?entry=`), `Disclosure` ("Advanced"), or `RawPayloadModal` (JSON, CLI, deep config)?
3. *Align with the user on this triage (or state it clearly before prototyping) so you never waste time polishing elements that should be deleted.*

### Stage 1: Code & Capability Audit (`Audit`)
Inspect the existing working code, routes, and API models (`graft ask` / `graft skeleton`) to verify what data and mutations exist to support the **ADD** and **KEEP** items from Stage 0.

### Stage 2: Craft Skill Loading & Pattern Selection (`Select / Synthesize`)
1. **Load Craft Skills**:
   - Load `emil-design-eng` (and `animate` / `choreograph` / `gestures` if interactive motion is involved) from `aiforui.dev/skills`.
   - Select 1–2 narrow craft skills from `ui-skills.com` (`npx ui-skills`) or `better-layout` / `better-typography`.
2. **Choose Direct Adoption or Synthesis**:
   - **Path A — Direct Adoption**: Pick a proven organism/template from `@teob/ui` (`teob-cc/teob-ui`: `src/ui/index.ts`), **ReUI** (`mcp.reui.io` / `reui.io/blocks`), **AffectUI / TuffUI / BeautifulUI**, **21st.dev**, or **Dribbble** and map it onto our tokens.
   - **Path B — Custom Synthesis (When needed)**: Combine blocks/metaphors into a custom recipe when the user's priority requires bridging multiple concepts (and for Pro-only reference components, reverse-engineer their presentation spec onto `@teob/ui` atoms and molecules).

### Stage 3: Multi-Variant Live Prototyping & Stress-Testing (`Prototype` + `break-ui`)
When exploring different ways to serve the user's priorities, build **2–3 distinct variants** wrapped in `<PrototypeSwitcher />` (`src/ui/PrototypeSwitcher.tsx` in `teob-cc/teob-ui`):
- Each variant tests a different **priority trade-off** or **macro-metaphor** (`?proto=a|b|c`).
- Apply the **`break-ui`** skill mindset to populate the `worst` dataset mode (`?dataset=live|empty|error|worst`) with unbreakable identifiers, 500-char strings, 0 items, and huge counts to expose layout breaks immediately.

### Stage 4: Iterative Hybridization & Promotion (`Promote`)
After the user tests the live prototypes and selects a winner (or asks to combine parts, drop an element, or add another):
1. Merge the winning design into the production component.
2. Remove throwaway prototype branches and the `<PrototypeSwitcher />` wrapper.

### Stage 5: Live Browser Verification, Deduplication & Simplification Pass (`Verify & Simplify`)
Never declare a screen "done" right after compiling. Open the live running app in the browser and perform a ruthless **Simplification & Fix Pass**:
1. **Live Visual & Interaction Check**: Inspect in both Light and Dark themes and at 1024px / 1280px / 1440px widths.
2. **Deduplication Audit ("One Place for Each Fact & Action")**: Remove every duplicate button, counter, badge, or link so each fact and action has **one canonical home**.
3. **Simplification & Motion Subtraction (`remove-animations`)**: Flatten nested borders, collapse secondary actions, and strip decorative motion on high-frequency data surfaces.

### Stage 6: Atomic Library Harvesting (`Harvest to @teob/ui` — MANDATORY WHEN NEW ELEMENTS EMERGE)
Whenever building or simplifying a screen produces a new reusable element — or requires a new visual token — **never leave it trapped inside a feature file**:
1. **Classify by Atomic Tier**:
   - **New Token (`0. Tokens`)**: Add to `src/design/tokens.css` (both `:root` light and `.dark` / `[data-theme='dark']`), update any host bridge (`--mv-*`, `--sc-*`), and add to the Token swatch/scale section in `Showcase.tsx`.
   - **New Atom (`1. Atoms`)**: Extract to `src/ui/<AtomName>.tsx` (single file, zero domain coupling, CSS variables only).
   - **New Molecule (`2. Molecules`)**: Extract to `src/ui/<MoleculeName>.tsx` (composed of Atoms, domain-agnostic props).
   - **New Organism (`3. Organisms`)**: Extract to `src/ui/<OrganismName>.tsx` (self-contained composite block such as a Pulse Strip, Agent Monitor, or Trace Waterfall).
   - **New Template (`4. Templates`)**: Register the macro-layout recipe in `Showcase.tsx` under `4. Templates & Proto`.
2. **Register & Showcase**:
   - Export the component and its TypeScript props under the matching Atomic section in `src/ui/index.ts`.
   - Add an interactive demonstration with realistic states in `src/ui-showcase/Showcase.tsx` (`#/ui`) and increment the layer count badge.
   - Verify `npm run build` and `npm test` pass.
3. **Distribution & Consumption (`Package Link vs. Selective Sync`)**:
   - **Preferred — Git/npm Package Link (`@teob/ui`)**: Consume `teob-cc/teob-ui` via `package.json` (e.g. `"@teob/ui": "github:teob-cc/teob-ui#v0.5.0"`) with `exports` for `.` (`src/ui/index.ts`), `./tokens.css`, and `./bridge/<app>.css`, plus `peerDependencies` (`react ^19`, `react-dom ^19`, `lucide-react`, `motion`) and `optionalDependencies` for heavy extras (`recharts`, `torph`). Bundlers (Vite/Rollup) tree-shake unused components automatically so apps don't carry 45+ vendored files or unused dependencies.
   - **Fallback — Selective Vendoring**: If vendoring into `src/teob-ui/`, sync only the primitives the app imports (and omit unused heavy organisms such as `ChartFrame`/`recharts` or `MorphText`/`torph`), or isolate the theme behind a toggleable plugin (`src/plugins/teob-theme/`).
   - **Never load via runtime HTTP/CDN URLs** in Tauri/desktop apps: strict `'self'` CSP, offline-first requirements, and React 19 singleton/provider guarantees require build-time bundling.
   - **CSS Layer Order**: Always declare `@layer base, teob-ui;` in `index.html` `<head>` *before* any `<link rel="stylesheet">` or React 19 hoisted `<style precedence="default">` tags so base resets (`* { padding: 0; margin: 0; }`) never override `@layer teob-ui` styles.
   - **Upstream (`App → Hub`)**: When working inside a consuming app (e.g., `agent-mcr` or `memory-console`), promote new/improved Tokens, Atoms, Molecules, or Organisms to the canonical `@teob/ui` hub, the `teob-cc/teob-ui` repository (`npm run harvest -- <File> --from <app>` there), ensuring zero app-specific imports. Every target runs React 19.
   - **Downstream (`Hub → Apps`)**: Run `teob-ui status` and `teob-ui pull` across linked apps so token updates, theme bridges (`--mv-*`, `--sc-*`), and new atomic primitives stay in lockstep without silent copy-paste drift.
