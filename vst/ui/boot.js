// 808 Circuit as a plugin: put at the end of the app's page, after its own scripts. Brings back the page's state as
// the project saved it, starts the (stand-in) audio, and from then on tells the plugin the page's state, as a preset,
// whenever it changes.
(async () => {
  const t8 = window.__t8;
  // the reverb's IR goes as it is: the plugin cuts it into the convolution's parts itself
  IrVerb.prepare = (L, R, frac) => ({ raw: true, L, R, frac });
  const snapshot = () => presetData({ name: (typeof presetName === 'function' ? presetName() : 'session'), kit: Uint8Array.from(values),
    xm: { amt: xm.amt.slice(), target: xm.target.slice() }, fx: mix.fx.slice(), fx3: fx3Snapshot(), dpos: delayPos,
    song: songSnapshot(), e808: t8Snapshot() });
  try {
    const s = t8.init.session;
    if (s) { const p = toCurrent(JSON.parse(s)); if (p) loadPreset(fromStored(p)); }
  } catch (e) { console.warn('808 Circuit: the saved state could not be restored', e); }
  try { await startAudio(); } catch (e) { console.warn(e); }
  // (let the messages queued till the audio started go first)
  await new Promise((r) => setTimeout(r, 0));
  t8.booting = false;
  let last = '';
  const push = () => {
    try { const s = JSON.stringify(snapshot()); if (s !== last) { last = s; t8.emit('t8session', s); } } catch (e) { /* (mid-change: next time) */ }
  };
  push();
  setInterval(push, 1000);
  addEventListener('pagehide', push);
  // the host's transport as the plugin last heard it
  const h = t8.init.host;
  if (h && h.has) window.__t8host?.(h);
  t8.emit('t8ready', true);
})();
