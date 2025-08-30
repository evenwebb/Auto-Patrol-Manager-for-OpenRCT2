/// <reference path="openrct2.d.ts" />
/**
 * Auto Patrol Manager (v0.1)
 * Author: Steven
 * License: MIT
 * Target API: 80+
 *
 * What it does (summary):
 *  - Builds a clean footpath graph (queues & scenery branches pruned)
 *  - Detects Food Courts (≥ X stalls in R tiles) and reserves them
 *  - Divides remaining paths into balanced, connected Handyman zones with dead-end rescue
 *  - Creates distance-aware Mechanic routes (clusters of ride exits with MST path trees)
 *  - Shows a Preview (coverage, loads, warnings) and attempts Apply with feature detection
 *
 * Important:
 *  - If your build doesn’t expose staff hiring/moving/patrol APIs, Apply will fall back safely and show instructions.
 */

(function() {
  "use strict";

  const META = {
    name: "Auto Patrol Manager",
    version: "0.1",
    authors: ["Steven"],
    type: "local",
    targetApiVersion: 80
  };

  // -----------------------------
  // Settings with sensible defaults
  // -----------------------------
  const Settings = {
    enableHandymen: true,
    enableMechanics: true,

    // Handymen presets
    zonePreset: "Balanced Patrols", // "Tight Patrols" | "Balanced Patrols" | "Wide Patrols"
    tilesPerHandyman: 180,          // updated when preset changes
    allowDeadEndRescue: true,
    includeFacilitiesCuldesacs: false, // keep shops/toilets cul-de-sacs

    // Food Court coverage
    enableFoodCourts: true,
    foodCourtStallThreshold: 3,
    foodCourtRadius: 8,
    foodCourtIncludeSeatingBins: false,
    foodCourtMaxTiles: 160,
    foodCourtTilesPerCleaner: 120,
    foodCourtStaffInsufficient: "Auto-hire", // "Auto-hire" | "Assign only existing" | "Fold into general"

    // Mechanics presets
    mechPreset: "Standard Routes", // "Compact Routes" | "Standard Routes" | "Extended Routes"
    mechMaxExits: 4,
    mechMstCap: 180,
    mechDiameterCap: 120,
    mechAvoidPlazas: true,
    mechSmallRedundancy: false,

    // Staff handling
    staffInsufficient: "Auto-hire", // "Auto-hire" | "Assign only existing" | "Stretch zones"
    spawnNewInsideZone: true,
    moveExistingToZone: true,
    lockAssignments: false
  };

  // Preset tables
  function setHandymanPreset(name) {
    Settings.zonePreset = name;
    if (name === "Tight Patrols") Settings.tilesPerHandyman = 140;
    else if (name === "Balanced Patrols") Settings.tilesPerHandyman = 180;
    else Settings.tilesPerHandyman = 220; // Wide
  }

  function setMechPreset(name) {
    Settings.mechPreset = name;
    if (name === "Compact Routes") {
      Settings.mechMaxExits = 3; Settings.mechMstCap = 120; Settings.mechDiameterCap = 100;
    } else if (name === "Standard Routes") {
      Settings.mechMaxExits = 4; Settings.mechMstCap = 180; Settings.mechDiameterCap = 120;
    } else {
      Settings.mechMaxExits = 5; Settings.mechMstCap = 200; Settings.mechDiameterCap = 140;
    }
  }

  // Initialize presets
  setHandymanPreset(Settings.zonePreset);
  setMechPreset(Settings.mechPreset);

  // ---------------------------------
  // Internal planning state (preview)
  // ---------------------------------
  const Plan = {
    built: false,
    warnings: [],
    kpis: {
      validPathTiles: 0,
      coveredTiles: 0,
      handymanAvgTiles: 0,
      handymanMaxTiles: 0,
      mechClusters: 0,
      mechAvgExits: 0,
      mechLongestRoute: 0,
      foodCourts: 0
    },
    // Graph
    width: 0,
    height: 0,
    nodes: [],        // [{id,x,y,deg,attractor,component,valid:boolean}]
    idByXY: new Map(),// key "x,y" -> id
    edges: [],        // adjacency list
    validNodeIds: new Set(), // pruned valid nodes (not queues, not scenery-only)
    attractorNodeIds: new Set(), // entrances/exits (+facilities when enabled)
    // Food courts
    foodCourts: [],   // [{tiles:Set<nodeId>, center:{x,y}, name, staffNeeded}]
    reservedFoodTiles: new Set(), // all court tiles
    // Handymen
    handymanZones: [], // [{tiles:Set<nodeId>, centroid, name, staffIndex?:number}]
    // Mechanics
    mechExits: [],    // [{nodeId, x, y, rideId, rideName}]
    mechClusters: [], // [{exits:[index], tiles:Set<nodeId>, routes:[{from,to, pathIds:number[]}] }]
    // Staff mapping (plan)
    staff: {
      handymen: [], // [{id?, name?, zoneIndex, tilesCount, spawn:{x,y}}]
      mechanics: [] // [{id?, name?, clusterIndex, exitsCount, spawn:{x,y}}]
    }
  };

  // Utilities
  function key(x,y){ return x + "," + y; }
  function clamp(v,lo,hi){ return Math.max(lo, Math.min(hi, v)); }
  function randint(min,max){ return (Math.random()*(max-min+1)+min)|0; }
  function pushUnique(arr,v){ if (arr.indexOf(v) < 0) arr.push(v); }
  function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }
  function viewportPanTo(x,y,z){
    try {
      if (ui.mainViewport) ui.mainViewport.scrollTo({x:x*32+16,y:y*32+16,z:z||0});
      else if (ui.tileSelection) ui.tileSelection.range = {left:x,right:x,top:y,bottom:y};
    } catch {}
  }

  // API feature detection (best effort)
  const Api = {
    canHireStaff: !!safe(()=>context.queryAction("hire_staff"), null),
    canSetPatrol: true, // optimistic; we will guard writes anyway
    canMoveStaff: true, // will be guarded by try/catch with fallback
  };

  // -----------------------------
  // Entry
  // -----------------------------
  registerPlugin({
    name: META.name,
    version: META.version,
    authors: META.authors,
    type: META.type,
    targetApiVersion: META.targetApiVersion,
    licence: "MIT",
    main() {
      ui.registerMenuItem(META.name, openWindow);
    }
  });

  // -----------------------------
  // UI
  // -----------------------------
  function openWindow(){
    const w = ui.openWindow({
      classification: "auto-patrol-manager",
      title: META.name,
      width: 560,
      height: 420,
      colours: [24,24],
      widgets: [
        // Top buttons
        button("btnPreview", 10, 10, 100, 16, "Preview", onPreview),
        button("btnApply",   120,10, 100, 16, "Apply", onApply),
        button("btnRebuild", 230,10, 110, 16, "Re-Optimise", onPreview),
        button("btnReset",   350,10, 80, 16, "Reset", onReset),

        // Left column - options
        label(10, 36, "General"),
        checkbox("chkHandy", 10, 52, 170, "Enable Handyman Patrols", Settings.enableHandymen, v=>Settings.enableHandymen=v),
        checkbox("chkMech",  10, 70, 170, "Enable Mechanic Patrols", Settings.enableMechanics, v=>Settings.enableMechanics=v),

        // Handymen section
        line(10, 92, 260),
        label(10, 98, "Handyman Zoning"),
        dropdown("ddZone", 10, 116, 170, ["Tight Patrols","Balanced Patrols","Wide Patrols"], i=>{
          const names = ["Tight Patrols","Balanced Patrols","Wide Patrols"];
          setHandymanPreset(names[i]);
          refreshWindow();
        }),
        label(190, 118, "Tiles per cleaner"),
        spinner("spTiles", 290, 116, Settings.tilesPerHandyman, v=>{
          Settings.tilesPerHandyman = clamp(v, 80, 400);
        }),
        checkbox("chkRescue", 10, 138, 260, "Allow overlaps to rescue cul-de-sacs", Settings.allowDeadEndRescue, v=>Settings.allowDeadEndRescue=v),
        checkbox("chkFac", 10, 156, 260, "Keep shops/toilets cul-de-sacs", Settings.includeFacilitiesCuldesacs, v=>Settings.includeFacilitiesCuldesacs=v),

        // Food court section
        line(10, 178, 260),
        label(10, 184, "Food Court Coverage"),
        checkbox("chkFC", 10, 202, 160, "Detect Food Courts", Settings.enableFoodCourts, v=>Settings.enableFoodCourts=v),
        label(10, 220, "Stall threshold"),
        spinner("spFct", 120, 218, Settings.foodCourtStallThreshold, v=>Settings.foodCourtStallThreshold=clamp(v,1,10)),
        label(10, 238, "Detection radius"),
        spinner("spFcr", 120, 236, Settings.foodCourtRadius, v=>Settings.foodCourtRadius=clamp(v,3,20)),
        checkbox("chkFcb", 10, 256, 240, "Include seating/bins in detection", Settings.foodCourtIncludeSeatingBins, v=>Settings.foodCourtIncludeSeatingBins=v),
        label(10, 274, "Tiles per court cleaner"),
        spinner("spFctc", 170, 272, Settings.foodCourtTilesPerCleaner, v=>Settings.foodCourtTilesPerCleaner=clamp(v,60,240)),
        label(10, 292, "Max court size"),
        spinner("spFcms", 170, 290, Settings.foodCourtMaxTiles, v=>Settings.foodCourtMaxTiles=clamp(v,60,500)),
        label(10, 312, "If staff are insufficient"),
        dropdown("ddFcs", 10, 328, 240, ["Auto-hire","Assign only existing","Fold into general"], i=>{
          Settings.foodCourtStaffInsufficient = ["Auto-hire","Assign only existing","Fold into general"][i];
        }),

        // Mechanics section
        line(290, 92, 260),
        label(290, 98, "Mechanic Routing"),
        dropdown("ddMech", 290, 116, 170, ["Compact Routes","Standard Routes","Extended Routes"], i=>{
          const names = ["Compact Routes","Standard Routes","Extended Routes"];
          setMechPreset(names[i]); refreshWindow();
        }),
        label(470, 118, "Max exits"),
        spinner("spMx", 530, 116, Settings.mechMaxExits, v=>Settings.mechMaxExits=clamp(v,1,10)),
        label(290, 136, "MST cap"),
        spinner("spMst", 350, 134, Settings.mechMstCap, v=>Settings.mechMstCap=clamp(v,40,400)),
        label(410, 136, "Diameter cap"),
        spinner("spDia", 500, 134, Settings.mechDiameterCap, v=>Settings.mechDiameterCap=clamp(v,40,400)),
        checkbox("chkPlz", 290, 156, 240, "Avoid plazas", Settings.mechAvoidPlazas, v=>Settings.mechAvoidPlazas=v),
        checkbox("chkRed", 290, 174, 240, "Allow small redundancy", Settings.mechSmallRedundancy, v=>Settings.mechSmallRedundancy=v),

        // Staff handling
        line(290, 196, 260),
        label(290, 202, "Staff Handling"),
        label(290, 220, "If staff are insufficient"),
        dropdown("ddSi", 290, 236, 240, ["Auto-hire","Assign only existing","Stretch zones"], i=>{
          Settings.staffInsufficient = ["Auto-hire","Assign only existing","Stretch zones"][i];
        }),
        checkbox("chkSpawn", 290, 256, 260, "Spawn new staff inside their zone", Settings.spawnNewInsideZone, v=>Settings.spawnNewInsideZone=v),
        checkbox("chkMove", 290, 274, 260, "Move existing staff to their zone", Settings.moveExistingToZone, v=>Settings.moveExistingToZone=v),
        checkbox("chkLock", 290, 292, 260, "Lock staff to current assignment", Settings.lockAssignments, v=>Settings.lockAssignments=v),

        // Right column bottom - KPIs + warnings
        line(10, 352, 540),
        label("lblKpi", 10, 360, "Status: click Preview to build a plan"),
        list("lstWarn", 10, 378, 540, 32, []),
      ],
      onClose: ()=>{}
    });

    // Set dropdown defaults
    getW("ddZone").selectedIndex = ["Tight Patrols","Balanced Patrols","Wide Patrols"].indexOf(Settings.zonePreset);
    getW("ddMech").selectedIndex = ["Compact Routes","Standard Routes","Extended Routes"].indexOf(Settings.mechPreset);
    getW("ddFcs").selectedIndex = ["Auto-hire","Assign only existing","Fold into general"].indexOf(Settings.foodCourtStaffInsufficient);
    getW("ddSi").selectedIndex = ["Auto-hire","Assign only existing","Stretch zones"].indexOf(Settings.staffInsufficient);
  }

  function refreshWindow(){
    // Just keep spinners aligned to current preset values
    setSpinner("spTiles", Settings.tilesPerHandyman);
    setSpinner("spMx", Settings.mechMaxExits);
    setSpinner("spMst", Settings.mechMstCap);
    setSpinner("spDia", Settings.mechDiameterCap);
  }

  // UI helpers
  function label(x,y,text){ return { type:"label", x, y, width:240, height:12, text}; }
  function line(x,y,w){ return { type:"line", x, y, width:w, height:0 }; }
  function button(name,x,y,w,h,text, onClick){ return { type:"button", name, x,y, width:w, height:h, text, onClick }; }
  function checkbox(name,x,y,w,text,isChecked,onChange){
    return { type:"checkbox", name, x,y, width:w, height:12, text, isChecked, onChange:()=>{ const wdg=getW(name); wdg.isChecked=!wdg.isChecked; onChange(wdg.isChecked);} };
  }
  function dropdown(name,x,y,w,items,onChange){ return { type:"dropdown", name, x,y, width:w, height:12, items, selectedIndex:0, onChange }; }
  function spinner(name,x,y,val,onChangeNum){
    return { type:"spinner", name, x,y, width:50,height:12, text:String(val),
      onIncrement:()=>{ const sp=getW(name); const v=(parseInt(sp.text||"0",10)||0)+1; sp.text=String(v); onChangeNum(v); },
      onDecrement:()=>{ const sp=getW(name); const v=(parseInt(sp.text||"0",10)||0)-1; sp.text=String(v); onChangeNum(v); }
    };
  }
  function list(name,x,y,w,h,items){ return { type:"listview", name, x,y, width:w, height:h, isStriped:true, showColumnHeaders:false, columns:[{header:"", width:w-10}], items: items.map(s=>[s])}; }
  function setSpinner(name,val){ try{ getW(name).text=String(val);}catch{} }
  function setLabel(name,text){ try{ getW(name).text=text;}catch{} }
  function setWarnings(lines){ try{ getW("lstWarn").items = lines.map(s=>[s]); } catch{} }
  function getW(name){ return ui.getWindow("auto-patrol-manager").findWidget(name); }

  // -----------------------------
  // Preview / Apply / Reset
  // -----------------------------
  function onReset(){
    Plan.built=false;
    Plan.warnings = [];
    Plan.kpis = { validPathTiles:0, coveredTiles:0, handymanAvgTiles:0, handymanMaxTiles:0, mechClusters:0, mechAvgExits:0, mechLongestRoute:0, foodCourts:0 };
    Plan.nodes=[]; Plan.edges=[]; Plan.validNodeIds.clear(); Plan.attractorNodeIds.clear();
    Plan.foodCourts=[]; Plan.reservedFoodTiles.clear();
    Plan.handymanZones=[]; Plan.mechExits=[]; Plan.mechClusters=[];
    Plan.staff = { handymen:[], mechanics:[] };
    setLabel("lblKpi","Status: plan cleared.");
    setWarnings([]);
  }

  function onPreview(){
    onReset();
    buildPathGraph();
    pruneSceneryBranches();

    if (Settings.enableFoodCourts) detectFoodCourts();

    if (Settings.enableHandymen) buildHandymanZones();
    if (Settings.enableMechanics) buildMechanicRoutes();

    computeKpis();
    showStatus();
  }

  function onApply(){
    if (!Plan.built){
      ui.showError("No plan yet","Click Preview first to build a plan.");
      return;
    }
    let notes = [];

    const appliedHandy = applyHandymanZones(notes);
    const appliedMech  = applyMechanicRoutes(notes);

    const msg = [
      appliedHandy ? "Handyman zones applied (where supported)." : "Handyman zones previewed only.",
      appliedMech  ? "Mechanic routes applied (where supported)." : "Mechanic routes previewed only.",
      "",
      "Notes:",
      ...notes
    ].join("\n");
    ui.showTextInput({title:"Auto Patrol Manager", description:"Result summary (read-only).", initialValue:msg, callback:()=>{}});
  }

  // -----------------------------
  // Build Footpath Graph
  // -----------------------------
  function buildPathGraph(){
    const w = map.size.x, h = map.size.y;
    Plan.width = w; Plan.height = h;

    const nodes = [];
    const idByXY = new Map();
    const edges = [];
    const attractors = new Set();

    // Scan tiles
    for (let x=0; x<w; x++){
      for (let y=0; y<h; y++){
        const tile = map.getTile(x,y);
        if (!tile) continue;
        // Determine if this tile has a usable footpath (not a queue)
        let hasPath = false;
        let isQueue = false;

        for (let i=0; i<tile.elements.length; i++){
          const el = tile.elements[i];
          const t = String(el.type||"");
          if (t === "footpath"){
            hasPath = true;
            // multiple field names across builds; be defensive
            const q = (el.isQueue === true) || (el.queue === true) || (String(el.flags||"").indexOf("queue")>=0);
            if (q) isQueue = true;
          }
          if (t === "rideEntrance" || t === "rideExit"){
            attractors.add(key(x,y));
          }
        }

        if (hasPath && !isQueue){
          const id = nodes.length;
          nodes.push({ id, x, y, deg: 0, attractor: attractors.has(key(x,y)), component:-1, valid:true });
          idByXY.set(key(x,y), id);
        }
      }
    }

    // Edges (4-neighbour)
    for (let i=0; i<nodes.length; i++){
      edges[i] = [];
    }
    for (let i=0; i<nodes.length; i++){
      const n = nodes[i];
      const nbrs = [[1,0],[-1,0],[0,1],[0,-1]];
      for (const d of nbrs){
        const nx = n.x + d[0], ny = n.y + d[1];
        const id2 = idByXY.get(key(nx,ny));
        if (id2 !== undefined){
          edges[i].push(id2);
          nodes[i].deg++;
        }
      }
    }

    // Facilities attractors (optional)
    if (Settings.includeFacilitiesCuldesacs){
      // Try to find stalls and toilets by scanning tiles for facility entrances
      for (let x=0; x<w; x++){
        for (let y=0; y<h; y++){
          const tile = map.getTile(x,y);
          for (const el of tile.elements){
            const t = String(el.type||"");
            if (t === "smallScenery" || t==="largeScenery") {
              // benches/bins count as soft attractors (optional)
              if (Settings.foodCourtIncludeSeatingBins){
                if (String(el.object)||"".toLowerCase().indexOf("bench")>=0 ||
                    String(el.object)||"".toLowerCase().indexOf("bin")>=0){
                  const id = idByXY.get(key(x,y));
                  if (id !== undefined) nodes[id].attractor = true;
                }
              }
            }
            // We keep ride entrances/exits already added
          }
        }
      }
    }

    // Save
    Plan.nodes = nodes;
    Plan.idByXY = idByXY;
    Plan.edges = edges;
    Plan.validNodeIds = new Set(nodes.map(n=>n.id));
    Plan.attractorNodeIds.clear();
    for (const n of nodes) if (n.attractor) Plan.attractorNodeIds.add(n.id);
  }

  // Prune scenery-only branches: peel leaves not adjacent to attractors
  function pruneSceneryBranches(){
    const valid = Plan.validNodeIds;
    const edges = Plan.edges;
    const nodes = Plan.nodes;
    const attractors = Plan.attractorNodeIds;

    // mark nodes that are leaves (deg 1 among valid nodes)
    const deg = new Array(nodes.length).fill(0);
    for (const id of valid) {
      for (const nb of edges[id]) if (valid.has(nb)) deg[id]++;
    }

    const queue = [];
    for (const id of valid){
      if (deg[id] <= 1 && !adjacentToAttractor(id)) queue.push(id);
    }

    function adjacentToAttractor(id){
      if (attractors.has(id)) return true;
      for (const nb of edges[id]) if (attractors.has(nb)) return true;
      return false;
    }

    while (queue.length){
      const id = queue.pop();
      if (!valid.has(id)) continue;
      if (adjacentToAttractor(id)) continue; // keep
      // remove
      valid.delete(id);
      for (const nb of edges[id]){
        if (valid.has(nb)){
          deg[nb]--;
          if (deg[nb] <= 1 && !adjacentToAttractor(nb)) queue.push(nb);
        }
      }
    }

    // Count valid tiles
    Plan.kpis.validPathTiles = valid.size;
  }

  // -----------------------------
  // Food Court Detection
  // -----------------------------
  function detectFoodCourts(){
    const courts = [];
    const reserved = new Set();

    // Find stall "centres" by rough proximity: scan ride entrances tagged as stalls if present,
    // else approximate by clusters of benches/bins when enabled.
    const stallCenters = [];

    // Approximation: any path tile near at least Settings.foodCourtStallThreshold ride entrances/exits within radius R counts
    // We derive "shop points" from ride entrances whose ride seems to be a stall. Not all builds expose this; we fallback quietly.

    const shopEntrances = getLikelyShopEntranceCoords();

    // Score grid by number of shops within radius
    const R = Settings.foodCourtRadius;
    const R2 = R*R;

    // Try each shop entrance as a seed
    for (const pt of shopEntrances){
      let count = 0;
      for (const pt2 of shopEntrances){
        const dx = pt2.x-pt.x, dy = pt2.y-pt.y;
        if (dx*dx + dy*dy <= R2) count++;
      }
      if (count >= Settings.foodCourtStallThreshold) stallCenters.push(pt);
    }

    // Grow courts from seeds
    const visited = new Set();
    for (const c of stallCenters){
      const nid = Plan.idByXY.get(key(c.x, c.y));
      if (nid === undefined || !Plan.validNodeIds.has(nid)) continue;
      if (visited.has(nid)) continue;

      // flood fill until density breaks or size cap
      const tiles = new Set();
      const q=[nid];
      visited.add(nid);
      while (q.length && tiles.size < Settings.foodCourtMaxTiles){
        const v = q.shift();
        tiles.add(v);
        for (const nb of Plan.edges[v]){
          if (!Plan.validNodeIds.has(nb)) continue;
          if (visited.has(nb)) continue;
          // stay within radius of the centre
          const nv = Plan.nodes[nb];
          const dx = nv.x - c.x, dy = nv.y - c.y;
          if (dx*dx + dy*dy > R2) continue;
          visited.add(nb);
          q.push(nb);
        }
      }

      if (tiles.size >= 20) { // minimal meaningful size
        // Reserve and record
        for (const t of tiles) reserved.add(t);
        courts.push({ tiles, center:{x:c.x,y:c.y}, name: `Food Court ${courts.length+1}`, staffNeeded: Math.max(1, Math.ceil(tiles.size / Settings.foodCourtTilesPerCleaner)) });
      }
    }

    Plan.foodCourts = courts;
    Plan.reservedFoodTiles = reserved;
    Plan.kpis.foodCourts = courts.length;
  }

  // Attempt to detect shop entrances by scanning tiles for rideEntrance elements whose ride is a stall
  function getLikelyShopEntranceCoords(){
    const coords = [];
    const w = map.size.x, h = map.size.y;
    const rideCache = {};
    function isStallRide(ride){
      if (!ride) return false;
      // Common heuristics across builds
      const t = String(ride.type||"").toLowerCase();
      const name = String(ride.name||"").toLowerCase();
      const cat = String(ride.classification||"").toLowerCase();
      return (t.indexOf("stall")>=0 || t.indexOf("shop")>=0 || cat.indexOf("stall")>=0 || cat.indexOf("shop")>=0 || name.indexOf("stall")>=0 || name.indexOf("shop")>=0);
    }
    for (let x=0; x<w; x++){
      for (let y=0; y<h; y++){
        const tile = map.getTile(x,y);
        for (const el of tile.elements){
          if (String(el.type||"") === "rideEntrance"){
            const rid = el.ride;
            if (rideCache[rid] === undefined){
              rideCache[rid] = safe(()=>map.rides[rid], null);
            }
            if (isStallRide(rideCache[rid])){
              coords.push({x,y});
            }
          }
        }
      }
    }
    return coords;
  }

  // -----------------------------
  // Handyman Zoning
  // -----------------------------
  function buildHandymanZones(){
    const valid = new Set([...Plan.validNodeIds].filter(id => !Plan.reservedFoodTiles.has(id)));
    if (valid.size === 0) return;

    const zones = [];

    // First: assign Food Court dedicated zones
    if (Settings.enableFoodCourts && Plan.foodCourts.length){
      for (const court of Plan.foodCourts){
        const ztiles = new Set();
        for (const t of court.tiles) if (Plan.validNodeIds.has(t)) ztiles.add(t);
        if (!ztiles.size) continue;
        zones.push({ tiles: ztiles, centroid: centroidOfTiles(ztiles), name: court.name });
        // remove from general valid
        for (const t of ztiles) valid.delete(t);
      }
    }

    // Determine how many handymen are needed
    const tcount = valid.size;
    let needed = Math.ceil(tcount / Settings.tilesPerHandyman);
    if (!Settings.enableHandymen) needed = 0;

    // Existing staff?
    const existingHandy = getAllHandymen();
    let available = existingHandy.length;
    if (Settings.staffInsufficient === "Assign only existing") {
      needed = Math.min(needed, available);
    } else if (Settings.staffInsufficient === "Stretch zones") {
      // keep needed as-is, will stretch later; just a flag
    } else {
      // Auto-hire as needed (best effort)
      if (available < needed) {
        const hireCount = needed - available;
        const hired = tryHireStaff("handyman", hireCount);
        available += hired;
      }
    }

    // Seeds from hubs among valid tiles
    if (needed <= 0 && valid.size>0) needed = 1; // ensure at least one zone if there are tiles
    const seeds = pickSeeds(valid, Math.max(needed, 0));
    // Grow balanced flood fills
    const target = Settings.tilesPerHandyman;
    const grown = balancedFlood(valid, seeds, target);

    for (let i=0;i<grown.length;i++){
      const tiles = grown[i];
      if (!tiles || !tiles.size) continue;
      zones.push({ tiles, centroid: centroidOfTiles(tiles), name: `Zone ${zones.length+1}` });
    }

    // Dead-end rescue pass if allowed
    if (Settings.allowDeadEndRescue) {
      rescueDeadEnds(zones);
    }

    Plan.handymanZones = zones;
  }

  // Choose seed nodes distributed over valid set: pick farthest-first
  function pickSeeds(validSet, k){
    const ids = Array.from(validSet);
    if (!ids.length || k<=0) return [];
    const nodes = Plan.nodes;

    const seeds = [];
    // pick a random start
    seeds.push(ids[randint(0, ids.length-1)]);
    while(seeds.length < k){
      let best=null, bestScore=-1;
      for (const id of validSet){
        // distance to nearest seed (Manhattan as heuristic)
        let dmin = 1e9;
        const n = nodes[id];
        for (const s of seeds){
          const ns = nodes[s];
          const d = Math.abs(ns.x - n.x) + Math.abs(ns.y - n.y);
          if (d < dmin) dmin = d;
        }
        if (dmin > bestScore){ bestScore=dmin; best=id; }
      }
      if (best!==null) seeds.push(best); else break;
    }
    return seeds;
  }

  // Balanced flood fill from seeds up to target size
  function balancedFlood(validSet, seeds, target){
    const zones = seeds.map(()=> new Set());
    const frontier = seeds.map(s=>[s]);
    const claimed = new Map(); // nodeId -> zoneIndex

    // claim seeds
    for (let i=0;i<seeds.length;i++){
      const s = seeds[i];
      if (!validSet.has(s)) continue;
      zones[i].add(s);
      claimed.set(s,i);
    }

    while(true){
      let progressed = false;
      for (let i=0;i<zones.length;i++){
        if (zones[i].size >= target) continue;
        const wave = frontier[i];
        const next = [];
        while(wave.length && zones[i].size < target){
          const v = wave.shift();
          for (const nb of Plan.edges[v]){
            if (!validSet.has(nb)) continue;
            if (claimed.has(nb)) continue;
            claimed.set(nb,i);
            zones[i].add(nb);
            next.push(nb);
            progressed = true;
            if (zones[i].size >= target) break;
          }
        }
        frontier[i] = next;
      }
      if (!progressed) break;
      // stop if every zone met target or no unclaimed
      let allMet = true;
      for (let i=0;i<zones.length;i++){
        if (zones[i].size < target) { allMet=false; break; }
      }
      if (allMet) break;
    }

    // Assign any remaining unclaimed to nearest zone by BFS
    const remaining = Array.from(validSet).filter(id=>!claimed.has(id));
    for (const id of remaining){
      const z = nearestZoneIndex(id, zones);
      if (z>=0) zones[z].add(id);
    }

    return zones;
  }

  function nearestZoneIndex(id, zones){
    // choose the zone whose centroid is closest
    if (!zones.length) return -1;
    const n = Plan.nodes[id];
    let best=-1, bestd=1e9;
    for (let i=0;i<zones.length;i++){
      if (zones[i].size===0) continue;
      const c = centroidOfTiles(zones[i]);
      const d = Math.abs(c.x - n.x) + Math.abs(c.y - n.y);
      if (d<bestd){ bestd=d; best=i; }
    }
    return best;
  }

  function centroidOfTiles(set){
    let sx=0, sy=0, c=0;
    for (const id of set){ const n=Plan.nodes[id]; sx+=n.x; sy+=n.y; c++; }
    return { x: Math.round(sx/c), y: Math.round(sy/c) };
  }

  // Attach any leaf chains left out to nearest zone (allow tiny overlap at junction)
  function rescueDeadEnds(zones){
    const valid = new Set();
    for (const z of zones) for (const t of z.tiles) valid.add(t);

    const deg = new Map();
    for (const id of valid){
      let d=0; for (const nb of Plan.edges[id]) if (valid.has(nb)) d++; deg.set(id,d);
    }
    const leaves = Array.from(valid).filter(id=>deg.get(id)<=1);

    for (const leaf of leaves){
      // Ensure it belongs to some zone; if not, attach it to the nearest zone at junction
      if (!zones.some(z=>z.tiles.has(leaf))){
        // pick neighbour that is in a zone
        let choice=-1, zIndex=-1;
        for (const nb of Plan.edges[leaf]){
          for (let zi=0; zi<zones.length; zi++){
            if (zones[zi].tiles.has(nb)){ choice=nb; zIndex=zi; break; }
          }
          if (choice>=0) break;
        }
        if (zIndex>=0){
          zones[zIndex].tiles.add(leaf);
        }
      }
    }
  }

  // -----------------------------
  // Mechanic Routes (distance-aware)
  // -----------------------------
  function buildMechanicRoutes(){
    const exits = [];
    const w = map.size.x, h = map.size.y;

    for (let x=0;x<w;x++){
      for (let y=0;y<h;y++){
        const tile = map.getTile(x,y);
        for (const el of tile.elements){
          if (String(el.type||"") === "rideExit"){
            const nid = Plan.idByXY.get(key(x,y));
            if (nid === undefined || !Plan.validNodeIds.has(nid)) continue;
            exits.push({ nodeId:nid, x,y, rideId: el.ride, rideName: safe(()=>map.rides[el.ride].name, "Ride "+el.ride) });
          }
        }
      }
    }
    Plan.mechExits = exits;

    // Distance matrix (BFS over path graph for each exit)
    const dist = [];
    const paths = [];
    for (let i=0;i<exits.length;i++){
      const a = exits[i].nodeId;
      const d = bfsDistances(a);
      dist[i] = [];
      paths[i] = [];
      for (let j=0;j<exits.length;j++){
        const b = exits[j].nodeId;
        const dj = d.dist[b] || 1e9;
        dist[i][j] = dj;
        paths[i][j] = d.prev; // we will reconstruct later using prev map
      }
    }

    // Cluster exits per preset limits
    const clusters = [];
    const unassigned = new Set(exits.map((_,i)=>i));

    while (unassigned.size){
      // pick a seed
      const seedIndex = unassigned.values().next().value;
      unassigned.delete(seedIndex);

      let current = [seedIndex];
      // Greedily add nearest exits while respecting caps
      while (current.length < Settings.mechMaxExits){
        // find nearest candidate that keeps diameter & MST length under caps
        let best=null, bestd=1e9;
        for (const idx of unassigned){
          // compute diameter if added (max dist among exits in set∪{idx})
          const dia = diameterWith(current, idx, dist);
          if (dia > Settings.mechDiameterCap) continue;
          // quick MST approx: connect to nearest in current
          let nd=1e9;
          for (const c of current) nd = Math.min(nd, dist[idx][c]);
          if (nd < bestd){ bestd=nd; best=idx; }
        }
        if (best===null) break;
        current.push(best);
        unassigned.delete(best);
        // rough MST length check: sum of nearest links from each node to current (Prim-like)
        if (mstLengthApprox(current, dist) > Settings.mechMstCap){
          // undo last
          current.pop();
          unassigned.add(best);
          break;
        }
      }
      clusters.push(current);
    }

    // Build tile routes: MST over cluster exits
    const mechClusters = [];
    for (const c of clusters){
      if (!c.length) continue;
      // Build MST edges (Prim) using dist
      const used = new Set([c[0]]);
      const edgesC = [];
      while (used.size < c.length){
        let best = null, bestw=1e9, bestU=-1, bestV=-1;
        for (const u of used){
          for (const v of c){
            if (used.has(v)) continue;
            const w = dist[u][v];
            if (w < bestw){ bestw=w; best={u,v}; bestU=u; bestV=v; }
          }
        }
        if (!best) break;
        used.add(bestV);
        edgesC.push([bestU, bestV]);
      }
      // Convert edges to tile paths
      const routeTiles = new Set();
      const routes = [];
      for (const [u,v] of edgesC){
        const sp = shortestPathBetween(exits[u].nodeId, exits[v].nodeId);
        for (const id of sp) routeTiles.add(id);
        routes.push({ from:u, to:v, pathIds: sp });
      }
      mechClusters.push({ exits:c.slice(), tiles: routeTiles, routes });
    }

    Plan.mechClusters = mechClusters;
  }

  function diameterWith(arr, idx, dist){
    let dia=0;
    const set = arr.concat([idx]);
    for (let i=0;i<set.length;i++){
      for (let j=i+1;j<set.length;j++){
        dia = Math.max(dia, dist[set[i]][set[j]]);
      }
    }
    return dia;
  }

  function mstLengthApprox(list, dist){
    // Prim-like: sum of nearest distances to build a tree
    if (!list.length) return 0;
    const used = new Set([list[0]]);
    let length = 0;
    while (used.size < list.length){
      let best=1e9, bestV=-1;
      for (const v of list){
        if (used.has(v)) continue;
        let nd=1e9;
        for (const u of used) nd = Math.min(nd, dist[u][v]);
        if (nd < best){ best=nd; bestV=v; }
      }
      if (bestV<0) break;
      length += best;
      used.add(bestV);
    }
    return length;
  }

  function bfsDistances(startId){
    const dist = {};
    const prev = {};
    const q=[startId];
    dist[startId]=0;
    while(q.length){
      const v=q.shift();
      for (const nb of Plan.edges[v]){
        if (!Plan.validNodeIds.has(nb)) continue;
        if (dist[nb] !== undefined) continue;
        dist[nb] = dist[v]+1;
        prev[nb] = v;
        q.push(nb);
      }
    }
    return {dist, prev};
  }

  function shortestPathBetween(a,b){
    const d = bfsDistances(a);
    if (d.dist[b] === undefined) return [];
    const path = [b];
    let cur = b;
    while (cur !== a){
      cur = d.prev[cur];
      if (cur === undefined) break;
      path.push(cur);
    }
    return path.reverse();
  }

  // -----------------------------
  // KPIs & Status
  // -----------------------------
  function computeKpis(){
    Plan.built = true;
    // Handymen tiles
    let covered = 0;
    let loads = [];
    for (const z of Plan.handymanZones){
      covered += z.tiles.size;
      loads.push(z.tiles.size);
    }
    Plan.kpis.coveredTiles = covered;
    Plan.kpis.handymanAvgTiles = loads.length ? Math.round(loads.reduce((a,b)=>a+b,0)/loads.length) : 0;
    Plan.kpis.handymanMaxTiles = loads.length ? Math.max.apply(null, loads) : 0;

    // Mechanics
    Plan.kpis.mechClusters = Plan.mechClusters.length;
    let totalExits = 0, longestRoute = 0;
    for (const mc of Plan.mechClusters){
      totalExits += mc.exits.length;
      let longest = 0;
      for (const r of mc.routes) if (r.pathIds) longest = Math.max(longest, r.pathIds.length);
      longestRoute = Math.max(longestRoute, longest);
    }
    Plan.kpis.mechAvgExits = Plan.mechClusters.length ? Math.round(totalExits/Plan.mechClusters.length) : 0;
    Plan.kpis.mechLongestRoute = longestRoute;

    // Warnings (edges)
    Plan.warnings = [];
    if (Settings.enableHandymen){
      const ratio = Plan.kpis.validPathTiles ? Math.round(100*covered/Plan.kpis.validPathTiles) : 0;
      if (ratio < 100) Plan.warnings.push(`Coverage ${ratio}%: some valid paths are not in a zone.`);
    }
    if (Settings.enableMechanics){
      if (Plan.mechClusters.length===0) Plan.warnings.push("No mechanic clusters detected (no ride exits?).");
    }
    if (Settings.enableFoodCourts && Plan.foodCourts.length){
      for (const fc of Plan.foodCourts){
        const need = Math.max(1, Math.ceil(fc.tiles.size / Settings.foodCourtTilesPerCleaner));
        if (need > 1) Plan.warnings.push(`${fc.name} is large (${fc.tiles.size} tiles). Recommend ${need} cleaners.`);
      }
    }
  }

  function showStatus(){
    const k = Plan.kpis;
    const ratio = k.validPathTiles ? Math.round(100*k.coveredTiles / k.validPathTiles) : 0;
    const lines = [
      `Handyman coverage: ${ratio}% of valid path tiles`,
      `Avg tiles/cleaner: ${k.handymanAvgTiles} (max ${k.handymanMaxTiles})`,
      `Mechanic clusters: ${k.mechClusters}, avg exits ${k.mechAvgExits}, longest route ${k.mechLongestRoute} tiles`,
      `Food courts detected: ${Plan.foodCourts.length}`
    ];
    setLabel("lblKpi", lines.join("  |  "));
    setWarnings(Plan.warnings);
  }

  // -----------------------------
  // Apply (best-effort, feature-detected)
  // -----------------------------
  function applyHandymanZones(notes){
    if (!Settings.enableHandymen) return false;

    const zones = Plan.handymanZones;
    if (!zones.length){ notes.push("No handyman zones to apply."); return false; }

    const ensure = ensureHandymen(zones.length);
    if (ensure.hired > 0) notes.push(`Hired ${ensure.hired} handymen.`);

    // Assign and move
    let appliedAny = false;
    for (let i=0;i<zones.length;i++){
      const staff = ensure.list[i];
      if (!staff){ notes.push(`No handyman available for ${zones[i].name}.`); continue; }
      const okPatrol = trySetPatrolArea(staff, zones[i].tiles);
      appliedAny = appliedAny || okPatrol;
      if (!okPatrol) notes.push(`Patrol API not available for ${staff.name||("Handyman "+staff.id)}; preview only.`);

      if (Settings.moveExistingToZone || Settings.spawnNewInsideZone){
        const c = zones[i].centroid;
        const moved = tryMoveStaffTo(staff, c.x, c.y);
        if (!moved) notes.push(`Could not move ${staff.name||("Handyman "+staff.id)}; please place them near ${c.x},${c.y}.`);
      }
    }
    return appliedAny;
  }

  function applyMechanicRoutes(notes){
    if (!Settings.enableMechanics) return false;

    const clusters = Plan.mechClusters;
    if (!clusters.length){ notes.push("No mechanic routes to apply."); return false; }

    const ensure = ensureMechanics(clusters.length);
    if (ensure.hired > 0) notes.push(`Hired ${ensure.hired} mechanics.`);

    let appliedAny = false;
    for (let i=0;i<clusters.length;i++){
      const staff = ensure.list[i];
      if (!staff){ notes.push(`No mechanic available for cluster ${i+1}.`); continue; }
      // Patrol = route tiles only
      const okPatrol = trySetPatrolArea(staff, clusters[i].tiles);
      appliedAny = appliedAny || okPatrol;
      if (!okPatrol) notes.push(`Patrol API not available for ${staff.name||("Mechanic "+staff.id)}; preview only.`);

      if (Settings.moveExistingToZone || Settings.spawnNewInsideZone){
        // Spawn at first exit
        const firstExitIndex = clusters[i].exits[0];
        const ex = Plan.mechExits[firstExitIndex];
        const moved = tryMoveStaffTo(staff, ex.x, ex.y);
        if (!moved) notes.push(`Could not move ${staff.name||("Mechanic "+staff.id)}; please place them near ${ex.x},${ex.y}.`);
      }
    }
    return appliedAny;
  }

  // Staff helpers (best effort, compatible with older builds)
  function getAllHandymen(){
    // Attempt to read staff list; fallback to empty
    const list = [];
    try {
      // Some builds expose peeps via context.getAllEntities(); we’ll do a tile scan fallback: not cheap, but rare.
      // Safer: use park.staff if present.
      if (park && park.staff){
        for (const s of park.staff){
          if (String(s.type||"").toLowerCase().indexOf("handyman")>=0) list.push(s);
        }
      }
    } catch {}
    return list;
  }

  function getAllMechanics(){
    const list = [];
    try {
      if (park && park.staff){
        for (const s of park.staff){
          if (String(s.type||"").toLowerCase().indexOf("mechanic")>=0) list.push(s);
        }
      }
    } catch {}
    return list;
  }

  function tryHireStaff(role, count){
    let hired=0;
    for (let i=0;i<count;i++){
      try{
        const res = context.executeAction("hire_staff", { type: role });
        if (res && res.error) break;
        hired++;
      } catch {}
    }
    return hired;
  }

  function ensureHandymen(count){
    const list = getAllHandymen();
    if (list.length >= count) return { list: list.slice(0,count), hired: 0 };
    if (Settings.staffInsufficient === "Auto-hire"){
      const hired = tryHireStaff("handyman", count - list.length);
      const after = getAllHandymen();
      return { list: after.slice(0,count), hired };
    }
    return { list: list.slice(0,count), hired: 0 };
    // "Stretch zones" is implicit in planning; "Assign only existing" uses partial list.
  }

  function ensureMechanics(count){
    const list = getAllMechanics();
    if (list.length >= count) return { list: list.slice(0,count), hired: 0 };
    if (Settings.staffInsufficient === "Auto-hire"){
      const hired = tryHireStaff("mechanic", count - list.length);
      const after = getAllMechanics();
      return { list: after.slice(0,count), hired };
    }
    return { list: list.slice(0,count), hired: 0 };
  }

  function trySetPatrolArea(staff, tileIdSet){
    // API varies by build; you might have staff.setPatrol(tileX,tileY,true)
    // or a patrolArea bitmap per staff. We guard everything.
    try {
      if (staff && typeof staff.clearPatrolArea === "function") staff.clearPatrolArea();
      for (const id of tileIdSet){
        const n = Plan.nodes[id];
        // Common patterns: staff.addPatrolTile(x,y) or staff.setPatrol(x,y, true)
        if (typeof staff.addPatrolTile === "function") staff.addPatrolTile(n.x, n.y);
        else if (typeof staff.setPatrol === "function") staff.setPatrol(n.x, n.y, true);
        else if (staff.patrolArea){
          // Some builds expose a 2D array or map; we attempt direct set
          if (!staff.patrolArea[key(n.x,n.y)]) staff.patrolArea[key(n.x,n.y)] = true;
        } else {
          // Not supported
          return false;
        }
      }
      return true;
    } catch { return false; }
  }

  function tryMoveStaffTo(staff, x, y){
    try {
      if (!staff) return false;
      if (typeof staff.setPosition === "function"){ staff.setPosition({x:x*32+16,y:y*32+16}); return true; }
      if (typeof staff.moveTo === "function"){ staff.moveTo({x:x*32+16,y:y*32+16}); return true; }
      // No direct move; pan viewport to help the user place manually
      viewportPanTo(x,y,0);
      return false;
    } catch { return false; }
  }

})();
