// ui/popup/popup.js
document.getElementById('openSide').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id != null) chrome.sidePanel.open({ tabId: tab.id });
  window.close();
});
document.getElementById('openOpt').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
