// src/steads/state.js — in-process Clint state shared by the webhook and the
// steads admin tool. The mute flag silences notifications until the next
// restart (deliberately ephemeral). Deployed to clawd-admin: src/steads/state.js.
let muted = false;
export function isMuted() { return muted; }
export function setMuted(v) { muted = !!v; return muted; }
