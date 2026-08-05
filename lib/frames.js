(function (global) {
  'use strict';
  const RegLog = global.RegLog = global.RegLog || {};
  const frames = RegLog.frames = {};

  frames.runOnBestFrame = async function (tabId, payload) {
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: RegLog.agent.pageAgent,
        args: [payload]
      });
    } catch (e) {
      return { error: 'injection-blocked', message: e && e.message };
    }
    if (!results || results.length === 0) return null;
    const withResult = results.filter(r => r.result);
    if (withResult.length === 0) return null;
    withResult.sort((a, b) => (b.result.score - a.result.score) || (a.frameId - b.frameId));
    const best = withResult[0];
    return { result: best.result, frameId: best.frameId };
  };

  frames.needsFrameAccess = async function (tabId) {
    const scanPayload = { mode: 'scan', data: {}, opts: {} };
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true }, func: RegLog.agent.pageAgent, args: [scanPayload]
      });
    } catch (e) { return false; }
    const allZero = results.every(r => !r.result || r.result.score === 0);
    if (!allZero) return false;
    const [hasIframe] = await chrome.scripting.executeScript({
      target: { tabId }, func: () => document.querySelectorAll('iframe').length > 0
    });
    return !!(hasIframe && hasIframe.result);
  };

  frames.requestWebNavigation = async function () {
    return chrome.permissions.request({ permissions: ['webNavigation'] });
  };

  frames.listChildOrigins = async function (tabId) {
    const allFrames = await chrome.webNavigation.getAllFrames({ tabId });
    const [{ result: topOrigin }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.origin });
    const origins = new Set();
    for (const f of allFrames || []) {
      if (!f.url || f.url === 'about:blank') continue;
      let origin;
      try { origin = new URL(f.url).origin; } catch (e) { continue; }
      if (origin !== topOrigin) origins.add(origin);
    }
    return Array.from(origins);
  };

  frames.requestOrigins = async function (originList) {
    const origins = originList.map(o => o + '/*');
    // Инвариант проекта: никогда не запрашивать '*://*/*' целиком.
    if (origins.some(o => o === '*://*/*')) throw new Error('запрос всех origin запрещён');
    return chrome.permissions.request({ origins });
  };

  frames.listGrantedOrigins = async function () {
    const all = await chrome.permissions.getAll();
    return (all.origins || []).filter(o => o !== '*://*/*');
  };

  frames.revokeOrigin = async function (origin) {
    return chrome.permissions.remove({ origins: [origin] });
  };

  frames.revokeWebNavigation = async function () {
    return chrome.permissions.remove({ permissions: ['webNavigation'] });
  };

})(typeof window !== 'undefined' ? window : globalThis);
