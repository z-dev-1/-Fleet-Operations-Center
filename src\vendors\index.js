'use strict';
/**
 * vendors/index.js -- Vendor Engine IPC router [V-C]
 *
 * S23-3 (2026-06-28):
 * Registers all vendor: IPC channels, owns the active-workflow registry.
 *
 * HANDLE channels (renderer invokes, main replies):
 *   vendor:start-paccar  { unit }  -> { ok, workflowId, vendor, altId,
 *                                      workRequestId, serviceUrl, isDuplicate }
 *   vendor:start-volvo   { unit }  -> same shape
 *   vendor:approve       { workflowId, altId }  -> { ok }
 *   vendor:cancel        { workflowId }         -> { ok }
 *   vendor:get-status    ()  -> { active: [{workflowId, vendor, unit, startedAt, step}] }
 *
 * SEND channels (main emits to all renderers):
 *   vendor:progress    { vendor, step, ts, ...payload }
 *   vendor:review-ready { workflowId, vendor, unit, altId, serviceUrl, isDuplicate,
 *                         caseNumber, caseUrl }
 *   vendor:complete    { workflowId, vendor, unit, caseNumber, caseUrl, altId, serviceUrl }
 *   vendor:error       { workflowId, vendor, unit, error, code }
 *
 * LIFECYCLE:
 *   1. vendor:start-{vendor} received
 *   2. runRelayStep(unit) -- create/find Relay WO, capture altId (AMZ-...)
 *   3. Orchestrator.run(unit, altId) [paccar/index.js or volvo/index.js S23-4+]
 *   4. Orchestrator emits vendor:review-ready when portal case is ready for review
 *   5. Renderer calls vendor:approve or Vendor:cancel
 *   6. Approve: orchestrator finalises -> vendor:complete
 *
 * CONCURRENCY:
 *   One workflow per unit (equipmentId) at a time.
 *   Duplicate start for same unit -> { ok:false, code:DUPLICATE_WORKFLOW }.
 *   Hard cap MAX_CONCURRENT_WORKFLOWS total concurrent workflows.
 */

const logger   = require("../utils/logger")("vendors");
const { handle, timeoutAfter, requireObject } = require("../ipc/_safe");
const { ConfigError }  = require("../utils/errors");
const { runRelayStep } = require("./base/relay-step");
const { sendToAll, PROGRESS_CHANNEL } = require("./base/vendor-workflow");
const { investigate }     = require("./investigation");
const { enrichVolvoAsist } = require("../scrapers/asist_enrich");

// ============================================================================
// Constants
// ============================================================================

const MAX_CONCURRENT_WORKFLOWS = 5;
// IPC timeout for vendor:start-* -- relay step alone can take 30s (altId poll)
// plus orchestrator run time.  2 min is a safe outer cap.
const WORKFLOW_IPC_TIMEOUT_MS   = 120_000;

// Canonical portal URLs for each vendor.
// Lazy-required orchestrators get these passed to them so they can openPortal().
const PORTAL_URLS = {
  paccar: "https://paccarpg.decisiv.net/service_requests",
  volvo:  "https://volvopg.asist.decisiv.net/service_requests",
};

// ============================================================================
// Active workflow registry
// ============================================================================

// workflowId -> { workflow, vendor, unit, startedAt, step, _resolve, _reject }
// _resolve/_reject let vendor:approve / vendor:cancel signal the waiting run().
const _active = new Map();

// unit equipmentId -> workflowId  (fast dupe check)
const _unitIndex = new Map();

function _genWorkflowId(vendor, equipmentId) {
  const ts  = Date.now().toString(36);
  const uid = Math.random().toString(36).slice(2, 8);
  return vendor + ":" + (equipmentId || "unknown") + ":" + ts + ":" + uid;
}

function _register(workflowId, entry) {
  _active.set(workflowId, entry);
  if (entry.unit && entry.unit.equipmentId) {
    _unitIndex.set(entry.unit.equipmentId, workflowId);
  }
}

function _unregister(workflowId) {
  const entry = _active.get(workflowId);
  if (entry && entry.unit && entry.unit.equipmentId) {
    _unitIndex.delete(entry.unit.equipmentId);
  }
  _active.delete(workflowId);
}

// ============================================================================
// Core workflow runner
// ============================================================================

/**
 * _runVendorWorkflow(vendor, unit)
 * Orchestrates the full vendor workflow for one unit:
 *   relay step -> orchestrator.run() -> emit review-ready / complete / error
 *
 * This function is fire-and-forget from the IPC handler.
 * The IPC handler returns immediately after relay step completes so the
 * renderer gets { workflowId, altId } without waiting for the portal session.
 *
 * @param {string} vendor      paccar | volvo
 * @param {object} unit        unit record from fleet data
 * @param {string} workflowId  pre-allocated workflow ID
 */
async function _runVendorWorkflow(vendor, unit, workflowId) {
  const eqId = unit.equipmentId || unit.id || "unknown";
  logger.info("["+workflowId+"] _runVendorWorkflow start | vendor:", vendor, "| unit:", eqId);

  // Step 2: lazy-require the vendor orchestrator (S23-4 / S23-5)
  // Falls back to stub if orchestrator not yet implemented.
  let Orchestrator;
  try {
    Orchestrator = require("./" + vendor + "/index");
  } catch (_) {
    // Orchestrator module not yet available (S23-3 pre-stub).
    // Signal review-ready immediately with relay data only so the UI
    // can display what we have without hanging forever.
    logger.warn("["+workflowId+"] Orchestrator not found for vendor:", vendor, "-- emitting review-ready with relay data only");
    const entry = _active.get(workflowId);
    if (entry) {
      sendToAll("vendor:review-ready", {
        workflowId,
        vendor,
        unit:        eqId,
        altId:       entry.altId || "",
        serviceUrl:  entry.serviceUrl || "",
        isDuplicate: entry.isDuplicate || false,
        caseNumber:  "",
        caseUrl:     "",
        _stubbed:    true,
      });
      entry.step = "review-ready:stub";
    }
    return;
  }

  // Orchestrator exists -- call run(unit, altId)
  const entry = _active.get(workflowId);
  if (!entry) { logger.warn("["+workflowId+"] entry gone before orchestrator.run -- aborted"); return; }

  let orchestrator;
  try {
    // Orchestrator may export a class or a factory function.
    // Support both: if Orchestrator has a run method statically it is a class,
    // otherwise call it as a factory to get an instance.
    if (typeof Orchestrator === "function" && Orchestrator.prototype && typeof Orchestrator.prototype.run === "function") {
      orchestrator = new Orchestrator(PORTAL_URLS[vendor]);
    } else if (typeof Orchestrator.create === "function") {
      orchestrator = Orchestrator.create(PORTAL_URLS[vendor]);
    } else {
      throw new Error("Orchestrator module for " + vendor + " must export a class or { create }");
    }
    entry.workflow = orchestrator;
    entry.step     = "running";

    // Set up approve/cancel signal via the entry promise slots.
    // orchestrator.run() should accept a cancelSignal promise and resolve
    // once the portal case is created.  Approve/cancel unblock the signal.
    const approveSignal = new Promise((res, rej) => {
      entry._resolve = res;
      entry._reject  = rej;
    });

    const runResult = await orchestrator.run(unit, entry.altId || "", { approveSignal, workflowId });

    // run() resolved -- orchestrator handled its own complete emission.
    // Clean up registry.
    entry.step = "complete";
    logger.info("["+workflowId+"] orchestrator.run resolved", JSON.stringify(runResult || {}).slice(0,120));

  } catch (err) {
    const code = err.message && err.message.startsWith("vendor-auth-failed:") ? "AUTH_ERROR" : "ORCHESTRATOR_ERROR";
    logger.warn("["+workflowId+"] orchestrator error:", err.message);
    sendToAll("vendor:error", {
      workflowId, vendor, unit: eqId,
      error: err.message, code,
    });
    if (orchestrator && typeof orchestrator.close === "function") {
      try { orchestrator.close(); } catch (_) {}
    }
  } finally {
    _unregister(workflowId);
    logger.info("["+workflowId+"] workflow unregistered. Active:", _active.size);
  }
}

// ============================================================================
// Shared start handler (paccar + volvo both use this)
// ============================================================================

/**
 * _handleStart(vendor, payload)
 * Called by both vendor:start-paccar and vendor:start-volvo handlers.
 * Steps:
 *   1. Validate payload.unit
 *   2. Concurrency guards (per-unit, global cap)
 *   3. runRelayStep(unit) -- Relay WO creation / dupe check
 *   4. Register workflow entry
 *   5. Fire-and-forget _runVendorWorkflow (orchestrator runs async)
 *   6. Return { ok, workflowId, vendor, altId, workRequestId, serviceUrl, isDuplicate }
 *
 * The IPC reply comes BEFORE the portal session opens -- relay step is the only
 * synchronous gate here.  Portal progress arrives via vendor:progress / vendor:review-ready.
 */
async function _handleStart(vendor, payload) {
  const unit = requireObject(payload && payload.unit, "payload.unit");
  const eqId = String(unit.equipmentId || unit.id || "").trim();
  if (!eqId) throw new ConfigError("payload.unit.equipmentId is required", "equipmentId");

  // -- Concurrency guard 1: same unit already running --
  if (_unitIndex.has(eqId)) {
    const existingId = _unitIndex.get(eqId);
    const existing   = _active.get(existingId);
    logger.warn("vendor:start-"+vendor+": unit "+eqId+" already has active workflow:", existingId);
    return {
      ok: false,
      code:        "DUPLICATE_WORKFLOW",
      error:       "Workflow already active for unit " + eqId,
      workflowId:  existingId,
      vendor:      existing ? existing.vendor : vendor,
      step:        existing ? existing.step : "unknown",
    };
  }

  // -- Concurrency guard 2: global cap --
  if (_active.size >= MAX_CONCURRENT_WORKFLOWS) {
    throw new ConfigError(
      "Maximum concurrent vendor workflows reached (" + MAX_CONCURRENT_WORKFLOWS + ")",
      "concurrency"
    );
  }

  // -- Pre-allocate workflow ID so relay progress can reference it --
  const workflowId = _genWorkflowId(vendor, eqId);
  logger.info("["+workflowId+"] starting | vendor:", vendor, "| unit:", eqId);

  // -- Relay step (S23-2): create/find Relay WO, capture altId --
  let relayResult;
  try {
    relayResult = await runRelayStep(unit);
  } catch (relayErr) {
    logger.warn("["+workflowId+"] relay step failed:", relayErr.message);
    throw relayErr; // safeIPC will catch and return { ok:false }
  }

  const { altId, workRequestId, serviceUrl, isDuplicate } = relayResult;
  logger.info("["+workflowId+"] relay done | altId:", altId || "(pending)", "| isDuplicate:", isDuplicate);

  // -- Register entry BEFORE firing async orchestrator --
  _register(workflowId, {
    vendor, unit, startedAt: Date.now(),
    step:        "relay-done",
    altId,       workRequestId, serviceUrl, isDuplicate,
    workflow:    null,
    _resolve:    null,
    _reject:     null,
  });

  // -- Fire-and-forget: orchestrator runs async, UI gets reply now --
  _runVendorWorkflow(vendor, unit, workflowId).catch(err => {
    logger.error("["+workflowId+"] _runVendorWorkflow unhandled rejection:", err.message);
    _unregister(workflowId);
  });

  return {
    ok:           true,
    workflowId,
    vendor,
    altId:        altId        || "",
    workRequestId: workRequestId || "",
    serviceUrl:   serviceUrl   || "",
    isDuplicate,
  };
}

// ============================================================================
// IPC registration
// ============================================================================

function registerVendorIPC() {

  // vendor:start-paccar
  handle("vendor:start-paccar", async (_e, payload) => {
    return Promise.race([
      _handleStart("paccar", payload),
      timeoutAfter(WORKFLOW_IPC_TIMEOUT_MS, "vendor:start-paccar"),
    ]);
  });

  // vendor:start-volvo
  handle("vendor:start-volvo", async (_e, payload) => {
    return Promise.race([
      _handleStart("volvo", payload),
      timeoutAfter(WORKFLOW_IPC_TIMEOUT_MS, "vendor:start-volvo"),
    ]);
  });

  // vendor:approve
  // Signals approval to a waiting orchestrator (unblocks approveSignal promise).
  // Optional altId lets the renderer pass a confirmed Alt ID back.
  handle("vendor:approve", async (_e, payload) => {
    if (!payload || !payload.workflowId) {
      throw new ConfigError("workflowId is required", "workflowId");
    }
    const workflowId = String(payload.workflowId);
    const entry = _active.get(workflowId);
    if (!entry) {
      logger.warn("vendor:approve: no active workflow:", workflowId);
      return { ok: false, error: "No active workflow: " + workflowId, code: "NOT_FOUND" };
    }
    if (payload.altId) entry.altId = String(payload.altId);
    entry.step = "approved";
    if (typeof entry._resolve === "function") {
      entry._resolve({ approved: true, altId: entry.altId || "" });
    }
    logger.info("vendor:approve: approved", workflowId, "| altId:", entry.altId || "(unchanged)");
    return { ok: true };
  });

  // vendor:cancel
  // Signals cancellation to a waiting orchestrator (rejects approveSignal promise).
  handle("vendor:cancel", async (_e, payload) => {
    if (!payload || !payload.workflowId) {
      throw new ConfigError("workflowId is required", "workflowId");
    }
    const workflowId = String(payload.workflowId);
    const entry = _active.get(workflowId);
    if (!entry) {
      logger.warn("vendor:cancel: no active workflow:", workflowId);
      return { ok: false, error: "No active workflow: " + workflowId, code: "NOT_FOUND" };
    }
    entry.step = "cancelled";
    if (typeof entry._reject === "function") {
      entry._reject(new Error("workflow-cancelled:" + workflowId));
    }
    if (entry.workflow && typeof entry.workflow.close === "function") {
      try { entry.workflow.close(); } catch (_) {}
    }
    _unregister(workflowId);
    logger.info("vendor:cancel: cancelled", workflowId);
    return { ok: true };
  });

  // vendor:get-status
  handle("vendor:get-status", async () => {
    const active = [];
    for (const [id, e] of _active.entries()) {
      active.push({
        workflowId:  id,
        vendor:      e.vendor,
        unit:        e.unit ? e.unit.equipmentId : null,
        startedAt:   e.startedAt,
        step:        e.step,
        isDuplicate: e.isDuplicate || false,
        altId:       e.altId || "",
      });
    }
    return { active };
  });

  // vendor:investigate
  handle("vendor:investigate", async (_e, payload) => {
    const unit = requireObject(payload && payload.unit, "payload.unit");
    return investigate(unit);
  });
  // vendor:enrich-asist -- on-demand Volvo ASIST enrichment (S25-9)
  handle("vendor:enrich-asist", async (_e, payload) => {
    const srUrl = String((payload && payload.srUrl) || "").trim();
    if (!srUrl) throw new ConfigError("srUrl is required", "srUrl");
    logger.info("vendor:enrich-asist called | url:", srUrl.slice(0, 80));
    return enrichVolvoAsist(srUrl);
  });
  logger.info("Vendor IPC handlers registered");
}

module.exports = { registerVendorIPC };
