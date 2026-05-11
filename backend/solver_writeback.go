package main

// Solver writeback always goes through the session journal in
// solver_session.go (writebackChangesInSession). The non-session
// optimistic-locked direct-DB writeback path was removed when writes were
// hardened to require an open session.
