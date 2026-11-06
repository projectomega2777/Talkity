// Talkity Chrome Extension - Content Script
// Handles injecting text into active input fields / contenteditable elements.

// Keep track of the last focused editable element so focus loss (e.g. clicking extension popup)
// doesn't lose the user's intended target.
let lastFocusedElement = null;

function isEditable(el) {
  if (!el) return false;
  const tagName = el.tagName ? el.tagName.toLowerCase() : '';
  if (tagName === 'input' || tagName === 'textarea') {
    return !el.disabled && !el.readOnly;
  }
  return el.isContentEditable;
}

document.addEventListener('focusin', (e) => {
  if (isEditable(e.target)) {
    lastFocusedElement = e.target;
  }
}, true);

document.addEventListener('click', (e) => {
  if (isEditable(e.target)) {
    lastFocusedElement = e.target;
  }
}, true);

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'talkity_inject') {
    try {
      const result = injectTextIntoActiveElement(request.text);
      sendResponse({ status: result ? 'injected' : 'fallback_clipboard' });
    } catch (err) {
      sendResponse({ status: 'error', message: err.message });
    }
  }
  return true;
});

function injectTextIntoActiveElement(text) {
  if (!text) return false;

  let activeEl = document.activeElement;

  // If activeElement is body or not editable, try restoring the last focused editable element
  if (!isEditable(activeEl) && isEditable(lastFocusedElement)) {
    activeEl = lastFocusedElement;
    try {
      activeEl.focus();
    } catch (_) {}
  }

  if (!isEditable(activeEl)) {
    // Fallback: copy to clipboard so text isn't lost
    navigator.clipboard.writeText(text).catch(() => {});
    return false;
  }

  const tagName = activeEl.tagName ? activeEl.tagName.toLowerCase() : '';

  if (tagName === 'input' || tagName === 'textarea') {
    const val = activeEl.value || '';
    let start = val.length;
    let end = val.length;
    let supportsSelection = false;
    try {
      if (typeof activeEl.selectionStart === 'number') {
        start = activeEl.selectionStart;
        end = typeof activeEl.selectionEnd === 'number' ? activeEl.selectionEnd : start;
        supportsSelection = true;
      }
    } catch (_) {}

    // Standard HTML5 input injection compatible with React / Vue
    // Using prototype setter triggers synthetic event systems in React 16+
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;
    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;

    const newValue = val.substring(0, start) + text + val.substring(end);

    if (tagName === 'input' && nativeInputValueSetter) {
      nativeInputValueSetter.call(activeEl, newValue);
    } else if (tagName === 'textarea' && nativeTextAreaValueSetter) {
      nativeTextAreaValueSetter.call(activeEl, newValue);
    } else {
      activeEl.value = newValue;
    }

    if (supportsSelection) {
      try {
        activeEl.selectionStart = activeEl.selectionEnd = start + text.length;
      } catch (_) {}
    }

    // Dispatch input event so frameworks (React, Vue) detect the change
    activeEl.dispatchEvent(new Event('input', { bubbles: true }));
    activeEl.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } else if (activeEl.isContentEditable) {
    // For contenteditable, document.execCommand handles undo/redo stack and rich text
    // Focus first
    activeEl.focus();
    const success = document.execCommand('insertText', false, text);
    if (!success) {
      // Fallback for some contenteditable containers
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    // Also dispatch input event for framework-based rich text editors (Quill, Lexical, Draft)
    activeEl.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  // Fallback to clipboard
  navigator.clipboard.writeText(text).catch(() => {});
  return false;
}
