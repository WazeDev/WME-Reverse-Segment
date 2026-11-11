// ==UserScript==
// @name         WME Reverse Segment
// @description  Reverses a selected segment's geometry and swaps all direction-dependent attributes (direction, speed limits, lanes, turns, lane guidance, turn guidance, traffic lights, speed cameras).
// @namespace    https://github.com/WazeDev/WME-Reverse-Segment
// @license      MIT
// @version      1.0.0
// @match        /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor\/?.*$/
// @include      /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor\/?.*$/
// @exclude      *://*.waze.com/user/editor*
// @exclude      *://*.waze.com/editor/sdk/*
// @require      https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js
// @grant        none
// ==/UserScript==

/* global WazeWrap, getWmeSdk */
// for...of and continue are fine in a userscript (no transpiling, so airbnb's regenerator-runtime concern doesn't apply)
/* eslint no-restricted-syntax: ["error", "ForInStatement", "LabeledStatement", "WithStatement"] */
/* eslint-disable no-continue */

(function main() {
  "use strict";

  const SCRIPT_NAME = "WME Reverse Segment";
  const SCRIPT_VERSION = GM_info.script.version;
  const STORAGE_KEY = "wme-reverse-segment";

  const changeLog = [
    { version: "0.9.1", message: "Initial version." },
    { version: "0.10.0", message: "Traffic lights and speed cameras are kept on the same spot with flipped direction." },
    { version: "0.11.0", message: "Turn guidance (TTS, road shields, exit signs, towards, visual instructions), traffic light guidance settings and turn restrictions are now restored." },
    { version: "0.11.1", message: "Fixed reversing next to segments with closures (skip them)." },
    { version: "0.12.0", message: "Keyboard shortcut for Flip A/B (default Alt+R, can be changed in the WME keyboard shortcuts)." },
    { version: "0.12.1", message: "Fixed \"illegal turn\" on save after switching a segment to one-way before reversing." },
    { version: "1.0.0", message: "First public release on Greasy Fork." },
  ];

  // ---------------------------------------------------------------------------
  // Action class cache + am.add hook
  // ConnectSegment, DisconnectSegment and SetTurn are private to the editor
  // bundle. The hook caches them automatically as soon as any matching action
  // runs. One manual connect/turn per session is enough to seed the cache.
  // ---------------------------------------------------------------------------
  let W = null;
  let am = null;

  const _classCache = {};
  function _cache(a) {
    if (!a || !a.constructor) return;
    if (!_classCache[a.constructor.name]) _classCache[a.constructor.name] = a.constructor;
    if (a.subActions) for (const s of a.subActions) _cache(s);
  }

  function getActionClass(name) {
    if (_classCache[name]) return _classCache[name];
    for (const stack of [am._undoStack, am._redoStack]) for (const a of stack) _cache(a);
    return _classCache[name] || null;
  }

  // Replace all undo stack entries added since `start` by one CompositeAction,
  // so the whole operation is a single undo/redo step. The group is pushed via
  // am.add so WME fires its usual events (undo counter etc.); its doAction is a
  // no-op because the wrapped actions are already done. Undo/redo use the
  // inherited undoAction/redoAction, which walk the subActions.
  // Undoing/redoing all subActions in one event batch leaves the map showing a
  // stale segment, so am._undoAction/_redoAction are patched (see bootstrap) to
  // process each subAction on its own first, like separate undo steps would.
  let GroupAction = null;

  function patchUndoForGroups() {
    if (am.__wrsUndoPatched) return;
    const origUndoAction = am._undoAction;
    am._undoAction = function wrsUndoAction(action, opts) {
      if (!GroupAction || !(action instanceof GroupAction) || !this.canUndoAction(action)) return origUndoAction.call(this, action, opts);
      for (let i = action.subActions.length - 1; i >= 0; i--) {
        const sub = action.subActions[i];
        this._undoStack.push(sub);
        origUndoAction.call(this, sub, { supportRedo: false });
      }
      action._subActionsDone = true;
      try { return origUndoAction.call(this, action, opts); } finally { action._subActionsDone = false; }
    };

    const origRedoAction = am._redoAction;
    am._redoAction = function wrsRedoAction(action, ...rest) {
      if (!GroupAction || !(action instanceof GroupAction) || !this.canRedoAction(action)) return origRedoAction.call(this, action, ...rest);
      for (const sub of action.subActions) {
        this._redoStack.push(sub);
        origRedoAction.call(this, sub);
        this._undoStack.splice(this._undoStack.indexOf(sub), 1);
      }
      action._subActionsDone = true;
      try { return origRedoAction.call(this, action, ...rest); } finally { action._subActionsDone = false; }
    };
    am.__wrsUndoPatched = true;
  }

  function groupActionsSince(start, description) {
    const added = am._undoStack.slice(start);
    if (added.length < 2) return;

    if (!GroupAction) {
      let Composite = null;
      for (let c = added[0].constructor; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) if (c.name === "CompositeAction") { Composite = c; break; }
      if (!Composite) { console.warn("[WME RS] CompositeAction class not found – undo steps not grouped."); return; }
      GroupAction = class ReverseSegmentAction extends Composite {
        // eslint-disable-next-line class-methods-use-this
        doAction() { return true; }
        undoAction(dm) { if (!this._subActionsDone) super.undoAction(dm); }
        redoAction(dm) { if (!this._subActionsDone) super.redoAction(dm); }
      };
    }

    am._undoStack.splice(start, added.length);
    am.add(new GroupAction({ _description: description, description }, added));
  }

  const samePt = (a, b, eps = 1e-7) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;

  // ---------------------------------------------------------------------------
  // connectEndToEnd
  // ---------------------------------------------------------------------------
  function connectEndToEnd(segIdA, segIdB, sdk, createDefaultTurns = true) {
    const ConnectSegment = getActionClass("ConnectSegment");
    const DisconnectSegment = getActionClass("DisconnectSegment");
    if (!ConnectSegment || !DisconnectSegment) {
      console.warn("[WME RS] Action classes not cached yet. Manually connect two segments once to seed the cache.");
      return;
    }

    const segA = W.model.segments.objects[segIdA];
    const segB = W.model.segments.objects[segIdB];
    if (!segA || !segB) { console.warn("[WME RS] Segment(s) not found:", segIdA, segIdB); return; }

    const gA = segA.getGeometry();
    const gB = segB.getGeometry();
    const lastA = gA.coordinates.length - 1;
    const lastB = gB.coordinates.length - 1;

    let aWhich = null;
    let bWhich = null;
    for (const [ai, aw] of [[0, "fromNodeID"], [lastA, "toNodeID"]]) {
      if (samePt(gA.coordinates[ai], gB.coordinates[0])) { aWhich = aw; bWhich = "fromNodeID"; break; }
      if (samePt(gA.coordinates[ai], gB.coordinates[lastB])) { aWhich = aw; bWhich = "toNodeID"; break; }
    }
    if (!aWhich) { console.warn("[WME RS] No overlapping endpoint found."); return; }

    const aNode = W.model.nodes.objects[segA.getAttribute(aWhich)];
    const bNode = W.model.nodes.objects[segB.getAttribute(bWhich)];
    if (aNode === bNode) return;

    if (!aNode || !bNode) throw new Error(`node missing while connecting ${segIdA} -> ${segIdB}`);

    const run = () => {
      am.add(new DisconnectSegment(segA, aNode, { deleteNode: true }));
      am.add(new ConnectSegment(bNode, segA, { createDefaultTurns }));
    };

    if (sdk && sdk.Editing && sdk.Editing.doActions) sdk.Editing.doActions(run, "Connect segments end-to-end");
    else run();

    // ConnectSegment reports success even when WME skips it (e.g. read-only node)
    if (segA.getAttribute(aWhich) !== bNode.getID()) throw new Error(`segment ${segIdA} could not be connected to node ${bNode.getID()}`);
  }

  // ---------------------------------------------------------------------------
  // Internal turn data
  // The SDK only exposes flags for turn guidance (TTS, shields, ...), not the
  // data itself. The internal TurnData holds everything (state, lanes, turn
  // guidance, map entity guidance, restrictions) and is copied as a whole.
  // ---------------------------------------------------------------------------
  const GUIDANCE_FLAGS = {
    hasCustomTTS: "TTS",
    hasShieldsPopulated: "road shields",
    hasTowardsGuidance: "towards",
    hasTurnGuidance: "turn guidance",
    hasVisualInstruction: "visual instruction",
  };

  function getInternalTurn(fromSegmentId, fromFwd, toSegmentId, toFwd) {
    const tg = W.model.turnGraph;
    const anyTurn = tg.getAllTurns()[0];
    if (!anyTurn) return null;
    const Vertex = anyTurn.getFromVertex().constructor;
    const dir = fwd => (fwd ? "fwd" : "rev");
    return tg.getTurn(new Vertex(fromSegmentId, dir(fromFwd)), new Vertex(toSegmentId, dir(toFwd)));
  }

  // Map entity guidance = traffic light / sign "Show"/"At" settings
  const countEntityGuidance = turnData => (turnData?.getMapEntitiesGuidance?.() ?? []).filter(e => !(e.isEffectivelyDefault?.() ?? false)).length;

  const countRestrictions = turnData => (turnData?.getRestrictions?.() ?? turnData?.restrictions ?? []).length;

  // ---------------------------------------------------------------------------
  // Preconditions
  // Both end nodes are disconnected and reconnected, so they must be fully
  // editable as well. A connected segment locked above the editor's rank makes
  // its node read-only, and WME then silently skips the reconnect.
  // ---------------------------------------------------------------------------
  // eslint-disable-next-line no-bitwise
  const NODE_EDIT_FLAGS = 1 | 4 | 8; // EDIT_GEOMETRY | EDIT_OPEN_TURNS | EDIT_CLOSE_TURNS

  // Returns why the segment can't be reversed, or null if it can
  function getReverseBlocker(segmentId, sdk) {
    const segment = sdk.DataModel.Segments.getById({ segmentId });
    if (!segment) return "segment not found";
    if (sdk.DataModel.Segments.connectsToBigJunction({ segmentId })) return "segment is part of a big junction";
    if (!sdk.DataModel.Segments.hasPermissions({ segmentId })) return "insufficient permissions";
    if (segment.hasClosures) return "segment has active closures";
    for (const nodeId of [segment.fromNodeId, segment.toNodeId]) {
      if (nodeId == null) continue;
      const node = W.model.nodes.getObjectById(nodeId);
      if (!node) return `node ${nodeId} is not loaded`;
      for (const segId of node.getAttribute("segIDs") || []) {
        if (segId === +segmentId) continue;
        if (sdk.DataModel.Segments.getById({ segmentId: segId })?.hasClosures) return `connected segment ${segId} has closures`;
      }
      // eslint-disable-next-line no-bitwise
      if ((node.getAttribute("permissions") & NODE_EDIT_FLAGS) !== NODE_EDIT_FLAGS) return `insufficient permissions on node ${nodeId} (a connected segment is not fully editable)`;
      for (const segId of node.getAttribute("segIDs") || []) if (!W.model.segments.getObjectById(segId)) return `connected segment ${segId} is not loaded`;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // reverseSegment
  // ---------------------------------------------------------------------------
  function reverseSegment(segmentId, sdk) {
    const blocker = getReverseBlocker(segmentId, sdk);
    if (blocker) {
      const msg = `Segment ${segmentId} can't be reversed: ${blocker}.`;
      console.log("[WME RS]", msg);
      WazeWrap.Alerts.warning(SCRIPT_NAME, msg);
      return;
    }

    const start = am._undoStack.length;
    try {
      reverseSegmentSteps(segmentId, sdk);
    } catch (e) {
      // Never leave a half reversed segment behind
      console.error("[WME RS] Reverse failed, undoing all changes.", e);
      for (let guard = 1000; am._undoStack.length > start && guard > 0; guard--) am.undo();
      WazeWrap.Alerts.error(SCRIPT_NAME, `Segment ${segmentId} could not be reversed (${e.message}). All changes have been undone.`);
      return;
    }
    groupActionsSince(start, `Reverse segment ${segmentId}`);
  }

  function reverseSegmentSteps(segmentId, sdk) {
    const segment = sdk.DataModel.Segments.getById({ segmentId });

    const { fwdSpeedLimit } = segment;
    const { revSpeedLimit } = segment;
    const { isAtoB } = segment;
    const { isBtoA } = segment;
    const fromLanesInfo = segment.fromLanesInfo ? structuredClone(segment.fromLanesInfo) : null;
    const toLanesInfo = segment.toLanesInfo ? structuredClone(segment.toLanesInfo) : null;

    // Point hazards (traffic lights, speed cameras, ...) are placed relative to the
    // segment direction (traffic lights: REV = A end, FWD = B end). Remember them so
    // they can be put back on the same physical spot with flipped direction afterwards.
    const hazards = W.model.permanentHazards.getObjectArray()
      .filter(h => h.getAttribute("segmentId") === +segmentId && h.getGeometry()?.type === "Point")
      .map(h => ({ id: h.getID(), direction: h.getAttribute("direction"), geometry: structuredClone(h.getGeometry()) }));

    const { Turns } = sdk.DataModel;

    const grabTurn = t => {
      const turnData = getInternalTurn(t.fromSegmentId, t.fromSegmentFwd, t.toSegmentId, t.toSegmentFwd)?.getTurnData() ?? null;
      return {
        id: t.id,
        isAllowed: t.isAllowed,
        fromSegmentId: t.fromSegmentId,
        fromSegmentFwd: t.fromSegmentFwd,
        toSegmentId: t.toSegmentId,
        toSegmentFwd: t.toSegmentFwd,
        lanes: t.lanes ? structuredClone(t.lanes) : null,
        hasCustomTTS: t.hasCustomTTS,
        hasShieldsPopulated: t.hasShieldsPopulated,
        hasTowardsGuidance: t.hasTowardsGuidance,
        hasTurnGuidance: t.hasTurnGuidance,
        hasVisualInstruction: t.hasVisualInstruction,
        // Snapshot before anything is changed (lane counts are cleared below)
        turnData,
        entityGuidance: countEntityGuidance(turnData),
        restrictions: countRestrictions(turnData),
      };
    };
    const allTurns = [
      ...Turns.getTurnsFromSegment({ segmentId }),
      ...Turns.getTurnsToSegment({ segmentId }),
    ].map(grabTurn);

    const fromTurns = allTurns.filter(t => t.fromSegmentId === segmentId);
    const sides = [
      {
        name: "A_TO_B",
        captureDir: "A_TO_B",
        restoreDir: "B_TO_A",
        laneCount: segment.fromNodeLanesCount,
        turns: fromTurns.filter(t => t.fromSegmentFwd === true),
      },
      {
        name: "B_TO_A",
        captureDir: "B_TO_A",
        restoreDir: "A_TO_B",
        laneCount: segment.toNodeLanesCount,
        turns: fromTurns.filter(t => t.fromSegmentFwd === false),
      },
    ];

    // Clear lane counts before disconnect (only if non-zero)
    for (const side of sides) {
      if (side.laneCount === 0) continue;
      try { Turns.setSegmentTurnsLaneCount({ segmentId, laneDirection: side.captureDir, laneCount: 0 }); } catch (e) { console.warn("[WME RS] clear lane count", side.name, e); }
    }

    // Collect neighbours before disconnecting
    const neighborIds = new Set();
    for (const nodeId of [segment.fromNodeId, segment.toNodeId]) {
      if (nodeId == null) continue;
      const node = sdk.DataModel.Nodes.getById({ nodeId });
      if (!node) continue;
      for (const segId of (node.connectedSegmentIds || [])) if (segId !== segmentId) neighborIds.add(segId);
    }

    // Shift endpoints to disconnect both nodes
    const endpointsMoved = structuredClone(segment.geometry);
    const c = endpointsMoved.coordinates;
    const last = c.length - 1;
    c[0] = [c[0][0] + 0.0001, c[0][1]];
    c[last] = [c[last][0] + 0.0001, c[last][1]];
    sdk.DataModel.Segments.updateSegment({ segmentId, geometry: endpointsMoved });

    // Reversed geometry + swap all direction-dependent attributes
    const inverted = structuredClone(segment.geometry);
    inverted.coordinates.reverse();
    {
      const update = { segmentId, geometry: inverted };
      if (isAtoB) update.direction = "B_TO_A";
      else if (isBtoA) update.direction = "A_TO_B";
      if (fromLanesInfo != null || toLanesInfo != null) {
        update.fromLanesInfo = toLanesInfo;
        update.toLanesInfo = fromLanesInfo;
      }
      if (fwdSpeedLimit !== revSpeedLimit) {
        update.fwdSpeedLimit = revSpeedLimit;
        update.revSpeedLimit = fwdSpeedLimit;
      }
      sdk.DataModel.Segments.updateSegment(update);
    }

    // Reconnect to all original neighbours (turns restored below)
    for (const neighborId of neighborIds) connectEndToEnd(segmentId, neighborId, sdk, false);

    // Flip hazard direction and pin it to its original position. Runs last, because
    // WME re-snaps hazards (e.g. speed cameras) while turns and lanes are restored.
    const restoreHazards = () => {
      if (!hazards.length) return;
      const UpdateObject = getActionClass("UpdateObject");
      if (!UpdateObject) { console.warn("[WME RS] UpdateObject class not cached – hazards not restored."); return; }
      for (const hz of hazards) {
        const hazard = W.model.permanentHazards.getObjectById(hz.id);
        if (!hazard) { console.warn("[WME RS] hazard not found:", hz.id); continue; }
        const attrs = { geoJSONGeometry: hz.geometry };
        const direction = { FWD: "REV", REV: "FWD" }[hz.direction];
        if (direction) attrs.direction = direction;
        try { am.add(new UpdateObject(hazard, attrs)); } catch (e) { console.warn("[WME RS] hazard", hz.id, e); }
      }
    };

    // Direction flags of a turn after reverse (only the reversed segment flips)
    const newFwd = (segId, fwd) => (segId === +segmentId ? !fwd : fwd);

    // Turns against a one-way direction keep their allowed state in WME (e.g. after
    // switching a segment to one-way), but setting them explicitly is rejected on
    // save ("illegal turn"). Only restore turns that can be driven after reverse.
    // Unknown direction (neither A->B nor B->A) counts as drivable.
    const isDrivable = (segId, fwd) => {
      const s = sdk.DataModel.Segments.getById({ segmentId: segId });
      if (!s || s.isTwoWay || (!s.isAtoB && !s.isBtoA)) return true;
      return fwd ? s.isAtoB : s.isBtoA;
    };
    const isRestorable = old => old.isAllowed
      && isDrivable(old.fromSegmentId, newFwd(old.fromSegmentId, old.fromSegmentFwd))
      && isDrivable(old.toSegmentId, newFwd(old.toSegmentId, old.toSegmentFwd));

    // Compare the restored turns with the snapshot and warn about anything lost
    const verifyTurns = () => {
      const newTurns = [
        ...Turns.getTurnsFromSegment({ segmentId }),
        ...Turns.getTurnsToSegment({ segmentId }),
      ];
      const lost = new Set();
      for (const old of allTurns) {
        if (!isRestorable(old)) continue;
        const fromFwd = newFwd(old.fromSegmentId, old.fromSegmentFwd);
        const toFwd = newFwd(old.toSegmentId, old.toSegmentFwd);
        const now = newTurns.find(t => t.fromSegmentId === old.fromSegmentId && t.fromSegmentFwd === fromFwd
          && t.toSegmentId === old.toSegmentId && t.toSegmentFwd === toFwd);
        if (!now || !now.isAllowed) { lost.add("allowed turns"); continue; }
        for (const [flag, label] of Object.entries(GUIDANCE_FLAGS)) if (old[flag] && !now[flag]) lost.add(label);
        const turnData = getInternalTurn(old.fromSegmentId, fromFwd, old.toSegmentId, toFwd)?.getTurnData();
        if (countEntityGuidance(turnData) < old.entityGuidance) lost.add("traffic light guidance");
        if (countRestrictions(turnData) < old.restrictions) lost.add("turn restrictions");
      }
      if (!lost.size) return;
      const msg = `Segment ${segmentId}: could not restore ${[...lost].join(", ")}. Please check the turns or undo.`;
      console.warn("[WME RS]", msg);
      WazeWrap.Alerts.warning(SCRIPT_NAME, msg);
    };

    // Restore allowed turns including all turn data (guidance, restrictions, ...)
    const SetTurn = getActionClass("SetTurn");
    if (!SetTurn) { console.warn("[WME RS] SetTurn class not cached. Manually set a turn once to seed the cache."); restoreHazards(); verifyTurns(); return; }

    const tg = W.model.turnGraph;
    const newIdByOld = new Map();

    for (const old of allTurns) {
      if (!isRestorable(old)) continue;
      const existing = getInternalTurn(
        old.fromSegmentId,
        newFwd(old.fromSegmentId, old.fromSegmentFwd),
        old.toSegmentId,
        newFwd(old.toSegmentId, old.toSegmentFwd),
      );
      if (!existing) { console.warn("[WME RS] turn not in graph:", old.fromSegmentId, "->", old.toSegmentId); continue; }
      let restored = null;
      if (old.turnData) {
        try {
          restored = existing.withTurnData(old.turnData.withState(1));
          am.add(new SetTurn(tg, restored, {}));
        } catch (e) {
          console.warn("[WME RS] SetTurn with original turn data", old.fromSegmentId, "->", old.toSegmentId, e);
          restored = null;
        }
      }
      // Fallback: at least allow the turn
      if (!restored) {
        try {
          restored = existing.withTurnData(existing.getTurnData().withState(1));
          am.add(new SetTurn(tg, restored, {}));
        } catch (e) { console.warn("[WME RS] SetTurn", old.fromSegmentId, "->", old.toSegmentId, e); continue; }
      }
      newIdByOld.set(old.id, restored.getID());
    }

    // Restore lane counts and lane guidance per direction
    for (const side of sides) {
      if (side.turns.length === 0) continue;
      try { Turns.setSegmentTurnsLaneCount({ segmentId, laneDirection: side.restoreDir, laneCount: side.laneCount }); } catch (e) { console.warn("[WME RS] setSegmentTurnsLaneCount", side.name, e); }

      for (const old of side.turns) {
        if (!old.lanes || !isRestorable(old)) continue;
        const newTurnId = newIdByOld.get(old.id);
        if (!newTurnId) { console.warn("[WME RS] no new turn ID for", old.id); continue; }
        const laneIndexes = [];
        for (let i = old.lanes.fromLaneIndex; i <= old.lanes.toLaneIndex; i++) laneIndexes.push(i);
        try { Turns.setTurnLaneGuidance({ turnId: newTurnId, laneIndexes }); } catch (e) { console.warn("[WME RS] setTurnLaneGuidance", newTurnId, e); }
      }
    }

    restoreHazards();
    verifyTurns();
  }

  // ---------------------------------------------------------------------------
  // UI injection
  // ---------------------------------------------------------------------------
  let sdk = null;

  const INFO_TIP = "Reverses the selected segment's geometry and swaps direction-dependent attributes (direction, speed limits, lanes, "
    + "turns incl. turn guidance and restrictions, traffic lights, speed cameras). Not supported for segments that are part of a big junction, "
    + "a path, has closures or you can't fully edit (both also apply to the segments connected to it).";

  function injectButton() {
    // Only inject when a single segment is selected and panel is present
    const panel = document.querySelector(".segment-edit-section");
    if (!panel) return;
    if (document.getElementById("wrs-container")) return;

    // Find the anchor element to insert after
    const levelSelect = panel.querySelector(".segment-level-select");
    if (!levelSelect) return;

    const container = document.createElement("div");
    container.id = "wrs-container";
    container.innerHTML = `
      <wz-label>Reverse Segment</wz-label>
      <div style="display:flex; flex-direction:row; align-items:center; margin: 0 5px;">
        <wz-button color="secondary" size="sm" id="wrs-btn">
          <i class="w-icon w-icon-switch"></i>
          Flip A/B
        </wz-button>
        <span class="wrs-info" style="margin-left:0.5rem;" role="button" tabindex="0"
              data-tip="${INFO_TIP}">
          <i class="w-icon w-icon-info" style="font-size:1.25rem;"></i>
        </span>
        <span id="wrs-reason" class="wrs-reason" hidden></span>
      </div>
    `;

    levelSelect.insertAdjacentElement("afterend", container);

    container.querySelectorAll(".wrs-info").forEach(setupInfoTooltip);

    const btn = document.getElementById("wrs-btn");
    const selected = sdk.Editing.getSelection();
    if (selected && selected.ids.length === 1) {
      const blocker = getReverseBlocker(selected.ids[0], sdk);
      if (blocker) {
        btn.setAttribute("disabled", "true");
        // Disabled buttons may not receive hover events, so the row carries the title too
        btn.title = blocker;
        btn.parentElement.title = blocker;
        const reason = document.getElementById("wrs-reason");
        reason.textContent = blocker.charAt(0).toUpperCase() + blocker.slice(1);
        reason.hidden = false;
      }
    }

    btn.addEventListener("click", flipSelectedSegment);
  }

  function flipSelectedSegment() {
    if (!sdk) { console.warn("[WME RS] SDK not ready."); return; }
    const selected = sdk.Editing.getSelection();
    if (!selected || selected.objectType !== "segment" || selected.ids.length !== 1) {
      WazeWrap.Alerts.info(SCRIPT_NAME, "Please select exactly one segment.");
      return;
    }
    // Shows why the segment can't be reversed, if so
    reverseSegment(selected.ids[0], sdk);
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcut
  // Registered via the SDK, so it shows up in (and can be changed via) the WME
  // keyboard shortcuts dialog. Changed keys are saved when the dialog changes
  // and on unload, and restored on the next start.
  // ---------------------------------------------------------------------------
  const SHORTCUT_ID = "wme-reverse-segment-flip";
  const SHORTCUT_DESCRIPTION = "Flip A/B of the selected segment";
  const DEFAULT_SHORTCUT_KEYS = "A+82"; // Alt+R

  function initShortcut() {
    const shortcut = {
      shortcutId: SHORTCUT_ID,
      description: SHORTCUT_DESCRIPTION,
      shortcutKeys: loadSettings().shortcutKeys ?? DEFAULT_SHORTCUT_KEYS,
      callback: flipSelectedSegment,
    };
    try {
      if (shortcut.shortcutKeys && sdk.Shortcuts.areShortcutKeysInUse({ shortcutKeys: shortcut.shortcutKeys })) {
        console.warn("[WME RS] Shortcut keys already in use:", shortcut.shortcutKeys);
        shortcut.shortcutKeys = null;
      }
      sdk.Shortcuts.createShortcut(shortcut);
    } catch (e) {
      console.warn("[WME RS] Failed to create shortcut, registering it without keys.", e);
      try { sdk.Shortcuts.createShortcut({ ...shortcut, shortcutKeys: null }); } catch (e2) { console.error("[WME RS] createShortcut", e2); }
    }

    window.addEventListener("beforeunload", saveShortcut);

    // Save right away when the keys are changed in the keyboard shortcuts dialog
    document.addEventListener("click", e => {
      if (!e.target.closest?.("#keyboard-dialog-link")) return;
      setTimeout(() => {
        const dialog = document.querySelector("#wz-dialog-container");
        if (dialog) new MutationObserver(saveShortcut).observe(dialog, { subtree: true, childList: true, characterData: true });
      }, 100);
    });
  }

  function saveShortcut() {
    let current;
    try { current = sdk.Shortcuts.getAllShortcuts().find(s => s.shortcutId === SHORTCUT_ID); } catch (e) { return; }
    if (!current) return;
    const keys = formatShortcutKeys(current.shortcutKeys);
    const settings = loadSettings();
    if (settings.shortcutKeys === keys) return;
    settings.shortcutKeys = keys;
    saveSettings(settings);
  }

  // getAllShortcuts returns "<modifiers>,<keyCode>" (e.g. "1,81"), createShortcut
  // expects "<C|S|A>+<keyCode>" (e.g. "C+81"), see
  // https://www.waze.com/editor/sdk/interfaces/index.SDK.KeyboardShortcut.html#shortcutkeys
  function formatShortcutKeys(input) {
    if (!input) return "";
    if (!input.includes(",")) return input;
    const [mods, key] = input.split(",");
    const m = parseInt(mods, 10);
    if (!m) return key;
    // eslint-disable-next-line no-bitwise
    const prefix = (m & 1 ? "C" : "") + (m & 2 ? "S" : "") + (m & 4 ? "A" : "");
    return `${prefix}+${key}`;
  }

  // ---------------------------------------------------------------------------
  // Settings (localStorage)
  // ---------------------------------------------------------------------------
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (e) { return {}; }
  }

  function saveSettings(settings) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* storage unavailable */ }
  }

  // ---------------------------------------------------------------------------
  // Info tooltips: shown on hover, pinned on click/tap, closed on outside click or Esc
  // ---------------------------------------------------------------------------
  let tipEl = null;
  let tipOwner = null;
  let tipPinned = false;

  function showTip(owner) {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = "wrs-tooltip";
      document.body.appendChild(tipEl);
    }
    tipOwner = owner;
    tipEl.textContent = owner.dataset.tip;
    tipEl.style.display = "block";

    // Position below the icon (above if no room), clamped to the viewport
    const r = owner.getBoundingClientRect();
    const t = tipEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 8));
    let top = r.bottom + 6;
    if (top + t.height > window.innerHeight - 8) top = r.top - t.height - 6;
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top}px`;
  }

  function hideTip() {
    if (tipEl) tipEl.style.display = "none";
    tipOwner = null;
    tipPinned = false;
  }

  function setupInfoTooltip(el) {
    el.addEventListener("mouseenter", () => { if (!tipPinned) showTip(el); });
    el.addEventListener("mouseleave", () => { if (!tipPinned) hideTip(); });
    const toggle = e => {
      e.preventDefault();
      e.stopPropagation();
      if (tipPinned && tipOwner === el) { hideTip(); return; }
      showTip(el);
      tipPinned = true;
    };
    el.addEventListener("click", toggle);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") toggle(e); });
  }

  document.addEventListener("click", e => {
    if (tipPinned && !tipEl?.contains(e.target)) hideTip();
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") hideTip(); });

  function injectStyles() {
    if (document.getElementById("wrs-styles")) return;
    const style = document.createElement("style");
    style.id = "wrs-styles";
    style.textContent = `
      .wrs-info { display:inline-flex; align-items:center; cursor:pointer; }
      .wrs-info:focus-visible { outline:2px solid var(--primary, #0075e3); border-radius:50%; }
      .wrs-reason {
        flex:1; min-width:0; margin-left:0.5rem;
        font-size:11px; line-height:1.3; white-space:normal; overflow-wrap:anywhere;
        color:var(--content_p2, #72767d);
      }
      #wrs-tooltip {
        display:none; position:fixed; z-index:10000; max-width:260px;
        padding:6px 10px; border-radius:6px;
        background:var(--background_default_inverse, #202124);
        color:var(--content_default_inverse, #fff);
        font-size:12px; line-height:1.4;
        box-shadow:0 2px 8px rgba(0,0,0,.3);
      }
    `;
    document.head.appendChild(style);
  }

  function removeButton() {
    hideTip();
    const el = document.getElementById("wrs-container");
    if (el) el.remove();
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  async function bootstrap() {
    await window.SDK_INITIALIZED;

    W = window.W;
    am = W.model.actionManager;

    // Install am.add hook now that am is available
    if (!am.__wmeToolsHooked) {
      const _origAdd = am.add.bind(am);
      am.add = function wrsAdd(action) {
        const r = _origAdd(action);
        try { _cache(action); } catch (e) { /* caching is best effort */ }
        return r;
      };
      am.__wmeToolsHooked = true;
    }
    patchUndoForGroups();

    sdk = getWmeSdk({ scriptId: "wme-reverse-segment", scriptName: SCRIPT_NAME });

    await new Promise(resolve => {
      if (sdk.State.isReady()) resolve();
      else sdk.Events.once({ eventName: "wme-ready" }).then(resolve);
    });

    sdk.Events.on({
      eventName: "wme-selection-changed",
      eventHandler: () => {
        removeButton();
        const sel = sdk.Editing.getSelection();
        if (sel && sel.objectType === "segment" && sel.ids.length === 1) {
          setTimeout(injectButton, 300);
        }
      },
    });

    console.log("[WME RS] WME Reverse Segment ready.");

    // Expose reverseSegment on window for manual console use
    window.wmeRS = {
      reverseSegment: segmentId => reverseSegment(segmentId, sdk),
    };

    initShortcut();
    showChangeLog();
  }

  // ---------------------------------------------------------------------------
  // Changelog: shows the entries newer than the last seen version once per update
  // ---------------------------------------------------------------------------
  function compareVersions(a, b) {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function showChangeLog() {
    if (!WazeWrap?.Ready) { setTimeout(showChangeLog, 200); return; }

    const settings = loadSettings();
    const previousVersion = settings.version;
    if (previousVersion === SCRIPT_VERSION) return;

    // Fresh install or unknown previous version: only show the current release
    const entries = previousVersion
      ? changeLog.filter(c => compareVersions(c.version, previousVersion) > 0 && compareVersions(c.version, SCRIPT_VERSION) <= 0)
      : changeLog.filter(c => c.version === SCRIPT_VERSION);

    if (entries.length) {
      const html = `<ul>${entries.map(c => `<li>v${c.version}: ${c.message}</li>`).join("")}</ul>`;
      WazeWrap.Interface.ShowScriptUpdate(SCRIPT_NAME, SCRIPT_VERSION, html, "", "");
    }

    settings.version = SCRIPT_VERSION;
    saveSettings(settings);
  }

  // Inject styles
  injectStyles();
  bootstrap();
})();
