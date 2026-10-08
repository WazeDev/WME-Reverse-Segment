// ==UserScript==
// @name         WME Reverse Segment
// @description  Reverses a selected segment's geometry and swaps all direction-dependent attributes (direction, speed limits, lanes, turns, lane guidance, traffic lights, speed cameras).
// @namespace    https://greasyfork.org/
// @version      0.10.0
// @match        /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor\/?.*$/
// @include      /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor\/?.*$/
// @exclude      *://*.waze.com/user/editor*
// @exclude      *://*.waze.com/editor/sdk/*
// @require      https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js
// @grant        none
// ==/UserScript==

/* global W, getWmeSdk, SDK_INITIALIZED */

(function main() {
  'use strict';

  // ---------------------------------------------------------------------------
  // Action class cache + am.add hook
  // ConnectSegment, DisconnectSegment and SetTurn are private to the editor
  // bundle. The hook caches them automatically as soon as any matching action
  // runs. One manual connect/turn per session is enough to seed the cache.
  // ---------------------------------------------------------------------------
  let W  = null;
  let am = null;

  const _classCache = {};
  function _cache(a) {
    if (!a || !a.constructor) return;
    if (!_classCache[a.constructor.name]) _classCache[a.constructor.name] = a.constructor;
    if (a.subActions) for (const s of a.subActions) _cache(s);
  }

  function getActionClass(name) {
    if (_classCache[name]) return _classCache[name];
    for (const stack of [am._undoStack, am._redoStack])
      for (const a of stack) _cache(a);
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
    am._undoAction = function (action, opts) {
      if (!GroupAction || !(action instanceof GroupAction) || !this.canUndoAction(action))
        return origUndoAction.call(this, action, opts);
      for (let i = action.subActions.length - 1; i >= 0; i--) {
        const sub = action.subActions[i];
        this._undoStack.push(sub);
        origUndoAction.call(this, sub, { supportRedo: false });
      }
      action._subActionsDone = true;
      try { return origUndoAction.call(this, action, opts); }
      finally { action._subActionsDone = false; }
    };

    const origRedoAction = am._redoAction;
    am._redoAction = function (action, ...rest) {
      if (!GroupAction || !(action instanceof GroupAction) || !this.canRedoAction(action))
        return origRedoAction.call(this, action, ...rest);
      for (const sub of action.subActions) {
        this._redoStack.push(sub);
        origRedoAction.call(this, sub);
        this._undoStack.splice(this._undoStack.indexOf(sub), 1);
      }
      action._subActionsDone = true;
      try { return origRedoAction.call(this, action, ...rest); }
      finally { action._subActionsDone = false; }
    };
    am.__wrsUndoPatched = true;
  }

  function groupActionsSince(start, description) {
    const added = am._undoStack.slice(start);
    if (added.length < 2) return;

    if (!GroupAction) {
      let Composite = null;
      for (let c = added[0].constructor; c && c !== Function.prototype; c = Object.getPrototypeOf(c))
        if (c.name === 'CompositeAction') { Composite = c; break; }
      if (!Composite) { console.warn('[WME RS] CompositeAction class not found – undo steps not grouped.'); return; }
      GroupAction = class ReverseSegmentAction extends Composite {
        doAction() { return true; }
        undoAction(dm) { if (!this._subActionsDone) super.undoAction(dm); }
        redoAction(dm) { if (!this._subActionsDone) super.redoAction(dm); }
      };
    }

    am._undoStack.splice(start, added.length);
    am.add(new GroupAction({ _description: description, description }, added));
  }

  const samePt = (a, b, eps = 1e-7) =>
    Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;

  // ---------------------------------------------------------------------------
  // connectEndToEnd
  // ---------------------------------------------------------------------------
  function connectEndToEnd(segIdA, segIdB, sdk, createDefaultTurns = true) {
    const ConnectSegment    = getActionClass('ConnectSegment');
    const DisconnectSegment = getActionClass('DisconnectSegment');
    if (!ConnectSegment || !DisconnectSegment) {
      console.warn('[WME RS] Action classes not cached yet. Manually connect two segments once to seed the cache.');
      return;
    }

    const segA = W.model.segments.objects[segIdA];
    const segB = W.model.segments.objects[segIdB];
    if (!segA || !segB) { console.warn('[WME RS] Segment(s) not found:', segIdA, segIdB); return; }

    const gA = segA.getGeometry(), gB = segB.getGeometry();
    const lastA = gA.coordinates.length - 1, lastB = gB.coordinates.length - 1;

    let aWhich = null, bWhich = null;
    for (const [ai, aw] of [[0, 'fromNodeID'], [lastA, 'toNodeID']]) {
      if (samePt(gA.coordinates[ai], gB.coordinates[0]))     { aWhich = aw; bWhich = 'fromNodeID'; break; }
      if (samePt(gA.coordinates[ai], gB.coordinates[lastB])) { aWhich = aw; bWhich = 'toNodeID';   break; }
    }
    if (!aWhich) { console.warn('[WME RS] No overlapping endpoint found.'); return; }

    const aNode = W.model.nodes.objects[segA.getAttribute(aWhich)];
    const bNode = W.model.nodes.objects[segB.getAttribute(bWhich)];
    if (aNode === bNode) return;

    const run = () => {
      am.add(new DisconnectSegment(segA, aNode, { deleteNode: true }));
      am.add(new ConnectSegment(bNode, segA, { createDefaultTurns }));
    };

    if (sdk && sdk.Editing && sdk.Editing.doActions)
      sdk.Editing.doActions(run, 'Connect segments end-to-end');
    else
      run();
  }

  // Turn guidance of map entities (e.g. traffic light "Show"/"At") lives in the
  // internal turn data only and is lost when the segment is reconnected.
  function findMapEntityGuidance(turns) {
    const tg = W.model.turnGraph;
    const anyTurn = tg.getAllTurns()[0];
    if (!anyTurn) return null;
    const Vertex = anyTurn.getFromVertex().constructor;
    const dir = fwd => (fwd ? 'fwd' : 'rev');
    for (const t of turns) {
      const turn = tg.getTurn(new Vertex(t.fromSegmentId, dir(t.fromSegmentFwd)), new Vertex(t.toSegmentId, dir(t.toSegmentFwd)));
      const entries = turn?.getTurnData()?.getMapEntitiesGuidance?.() ?? [];
      const custom = entries.find(e => !(e.isEffectivelyDefault?.() ?? false));
      if (custom) return { turn: t, entry: custom };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // reverseSegment
  // ---------------------------------------------------------------------------
  function reverseSegment(segmentId, sdk, force = false) {
    const start = am._undoStack.length;
    try { reverseSegmentSteps(segmentId, sdk, force); }
    finally { groupActionsSince(start, `Reverse segment ${segmentId}`); }
  }

  function reverseSegmentSteps(segmentId, sdk, force) {
    const segment = sdk.DataModel.Segments.getById({ segmentId });
    if (!segment) { console.warn('[WME RS] Segment not found:', segmentId); return; }

    if (sdk.DataModel.Segments.connectsToBigJunction({ segmentId })) {
      console.log('[WME RS] Segment', segmentId, 'is part of a big junction – reverse not allowed.');
      return;
    }

    if (!sdk.DataModel.Segments.hasPermissions({ segmentId })) {
      console.log('[WME RS] Segment', segmentId, '– insufficient permissions.');
      return;
    }

    if (segment.hasClosures) {
      console.log('[WME RS] Segment', segmentId, 'has active closures – reverse not allowed.');
      return;
    }

    const fwdSpeedLimit = segment.fwdSpeedLimit;
    const revSpeedLimit = segment.revSpeedLimit;
    const isAtoB        = segment.isAtoB;
    const isBtoA        = segment.isBtoA;
    const fromLanesInfo = segment.fromLanesInfo ? structuredClone(segment.fromLanesInfo) : null;
    const toLanesInfo   = segment.toLanesInfo   ? structuredClone(segment.toLanesInfo)   : null;

    // Point hazards (traffic lights, speed cameras, ...) are placed relative to the
    // segment direction (traffic lights: REV = A end, FWD = B end). Remember them so
    // they can be put back on the same physical spot with flipped direction afterwards.
    const hazards = W.model.permanentHazards.getObjectArray()
      .filter(h => h.getAttribute('segmentId') === +segmentId && h.getGeometry()?.type === 'Point')
      .map(h => ({ id: h.getID(), direction: h.getAttribute('direction'), geometry: structuredClone(h.getGeometry()) }));

    const Turns = sdk.DataModel.Turns;

    const grabTurn = t => ({
      id:                  t.id,
      isAllowed:           t.isAllowed,
      fromSegmentId:       t.fromSegmentId,
      fromSegmentFwd:      t.fromSegmentFwd,
      toSegmentId:         t.toSegmentId,
      toSegmentFwd:        t.toSegmentFwd,
      lanes:               t.lanes ? structuredClone(t.lanes) : null,
      hasCustomTTS:        t.hasCustomTTS,
      hasShieldsPopulated: t.hasShieldsPopulated,
      hasTowardsGuidance:  t.hasTowardsGuidance,
      hasTurnGuidance:     t.hasTurnGuidance,
      hasVisualInstruction: t.hasVisualInstruction,
    });
    const allTurns = [
      ...Turns.getTurnsFromSegment({ segmentId }),
      ...Turns.getTurnsToSegment({ segmentId }),
    ].map(grabTurn);

    // Abort if any turn has guidance data that cannot be restored after reverse,
    // unless the Force checkbox is checked.
    const unsupported = allTurns.find(t =>
      t.hasCustomTTS || t.hasShieldsPopulated || t.hasTowardsGuidance ||
      t.hasTurnGuidance || t.hasVisualInstruction
    );
    if (unsupported && !force) {
      const msg = `Segment ${segmentId} has a turn with guidance data (TTS/shields/visual) that will be lost after reverse. Aborting. Check the "Force" box to execute anyway.`;
      console.log('[WME RS]', msg, '(turn:', unsupported.id, ')');
      WazeWrap.Alerts.warning('WME Reverse Segment', msg);
      return;
    }

    const entityGuidance = force ? null : findMapEntityGuidance(allTurns);
    if (entityGuidance) {
      const msg = `Segment ${segmentId} has a turn with traffic light/sign guidance settings that will be lost after reverse. Aborting. Check the "Force" box to execute anyway.`;
      console.log('[WME RS]', msg, '(turn:', entityGuidance.turn.id, entityGuidance.entry, ')');
      WazeWrap.Alerts.warning('WME Reverse Segment', msg);
      return;
    }

    const fromTurns = allTurns.filter(t => t.fromSegmentId === segmentId);
    const sides = [
      {
        name: 'A_TO_B', captureDir: 'A_TO_B', restoreDir: 'B_TO_A',
        laneCount: segment.fromNodeLanesCount,
        turns: fromTurns.filter(t => t.fromSegmentFwd === true),
      },
      {
        name: 'B_TO_A', captureDir: 'B_TO_A', restoreDir: 'A_TO_B',
        laneCount: segment.toNodeLanesCount,
        turns: fromTurns.filter(t => t.fromSegmentFwd === false),
      },
    ];

    // Clear lane counts before disconnect (only if non-zero)
    for (const side of sides) {
      if (side.laneCount === 0) continue;
      try { Turns.setSegmentTurnsLaneCount({ segmentId, laneDirection: side.captureDir, laneCount: 0 }); }
      catch (e) { console.warn('[WME RS] clear lane count', side.name, e); }
    }

    // Collect neighbours before disconnecting
    const neighborIds = new Set();
    for (const nodeId of [segment.fromNodeId, segment.toNodeId]) {
      if (nodeId == null) continue;
      const node = sdk.DataModel.Nodes.getById({ nodeId });
      if (!node) continue;
      for (const segId of (node.connectedSegmentIds || []))
        if (segId !== segmentId) neighborIds.add(segId);
    }

    // Shift endpoints to disconnect both nodes
    const endpointsMoved = structuredClone(segment.geometry);
    const c = endpointsMoved.coordinates, last = c.length - 1;
    c[0]    = [c[0][0]    + 0.0001, c[0][1]];
    c[last] = [c[last][0] + 0.0001, c[last][1]];
    sdk.DataModel.Segments.updateSegment({ segmentId, geometry: endpointsMoved });

    // Reversed geometry + swap all direction-dependent attributes
    const inverted = structuredClone(segment.geometry);
    inverted.coordinates.reverse();
    {
      const update = { segmentId, geometry: inverted };
      if (isAtoB)      update.direction = 'B_TO_A';
      else if (isBtoA) update.direction = 'A_TO_B';
      if (fromLanesInfo != null || toLanesInfo != null) {
        update.fromLanesInfo = toLanesInfo;
        update.toLanesInfo   = fromLanesInfo;
      }
      if (fwdSpeedLimit !== revSpeedLimit) {
        update.fwdSpeedLimit = revSpeedLimit;
        update.revSpeedLimit = fwdSpeedLimit;
      }
      sdk.DataModel.Segments.updateSegment(update);
    }

    // Reconnect to all original neighbours (turns restored below)
    for (const neighborId of neighborIds)
      connectEndToEnd(segmentId, neighborId, sdk, false);

    // Flip hazard direction and pin it to its original position. Runs last, because
    // WME re-snaps hazards (e.g. speed cameras) while turns and lanes are restored.
    const restoreHazards = () => {
      if (!hazards.length) return;
      const UpdateObject = getActionClass('UpdateObject');
      if (!UpdateObject) { console.warn('[WME RS] UpdateObject class not cached – hazards not restored.'); return; }
      for (const hz of hazards) {
        const hazard = W.model.permanentHazards.getObjectById(hz.id);
        if (!hazard) { console.warn('[WME RS] hazard not found:', hz.id); continue; }
        const attrs = { geoJSONGeometry: hz.geometry };
        const direction = { FWD: 'REV', REV: 'FWD' }[hz.direction];
        if (direction) attrs.direction = direction;
        try { am.add(new UpdateObject(hazard, attrs)); }
        catch (e) { console.warn('[WME RS] hazard', hz.id, e); }
      }
    };

    // Restore allowed turns
    const SetTurn = getActionClass('SetTurn');
    if (!SetTurn) { console.warn('[WME RS] SetTurn class not cached. Manually set a turn once to seed the cache.'); restoreHazards(); return; }

    const tg = W.model.turnGraph;
    const anyTurn = tg.getAllTurns()[0];
    const Vertex = anyTurn ? anyTurn.getFromVertex().constructor : null;
    if (!Vertex) { console.warn('[WME RS] Vertex class not found.'); restoreHazards(); return; }

    const flipDir = fwd => (fwd ? 'rev' : 'fwd');
    const newIdByOld = new Map();

    for (const old of allTurns) {
      if (!old.isAllowed) continue;
      try {
        const fromDir  = old.fromSegmentId === +segmentId ? flipDir(old.fromSegmentFwd) : (old.fromSegmentFwd ? 'fwd' : 'rev');
        const toDir    = old.toSegmentId   === +segmentId ? flipDir(old.toSegmentFwd)   : (old.toSegmentFwd   ? 'fwd' : 'rev');
        const existing = tg.getTurn(new Vertex(old.fromSegmentId, fromDir), new Vertex(old.toSegmentId, toDir));
        if (!existing) { console.warn('[WME RS] turn not in graph:', old.fromSegmentId, '->', old.toSegmentId); continue; }
        const allowed = existing.withTurnData(existing.getTurnData().withState(1));
        am.add(new SetTurn(tg, allowed, {}));
        newIdByOld.set(old.id, allowed.getID());
      } catch (e) { console.warn('[WME RS] SetTurn', old.fromSegmentId, '->', old.toSegmentId, e); }
    }

    // Restore lane counts and lane guidance per direction
    for (const side of sides) {
      if (side.turns.length === 0) continue;
      try { Turns.setSegmentTurnsLaneCount({ segmentId, laneDirection: side.restoreDir, laneCount: side.laneCount }); }
      catch (e) { console.warn('[WME RS] setSegmentTurnsLaneCount', side.name, e); }

      for (const old of side.turns) {
        if (!old.isAllowed || !old.lanes) continue;
        const newTurnId = newIdByOld.get(old.id);
        if (!newTurnId) { console.warn('[WME RS] no new turn ID for', old.id); continue; }
        const laneIndexes = [];
        for (let i = old.lanes.fromLaneIndex; i <= old.lanes.toLaneIndex; i++) laneIndexes.push(i);
        try { Turns.setTurnLaneGuidance({ turnId: newTurnId, laneIndexes }); }
        catch (e) { console.warn('[WME RS] setTurnLaneGuidance', newTurnId, e); }
      }
    }

    restoreHazards();
  }

  // ---------------------------------------------------------------------------
  // UI injection
  // ---------------------------------------------------------------------------
  let sdk = null;

  function injectButton() {
    // Only inject when a single segment is selected and panel is present
    const panel = document.querySelector('.segment-edit-section');
    if (!panel) return;
    if (document.getElementById('wrs-container')) return;

    // Find the anchor element to insert after
    const levelSelect = panel.querySelector('.segment-level-select');
    if (!levelSelect) return;

    const container = document.createElement('div');
    container.id = 'wrs-container';
    container.innerHTML = `
      <wz-label>Reverse Segment</wz-label>
      <div style="display:flex; flex-direction:row; align-items:center; margin: 0 5px;">
        <wz-button color="secondary" size="sm" id="wrs-btn">
          <i class="w-icon w-icon-switch"></i>
          Flip A/B
        </wz-button>
        <span class="wrs-info" style="margin-left:0.5rem;" role="button" tabindex="0"
              data-tip="Reverses the selected segment's geometry and swaps direction-dependent attributes (direction, speed limits, lanes, turns, traffic lights, speed cameras). Not supported for segments that are part of a big junction, a path, has closures or you can't edit (locklevel).">
          <i class="w-icon w-icon-info" style="font-size:1.25rem;"></i>
        </span>
        <wz-checkbox id="wrs-force" style="margin-left:0.75rem;">Force</wz-checkbox>
        <span class="wrs-info" style="margin-left:0.4rem;" role="button" tabindex="0"
              data-tip="TTS, visual instructions, traffic light guidance settings, etc. of turns won't be restored, you can still continue if Force is checked.">
          <i class="w-icon w-icon-info" style="font-size:1.25rem;"></i>
        </span>
      </div>
    `;

    levelSelect.insertAdjacentElement('afterend', container);

    container.querySelectorAll('.wrs-info').forEach(setupInfoTooltip);

    const btn = document.getElementById('wrs-btn');
    const selected = sdk.Editing.getSelection();
    if (selected && selected.ids.length === 1) {
      const selId = selected.ids[0];
      const seg = sdk.DataModel.Segments.getById({ segmentId: selId });
      if (sdk.DataModel.Segments.connectsToBigJunction({ segmentId: selId }) ||
          (seg && seg.hasClosures) ||
          !sdk.DataModel.Segments.hasPermissions({ segmentId: selId })) {
        btn.setAttribute('disabled', 'true');
        document.getElementById('wrs-force')?.setAttribute('disabled', 'true');
      }
    }

    btn.addEventListener('click', () => {
      if (!sdk) { console.warn('[WME RS] SDK not ready.'); return; }
      const selected = sdk.Editing.getSelection();
      if (!selected || selected.objectType !== 'segment' || selected.ids.length !== 1) {
        alert('Please select exactly one segment.');
        return;
      }
      const force = document.getElementById('wrs-force')?.shadowRoot?.querySelector('input[type="checkbox"]')?.checked ?? false;
      reverseSegment(selected.ids[0], sdk, force);
    });
  }

  // ---------------------------------------------------------------------------
  // Info tooltips: shown on hover, pinned on click/tap, closed on outside click or Esc
  // ---------------------------------------------------------------------------
  let tipEl = null;
  let tipOwner = null;
  let tipPinned = false;

  function showTip(owner) {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.id = 'wrs-tooltip';
      document.body.appendChild(tipEl);
    }
    tipOwner = owner;
    tipEl.textContent = owner.dataset.tip;
    tipEl.style.display = 'block';

    // Position below the icon (above if no room), clamped to the viewport
    const r = owner.getBoundingClientRect();
    const t = tipEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 8));
    let top = r.bottom + 6;
    if (top + t.height > window.innerHeight - 8) top = r.top - t.height - 6;
    tipEl.style.left = `${left}px`;
    tipEl.style.top  = `${top}px`;
  }

  function hideTip() {
    if (tipEl) tipEl.style.display = 'none';
    tipOwner = null;
    tipPinned = false;
  }

  function setupInfoTooltip(el) {
    el.addEventListener('mouseenter', () => { if (!tipPinned) showTip(el); });
    el.addEventListener('mouseleave', () => { if (!tipPinned) hideTip(); });
    const toggle = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (tipPinned && tipOwner === el) { hideTip(); return; }
      showTip(el);
      tipPinned = true;
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') toggle(e); });
  }

  document.addEventListener('click', (e) => {
    if (tipPinned && !tipEl?.contains(e.target)) hideTip();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });

  function injectStyles() {
    if (document.getElementById('wrs-styles')) return;
    const style = document.createElement('style');
    style.id = 'wrs-styles';
    style.textContent = `
      .wrs-info { display:inline-flex; align-items:center; cursor:pointer; }
      .wrs-info:focus-visible { outline:2px solid var(--primary, #0075e3); border-radius:50%; }
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
    const el = document.getElementById('wrs-container');
    if (el) el.remove();
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  async function bootstrap() {
    await window.SDK_INITIALIZED;

    W  = window.W;
    am = W.model.actionManager;

    // Install am.add hook now that am is available
    if (!am.__wmeToolsHooked) {
      const _origAdd = am.add.bind(am);
      am.add = function (action) {
        const r = _origAdd(action);
        try { _cache(action); } catch (e) {}
        return r;
      };
      am.__wmeToolsHooked = true;
    }
    patchUndoForGroups();

    sdk = getWmeSdk({ scriptId: 'wme-reverse-segment', scriptName: 'WME Reverse Segment' });

    await new Promise(resolve => {
      if (sdk.State.isReady()) resolve();
      else sdk.Events.once({ eventName: 'wme-ready' }).then(resolve);
    });

    sdk.Events.on({
      eventName: 'wme-selection-changed',
      eventHandler: () => {
        removeButton();
        const sel = sdk.Editing.getSelection();
        if (sel && sel.objectType === 'segment' && sel.ids.length === 1) {
          setTimeout(injectButton, 300);
        }
      },
    });

    console.log('[WME RS] WME Reverse Segment ready.');

    // Expose reverseSegment on window for manual console use
    window.wmeRS = {
      reverseSegment: (segmentId, force = false) => reverseSegment(segmentId, sdk, force),
    };
  }

  // Inject styles
  injectStyles();
  bootstrap();
})();