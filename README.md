# Auto Patrol Manager (OpenRCT2)

Automatically creates efficient, reachable patrol areas for **Handymen** and **Mechanics** so paths stay clean and rides get quick inspections—without micromanaging.

> Single-file plugin • No compile step • Preview + Apply • Safe fallbacks for older builds

---

## ✨ Features

- **Smart path analysis**  
  Builds a walkable path graph, **ignoring queues** and **pruning decorative/scenery-only branches**.

- **Food Court Coverage**  
  Detects food-court clusters (≥ _X_ stalls within _R_ tiles) and assigns **dedicated cleaners**.

- **Balanced Handyman zones**  
  Splits remaining paths into **contiguous**, **workload-balanced** zones with **dead-end rescue** to avoid missed cul-de-sacs.

- **Distance-aware Mechanic routes**  
  Clusters ride exits and builds a **minimal connecting tree** (MST) so mechanics walk only what helps them reach exits faster. Auto-splits if rides are too far apart.

- **Preview & KPIs**  
  Coverage %, average/max tiles per cleaner, clusters & exits per mechanic, longest route, food courts found, and clickable warnings.

- **Apply (best-effort)**  
  Attempts to **auto-hire**, **assign patrols**, and **spawn/move staff inside their zones** (feature-detected). Falls back cleanly if the API isn’t available on your build.

---

## 📥 Installation

1. Download the plugin file: **`auto-patrol-manager.js`**  
2. Place it in your OpenRCT2 `plugin` folder:
   - **Windows:** `Documents\OpenRCT2\plugin`  
   - **macOS:** `~/Library/Application Support/OpenRCT2/plugin`  
   - **Linux:** `~/.config/OpenRCT2/plugin`
3. Launch OpenRCT2 → open a park → Menu → **Auto Patrol Manager**

> The file is plain JavaScript—no build tools required.

---

## 🚀 Quick Start

1. Open **Auto Patrol Manager** from the menu.  
2. Click **Preview** to build the plan (zones/routes, food courts, KPIs, warnings).  
3. Tweak settings (presets, thresholds, options).  
4. Click **Apply** to assign patrols and place staff (when supported).  
5. Use **Re-Optimise** after major layout changes.

---

## 🔧 Settings (Overview)

### General
- **Enable Handyman Patrols** – auto-assign cleaner zones.  
- **Enable Mechanic Patrols** – build and assign mechanic routes.

### Handyman Zoning
- **Zone size preset**:  
  - **Tight Patrols** – smaller zones (~140 tiles/cleaner).  
  - **Balanced Patrols** – medium (~180).  
  - **Wide Patrols** – larger (~220).  
- **Allow overlaps to rescue cul-de-sacs** – prevents “black spots”.  
- **Keep shops/toilets cul-de-sacs** – optional inclusion even if not linked to rides.

### Food Court Coverage (separate)
- **Detect Food Courts** – finds stall clusters and reserves them.  
- **Stall threshold** – stalls required in area (default **3**).  
- **Detection radius** – tiles around each stall (default **8**).  
- **Include seating/bins** – boosts detection in borderline cases.  
- **Tiles per court cleaner** – target workload (default **120**).  
- **Max court size** – split courts bigger than this (default **160**).  
- **If staff are insufficient**: **Auto-hire** / **Assign only existing** / **Fold into general**.

### Mechanic Routing
- **Route preset**:  
  - **Compact Routes** – max **3** exits, MST cap **120**, diameter **100**.  
  - **Standard Routes** – max **4**, MST **180**, diameter **120**.  
  - **Extended Routes** – max **5**, MST **200**, diameter **140**.  
- **Avoid plazas** – excludes tiles that don’t shorten exit-to-exit travel.  
- **Allow small redundancy** – adds one backup link in a route.

### Staff Handling
- **If staff are insufficient**: **Auto-hire** / **Assign only existing** / **Stretch zones**.  
- **Spawn new staff inside their zone** – place them on a valid tile within the area.  
- **Move existing staff to their zone** – relocates them to start working immediately.  
- **Lock staff to current assignment** – preserves your manual placements on re-optimise.

---

## 🧠 How it works (short version)

- **Path graph:** Scans map tiles, includes walkable footpaths, excludes queues; then **peels off leaf branches** that don’t touch any “attractor” (ride entrances/exits; optionally shops/toilets) → **valid path network**.
- **Food courts:** Finds **local clusters of stalls** within a radius; flood-fills into a **compact subgraph**; assigns **dedicated cleaners** and **removes** those tiles from general zoning.
- **Handymen:** Picks **distributed seeds** and runs a **balanced flood fill** to reach target tiles/zone; **rescues dead ends** with a tiny overlap if necessary; **guarantees connectivity**.
- **Mechanics:** Computes shortest paths between ride exits; forms clusters respecting **max exits**, **diameter**, and **MST length** caps; builds a **tile route tree** per cluster (optionally avoids plazas).

---

## 📊 Preview KPIs & Warnings

- **Handyman coverage**: % of valid path tiles in zones  
- **Average / max tiles per cleaner**  
- **Mechanic clusters**: count, average exits, **longest route length**  
- **Food courts detected** + size  
- **Warnings** (click to zoom): isolated ride islands, uncovered paths, large food courts needing more cleaners, etc.

---

## 🧩 Compatibility & Fallbacks

- **Target API:** OpenRCT2 API **80+**  
- **Feature detection:** The plugin checks for hiring/moving/patrol-area APIs and **degrades gracefully**:
  - If hiring isn’t available → shows how many to hire.  
  - If moving isn’t available → pans to a suggested tile.  
  - If patrol write isn’t available → shows a **readable plan** (tiles/coords) for manual assignment.

> The plugin uses try/catch around all map reads/writes to avoid breaking saves.

---

## ⚠️ Known Limitations

- **Map overlays:** The in-window preview shows stats and lists; direct coloured overlays on the main map are limited by the API.  
- **Object detection:** Food court heuristics depend on stalls/seating being on/near paths.  
- **Old builds:** Some staff APIs may be missing; Apply will fall back to guidance.

---

## ❓ Troubleshooting

- **Nothing happens on Apply:** Click **Preview** first; ensure Handymen/Mechanics are enabled.  
- **Zones look too big/small:** Change the **zone preset** or **tiles per cleaner** and preview again.  
- **Mechanics keep walking through plazas:** Turn **Avoid plazas** on (Mechanic Routing).  
- **One huge park, few staff:** Choose **Auto-hire** or **Stretch zones** (with warning).  
- **Food court not detected:** Lower **stall threshold** or increase **detection radius**; optionally enable **seating/bins** boosting.

---

## 🗂️ Changelog

### v0.1
- Preview+Apply with safe fallbacks  
- Food Court detection & dedicated cleaners  
- Balanced Handyman zoning with dead-end rescue  
- Distance-aware Mechanic routing (MST) with split caps  
- KPIs, warnings, and staff handling options

---

## 📄 License

**MIT** — free to use, modify, and share.

---

## 🙌 Credits

Author: **Steven**

If you’d like presets or rules tailored to your park style (mega-plaza parks, transport-heavy layouts, etc.), open an issue or drop suggestions!
