import { WasmBridge } from "./wasm-bridge.js";
import { Renderer } from "./renderer.js";
import { InputHandler } from "./input.js";

export class WTerm {
  constructor(element, options = {}) {
    this.element = element;
    this.wasmUrl = options.wasmUrl;
    this.cols = options.cols || 80;
    this.rows = options.rows || 24;
    this.autoResize = options.autoResize !== false;
    this.onData = options.onData || null;
    this.onTitle = options.onTitle || null;
    this.onResize = options.onResize || null;

    this.bridge = null;
    this._renderer = null;
    this._input = null;
    this._rafId = null;
    this._resizeObserver = null;
    this._destroyed = false;
    this._shouldScrollToBottom = false;

    this._container = document.createElement("div");
    this._container.className = "term-grid";
    this.element.appendChild(this._container);
    this.element.classList.add("wterm");

    this._onClickFocus = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) this._input?.focus();
    };
    this.element.addEventListener("click", this._onClickFocus);
  }

  async init() {
    try {
      this.bridge = await WasmBridge.load(this.wasmUrl);
      if (this._destroyed) return this;
      this.bridge.init(this.cols, this.rows);

      this._renderer = new Renderer(this._container);
      this._renderer.setup(this.cols, this.rows);

      this._input = new InputHandler(
        this.element,
        (data) => {
          if (this.onData) {
            this.onData(data);
          } else {
            this.write(data);
          }
        },
        () => this.bridge,
      );

      if (this.autoResize) {
        this._setupResizeObserver();
      } else {
        this._lockHeight();
      }

      this._input.focus();
      this._initialRender();
    } catch (err) {
      this.destroy();
      throw new Error(`wterm: failed to initialize: ${err instanceof Error ? err.message : err}`);
    }
    return this;
  }

  _isScrolledToBottom() {
    const el = this.element;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 5;
  }

  _scrollToBottom() {
    this.element.scrollTop = this.element.scrollHeight;
  }

  write(data) {
    if (!this.bridge) return;
    this._shouldScrollToBottom = this._isScrolledToBottom();
    if (typeof data === "string") {
      this.bridge.writeString(data);
    } else {
      this.bridge.writeRaw(data);
    }
    this._scheduleRender();
  }

  resize(cols, rows) {
    if (!this.bridge) return;
    this._shouldScrollToBottom = this._isScrolledToBottom();
    this.cols = cols;
    this.rows = rows;
    this.bridge.resize(cols, rows);
    this._renderer?.setup(cols, rows);
    this._scheduleRender();
    if (this.onResize) this.onResize(cols, rows);
  }

  focus() {
    if (this._input) {
      this._input.focus();
    } else {
      this.element.focus();
    }
  }

  _scheduleRender() {
    if (this._rafId == null) {
      this._rafId = requestAnimationFrame(() => {
        this._rafId = null;
        this._doRender();
      });
    }
  }

  _initialRender() {
    this._doRender();
  }

  _doRender() {
    if (!this.bridge || !this._renderer) return;
    this._renderer.render(this.bridge);
    const hasScrollback = this.bridge.getScrollbackCount() > 0;
    this.element.classList.toggle("has-scrollback", hasScrollback);
    if (this._shouldScrollToBottom) this._scrollToBottom();
    const title = this.bridge.getTitle();
    if (title !== null && this.onTitle) this.onTitle(title);
    const response = this.bridge.getResponse();
    if (response !== null && this.onData) this.onData(response);
  }

  _lockHeight() {
    const cs = getComputedStyle(this.element);
    const rowHeight = parseFloat(cs.getPropertyValue("--term-row-height")) || 17;
    const gridHeight = this.rows * rowHeight;
    let extra = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    if (cs.boxSizing === "border-box") {
      extra += (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    }
    this.element.style.height = `${gridHeight + extra}px`;
  }

  _measureCharSize() {
    const probe = document.createElement("span");
    probe.className = "term-cell";
    probe.textContent = "W";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    this._container.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    probe.remove();
    if (width === 0 || height === 0) return null;
    return { width, height };
  }

  _setupResizeObserver() {
    const initial = this._measureCharSize();
    if (!initial) return;
    let charWidth = initial.width;
    let charHeight = initial.height;
    this._resizeObserver = new ResizeObserver((entries) => {
      const measured = this._measureCharSize();
      if (measured) {
        charWidth = measured.width;
        charHeight = measured.height;
      }
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const newCols = Math.max(1, Math.floor(width / charWidth));
        const newRows = Math.max(1, Math.floor(height / charHeight));
        if (newCols !== this.cols || newRows !== this.rows) {
          this.resize(newCols, newRows);
        }
      }
    });
    this._resizeObserver.observe(this.element);
  }

  destroy() {
    this._destroyed = true;
    if (this._rafId != null) cancelAnimationFrame(this._rafId);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._input) this._input.destroy();
    this.element.removeEventListener("click", this._onClickFocus);
    this.element.innerHTML = "";
  }
}
