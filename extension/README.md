# Tripwire for Chrome

Select a recruiter message anywhere (Gmail, LinkedIn, WhatsApp Web, Naukri), right-click, and choose **Check with Tripwire**. The Tripwire web app opens and checks it with Gemini Nano on your device.

The selected text is held in `chrome.storage.session` (memory only) and handed to the page by a content script that runs only on the Tripwire site. It is never put in a URL, so it does not end up in browser history or server logs.

## Install (developer mode)
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this `extension` folder.

Permissions: `contextMenus` (the right-click item) and `storage` (to hold the selected text for a moment). No host permissions; it cannot read pages you visit.
