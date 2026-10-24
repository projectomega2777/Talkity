// Talkity Chrome Extension - Content Script
// Handles injecting text into active input fields / contenteditable elements.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'talkity_inject') {
    injectTextIntoActiveElement(request.text);
    sendResponse({ status: 'injected' });
  }
  return true;
});

function injectTextIntoActiveElement(text) {
  const activeEl = document.activeElement;

  if (!activeEl) {
    // Fallback: copy to clipboard
    navigator.clipboard.writeText(text).catch(() => {});
    return;
  }

  const tagName = activeEl.tagName ? activeEl.tagName.toLowerCase() : '';

  if (tagName === 'input' || tagName === 'textarea') {
    const start = activeEl.selectionStart || 0;
    const end = activeEl.selectionEnd || 0;
    const val = activeEl.value || '';

    activeEl.value = val.substring(0, start) + text + val.substring(end);
    activeEl.selectionStart = activeEl.selectionEnd = start + text.length;

    // Dispatch input event so frameworks (React, Vue) detect the change
    activeEl.dispatchEvent(new Event('input', { bubbles: true }));
    activeEl.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (activeEl.isContentEditable) {
    document.execCommand('insertText', false, text);
  } else {
    // Fallback to clipboard
    navigator.clipboard.writeText(text).catch(() => {});
  }
}
