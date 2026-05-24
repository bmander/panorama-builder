// Per-action id used to group a user action's writes into one undo checkpoint.
//
// A single user gesture fans out into many backend writes (one flushSync
// batches all the per-entity PUT/POST/DELETEs, issued synchronously before it
// awaits). They must all carry the same X-Action-Id so the server records one
// checkpoint; writes from a later, distinct action must carry a different id.
//
// We exploit the event-loop turn: the id is generated lazily on first use and
// retired on the next microtask. All writes issued synchronously in one turn
// (a flush's Promise.all) therefore share it, while a subsequent user action
// — which runs in a later turn — gets a fresh id. No explicit begin/end calls
// to sprinkle through the edit sites.

let active: string | null = null;
let retireScheduled = false;

function randomId(): string {
  // Base36 of two random words — collision-safe enough for grouping; the
  // server only compares it for equality against the in-flight action.
  return (
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

// current returns the active action id, minting one (and scheduling its
// retirement) on the first call of a turn.
export function currentActionId(): string {
  active ??= randomId();
  if (!retireScheduled) {
    retireScheduled = true;
    queueMicrotask(() => {
      active = null;
      retireScheduled = false;
    });
  }
  return active;
}
