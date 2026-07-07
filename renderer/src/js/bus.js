/**
 * bus.js -- Application-wide event bus (Fleet Operations renderer)
 *
 * Thin EventTarget wrapper. One shared bus, acyclic dep graph.
 *
 * IPC->renderer events (emitted by bridge.js):
 *   fleet:data           { rows, count, syncedAt, stale }
 *   fleet:status         String
 *   fleet:error          String
 *   orcha:progress       { unitId, step, message }
 *   daily-notes:progress { unitId, step, message }
 *   sp:progress          { unitId, step, message }
 *   bubble:badge         Number
 *   bubble:notification  { unit, message }
 *   navigate:unit        String unitId
 *   auth:mwinit-status   { ok, reason }
 *   setup:progress       { step, done, total }
 *   vendor:progress      { vendor, step, ts, workflowId?, unit?, ...extras }
 *   vendor:review-ready  { workflowId, vendor, unit, altId, serviceUrl, ... }
 *   vendor:complete      { workflowId, vendor, unit, caseNumber, caseUrl, ... }
 *   vendor:error         { workflowId, vendor, unit, error, code }
 *
 * Internal UI events:
 *   ui:view-change   { from, to }
 *   ui:unit-select   { unit }
 *   ui:unit-deselect void
 *   ui:filter-change { field, value }
 *   ui:search        { query }
 *   ui:toast         { type, message, duration? }
 *   ui:loading       Boolean
 */

const _bus = new EventTarget();

const bus = {
  /** Subscribe. Returns unsubscribe fn. */
  on(event, handler) {
    const wrapped = (e) => handler(e.detail);
    _bus.addEventListener(event, wrapped);
    return () => _bus.removeEventListener(event, wrapped);
  },
  /** Subscribe once -- auto-removed after first fire. */
  once(event, handler) {
    const wrapped = (e) => {
      _bus.removeEventListener(event, wrapped);
      handler(e.detail);
    };
    _bus.addEventListener(event, wrapped);
  },
  /** Emit an event with an optional payload. */
  emit(event, detail) {
    _bus.dispatchEvent(new CustomEvent(event, { detail }));
  },
};

export default bus;
