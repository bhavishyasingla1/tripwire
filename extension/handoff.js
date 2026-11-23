// Runs only on the Tripwire web app. If the user just right-clicked
// "Check with Tripwire", takes that text and posts it to the page (same
// origin only). The background worker clears it after one hand-off.
chrome.runtime.sendMessage({ type: 'tripwire-take' }, (res) => {
  if (res?.text) window.postMessage({ type: 'tripwire-text', text: res.text }, location.origin);
});
