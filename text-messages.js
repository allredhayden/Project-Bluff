(() => {
  "use strict";

  // Deliberately separate from shared soundtrack state. Drafts belong to this tab.
  const STORAGE_KEY = "project-bluff-silent-messages-v1";
  const MIN_SIZE = 16;
  const MAX_SIZE = 72;
  const SIZE_STEP = 4;
  const KEYBOARD_HEIGHT_THRESHOLD = 100;
  const modal = document.querySelector("[data-text-modal]");
  const openButton = document.querySelector("[data-text-open]");
  const closeButton = document.querySelector("[data-text-close]");
  const soundtrack = document.querySelector("main.app");
  const modeButtons = Array.from(document.querySelectorAll("[data-text-mode]"));
  const panels = Array.from(document.querySelectorAll("[data-text-panel]"));
  const billboardStage = document.querySelector("[data-billboard-stage]");
  const billboardMessage = document.querySelector("[data-billboard-message]");
  const billboardEmpty = document.querySelector("[data-billboard-empty]");
  const billboardEditor = document.querySelector("[data-billboard-editor]");
  const billboardEdit = document.querySelector("[data-billboard-edit]");
  const conversationEditor = document.querySelector("[data-conversation-editor]");
  const conversationDone = document.querySelector("[data-conversation-done]");
  const conversationFinish = document.querySelector("[data-conversation-finish]");
  const sizeValue = document.querySelector("[data-text-size]");
  const smaller = document.querySelector("[data-text-smaller]");
  const larger = document.querySelector("[data-text-larger]");
  const clearButtons = Array.from(document.querySelectorAll("[data-text-clear]"));
  const state = { mode: "billboard", billboard: "", conversation: "", size: 36 };
  let editingBillboard = false;
  let billboardViewportHeight = 0;
  let billboardKeyboardVisible = false;
  let fitFrame = 0;
  let conversationSelection = null;

  try {
    const saved = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY));
    if (saved && typeof saved === "object") {
      state.mode = saved.mode === "conversation" ? "conversation" : "billboard";
      state.billboard = typeof saved.billboard === "string" ? saved.billboard : "";
      state.conversation = typeof saved.conversation === "string" ? saved.conversation : "";
      if (typeof saved.size === "number" && Number.isFinite(saved.size)) {
        state.size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, saved.size));
      }
    }
  } catch {
    // Storage can be unavailable in private/restricted browsers; writing still works.
  }

  function save() {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Keep using the in-memory drafts when browser storage is unavailable.
    }
  }

  function fitBillboard() {
    if (modal.hidden || state.mode !== "billboard" || editingBillboard || !state.billboard.trim()) {
      return;
    }
    const width = billboardStage.clientWidth;
    const height = billboardStage.clientHeight;
    if (!width || !height) {
      return;
    }

    // Measure actual wrapping, including manual line breaks, in the display font.
    let low = 1;
    let high = Math.ceil(Math.max(width, height) * 2);
    while (low < high) {
      const candidate = Math.ceil((low + high) / 2);
      billboardMessage.style.fontSize = `${candidate}px`;
      if (billboardMessage.scrollWidth <= width && billboardMessage.scrollHeight <= height) {
        low = candidate;
      } else {
        high = candidate - 1;
      }
    }
    billboardMessage.style.fontSize = `${low}px`;
  }

  function scheduleFit() {
    window.cancelAnimationFrame(fitFrame);
    fitFrame = window.requestAnimationFrame(fitBillboard);
  }

  function updateViewport() {
    if (modal.hidden) {
      return;
    }
    const viewport = window.visualViewport;
    const height = viewport ? viewport.height : window.innerHeight;
    modal.style.height = `${height}px`;
    modal.style.top = `${viewport ? viewport.offsetTop : 0}px`;
    modal.classList.toggle("text-compact", height < 300);
    if (editingBillboard && (!viewport || viewport.scale === 1)) {
      // Native keyboard dismissal can restore the viewport without blurring the editor.
      // Ignore small changes from browser toolbars and wait for a keyboard-sized shrink.
      if (billboardViewportHeight - height > KEYBOARD_HEIGHT_THRESHOLD) {
        billboardKeyboardVisible = true;
      } else if (billboardKeyboardVisible) {
        showBillboard();
      }
    }
    scheduleFit();
  }

  function updateSize() {
    conversationEditor.style.fontSize = `${state.size}px`;
    sizeValue.textContent = `${state.size} px`;
    smaller.disabled = state.size <= MIN_SIZE;
    larger.disabled = state.size >= MAX_SIZE;
  }

  function showBillboard() {
    editingBillboard = false;
    billboardKeyboardVisible = false;
    billboardEditor.blur();
    billboardEditor.hidden = true;
    billboardStage.hidden = false;
    billboardMessage.textContent = state.billboard;
    billboardMessage.hidden = !state.billboard.trim();
    billboardEmpty.hidden = Boolean(state.billboard.trim());
    billboardEdit.textContent = "Edit";
    scheduleFit();
  }

  function editBillboard() {
    editingBillboard = true;
    billboardViewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    billboardKeyboardVisible = false;
    billboardStage.hidden = true;
    billboardEditor.hidden = false;
    billboardEditor.value = state.billboard;
    billboardEdit.textContent = "Done";
    billboardEditor.focus({ preventScroll: true });
    // Most new messages replace the previous player's message.
    billboardEditor.select();
  }

  function setMode(mode) {
    showBillboard();
    conversationEditor.blur();
    state.mode = mode;
    modeButtons.forEach((button) => {
      const selected = button.dataset.textMode === mode;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => { panel.hidden = panel.dataset.textPanel !== mode; });
    updateSize();
    save();
    scheduleFit();
  }

  function open() {
    modal.hidden = false;
    soundtrack.inert = true;
    document.body.classList.add("text-open");
    openButton.setAttribute("aria-expanded", "true");
    setMode(state.mode);
    updateViewport();
    const initialFocus = modal.classList.contains("text-compact")
      ? modeButtons.find((button) => button.dataset.textMode === state.mode) : closeButton;
    initialFocus.focus({ preventScroll: true });
  }

  function close() {
    showBillboard();
    conversationEditor.blur();
    modal.hidden = true;
    soundtrack.inert = false;
    document.body.classList.remove("text-open");
    openButton.setAttribute("aria-expanded", "false");
    openButton.focus({ preventScroll: true });
  }

  function changeSize(amount) {
    const scrollTop = conversationEditor.scrollTop;
    state.size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, state.size + amount));
    updateSize();
    save();
    // Size controls should not end a conversation or discard the insertion point.
    if (conversationSelection) {
      conversationEditor.focus({ preventScroll: true });
      conversationEditor.setSelectionRange(...conversationSelection);
    }
    conversationEditor.scrollTop = scrollTop;
  }

  function clearMessage(mode) {
    const editor = mode === "billboard" ? billboardEditor : conversationEditor;
    const keepEditing = mode === "billboard" ? editingBillboard : document.activeElement === editor;
    state[mode] = "";
    editor.value = "";
    editor.scrollTop = 0;
    editor.setSelectionRange(0, 0);
    if (mode === "billboard") {
      billboardMessage.textContent = "";
      if (!editingBillboard) {
        showBillboard();
      }
    } else {
      conversationSelection = null;
    }
    save();
    if (keepEditing) {
      editor.focus({ preventScroll: true });
    }
  }

  // Block controller activation even when a browser lacks native inert support.
  function blockSoundtrackInput(event) {
    if (!modal.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
  ["click", "pointerdown", "keydown"].forEach((type) => {
    soundtrack.addEventListener(type, blockSoundtrackInput, { capture: true });
  });

  billboardEditor.value = state.billboard;
  conversationEditor.value = state.conversation;
  showBillboard();
  updateSize();

  openButton.addEventListener("click", open);
  closeButton.addEventListener("click", close);
  modeButtons.forEach((button, index) => {
    button.addEventListener("click", () => setMode(button.dataset.textMode));
    button.addEventListener("keydown", (event) => {
      let next = index;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        next = (index + (event.key === "ArrowRight" ? 1 : -1) + modeButtons.length) % modeButtons.length;
      } else if (event.key === "Home" || event.key === "End") {
        next = event.key === "Home" ? 0 : modeButtons.length - 1;
      } else {
        return;
      }
      event.preventDefault();
      setMode(modeButtons[next].dataset.textMode);
      modeButtons[next].focus();
    });
  });
  billboardEdit.addEventListener("pointerdown", (event) => {
    // Keep Done active until click; an earlier blur would turn it back into Edit.
    if (document.activeElement === billboardEditor) {
      event.preventDefault();
    }
  });
  billboardEdit.addEventListener("click", () => {
    if (editingBillboard) {
      showBillboard();
    } else {
      editBillboard();
    }
  });
  billboardEmpty.addEventListener("click", editBillboard);
  billboardEditor.addEventListener("input", () => {
    state.billboard = billboardEditor.value;
    save();
  });
  billboardEditor.addEventListener("blur", () => {
    if (editingBillboard) {
      showBillboard();
    }
  });
  conversationEditor.addEventListener("input", () => {
    state.conversation = conversationEditor.value;
    save();
  });
  conversationEditor.addEventListener("focus", () => { conversationDone.textContent = "Done"; });
  conversationEditor.addEventListener("blur", () => { conversationDone.textContent = "Tap text to edit"; });
  conversationDone.addEventListener("pointerdown", (event) => {
    // Preserve focus until click so Done can dismiss the keyboard on touch screens.
    if (document.activeElement === conversationEditor) {
      event.preventDefault();
    }
  });
  conversationDone.addEventListener("click", () => {
    if (document.activeElement === conversationEditor) {
      conversationEditor.blur();
      conversationDone.focus({ preventScroll: true });
    } else {
      conversationEditor.focus({ preventScroll: true });
    }
  });
  conversationFinish.addEventListener("click", () => {
    conversationEditor.blur();
    modeButtons.find((button) => button.dataset.textMode === state.mode).focus({ preventScroll: true });
  });
  [smaller, larger].forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      conversationSelection = document.activeElement === conversationEditor
        ? [conversationEditor.selectionStart, conversationEditor.selectionEnd] : null;
      if (conversationSelection) {
        event.preventDefault();
      }
    });
    button.addEventListener("keydown", () => { conversationSelection = null; });
  });
  smaller.addEventListener("click", () => changeSize(-SIZE_STEP));
  larger.addEventListener("click", () => changeSize(SIZE_STEP));
  clearButtons.forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      const editor = button.dataset.textClear === "billboard" ? billboardEditor : conversationEditor;
      if (document.activeElement === editor) {
        event.preventDefault();
      }
    });
    button.addEventListener("click", () => clearMessage(button.dataset.textClear));
  });

  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (editingBillboard) {
        showBillboard();
        billboardEdit.focus();
      } else if (document.activeElement === conversationEditor) {
        conversationEditor.blur();
        const nextFocus = modal.classList.contains("text-compact")
          ? modeButtons.find((button) => button.dataset.textMode === state.mode) : conversationDone;
        nextFocus.focus();
      } else {
        close();
      }
    } else if (event.key === "Tab") {
      const focusable = Array.from(modal.querySelectorAll("button:not(:disabled), textarea"))
        .filter((element) => element.tabIndex >= 0 && element.getClientRects().length);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  window.addEventListener("resize", updateViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateViewport);
    window.visualViewport.addEventListener("scroll", updateViewport);
  }
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(scheduleFit).observe(billboardStage);
  }
  if (document.fonts) {
    document.fonts.ready.then(scheduleFit);
  }
})();
