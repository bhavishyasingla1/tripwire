// Tripwire extension: hands selected text to the Tripwire web app.
// The text is kept in session storage (memory only, cleared when Chrome
// closes) and passed to the page by a content script, so it never appears
// in a URL, in browser history or in server logs.
const APP = 'https://tripwire-shield.web.app/';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'tripwire-check', title: 'Check with Tripwire', contexts: ['selection'] });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'tripwire-check' || !info.selectionText) return;
  await chrome.storage.session.set({ pending: info.selectionText.slice(0, 20000) });
  chrome.tabs.create({ url: APP + '?from=extension' });
});

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: APP }));

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'tripwire-take') return;
  chrome.storage.session.get('pending').then(({ pending }) => {
    chrome.storage.session.remove('pending');
    reply({ text: pending ?? '' });
  });
  return true;
});
