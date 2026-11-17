import { isBrushShape, isTool, type Preferences, type Tool } from './model';
import type { Locale, Messages } from './i18n';

const COLORS = ['#202020', '#E46C60', '#E9AF59', '#69A27F', '#7195D0', '#AD8ACB'];
// Narrow touch screens get a bottom sheet instead of a popover at the finger.
const SHEET_QUERY = '(pointer: coarse) and (max-width: 599px)';

export interface PaletteActions {
  change: (preferences: Preferences) => void;
  restoreFocus: () => void;
  undo: () => void;
  zoom: (direction: 'in' | 'out' | 'reset') => void;
}

export class Palette {
  readonly element = document.createElement('section');
  private readonly widthInput: HTMLInputElement;
  private readonly opacityInput: HTMLInputElement;
  private readonly colorInput: HTMLInputElement;
  private readonly hexInput: HTMLInputElement;
  private readonly widthOutput: HTMLOutputElement;
  private readonly opacityOutput: HTMLOutputElement;
  private readonly zoomButton: HTMLButtonElement;
  private readonly percentFormat: Intl.NumberFormat;
  private anchor: [number, number] = [0, 0];
  private zoom = 1;

  constructor(
    private preferences: Preferences,
    private readonly actions: PaletteActions,
    private readonly messages: Messages,
    locale: Locale,
  ) {
    this.percentFormat = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
    this.element.className = 'palette';
    this.element.hidden = true;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', messages.paletteLabel);
    this.element.innerHTML = `
      <div class="tools" role="group" aria-label="${messages.toolLabel}">
        <button type="button" data-tool="brush">${messages.brush}</button>
        <button type="button" data-tool="hand">${messages.hand}</button>
        <button type="button" data-tool="eraser">${messages.eraser}</button>
      </div>
      <fieldset class="shapes">
        <legend>${messages.brushShape}</legend>
        <button type="button" data-brush="round" aria-label="${messages.roundBrush}" title="${messages.roundBrush}"><span class="shape round" aria-hidden="true"></span></button>
        <button type="button" data-brush="square" aria-label="${messages.squareBrush}" title="${messages.squareBrush}"><span class="shape square" aria-hidden="true"></span></button>
        <button type="button" data-brush="chisel" aria-label="${messages.chiselBrush}" title="${messages.chiselBrush}"><span class="shape chisel" aria-hidden="true"></span></button>
        <button type="button" data-brush="spray" aria-label="${messages.sprayBrush}" title="${messages.sprayBrush}"><span class="shape spray" aria-hidden="true"></span></button>
      </fieldset>
      <label class="control-label" for="brush-width">${messages.width} <output for="brush-width" id="width-output"></output></label>
      <input id="brush-width" type="range" min="1" max="64" step="1" />
      <label class="control-label" for="brush-color">${messages.color}</label>
      <div class="swatches" role="group" aria-label="${messages.colors}">
        ${COLORS.map((color) => `<button type="button" class="swatch" data-color="${color}" aria-label="${messages.colorSwatch(color)}" style="--swatch: ${color}"></button>`).join('')}
      </div>
      <div class="custom-color">
        <input id="brush-color" type="color" aria-label="${messages.chooseColor}" />
        <input id="brush-hex" type="text" aria-label="${messages.hexColor}" maxlength="7" pattern="#[0-9a-fA-F]{6}" spellcheck="false" autocomplete="off" />
      </div>
      <label class="control-label" for="brush-opacity">${messages.opacity} <output for="brush-opacity" id="opacity-output"></output></label>
      <input id="brush-opacity" type="range" min="0.01" max="1" step="0.01" />
      <div class="actions">
        <button type="button" class="undo" data-action="undo">${messages.undo}</button>
        <div class="zoom" role="group" aria-label="${messages.zoomLabel}">
          <button type="button" data-action="zoom-out" aria-label="${messages.zoomOut}" title="${messages.zoomOut}">−</button>
          <button type="button" data-action="zoom-reset" id="zoom-reset"></button>
          <button type="button" data-action="zoom-in" aria-label="${messages.zoomIn}" title="${messages.zoomIn}">+</button>
        </div>
      </div>
      <p class="palette-hint hint-desktop">${messages.panHint}<br>${messages.undoHint}<br>${messages.zoomHint}</p>
      <p class="palette-hint hint-touch">${messages.touchPanHint}<br>${messages.touchPaletteHint}</p>
    `;
    this.widthInput = this.required('#brush-width');
    this.opacityInput = this.required('#brush-opacity');
    this.colorInput = this.required('#brush-color');
    this.hexInput = this.required('#brush-hex');
    this.widthOutput = this.required('#width-output');
    this.opacityOutput = this.required('#opacity-output');
    this.zoomButton = this.required('#zoom-reset');
    this.sync();
    this.setZoom(1);

    this.element.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>('button');
      if (!button) return;
      const action = button.dataset.action;
      if (action === 'undo') this.actions.undo();
      else if (action === 'zoom-in') this.actions.zoom('in');
      else if (action === 'zoom-out') this.actions.zoom('out');
      else if (action === 'zoom-reset') this.actions.zoom('reset');
      else if (isTool(button.dataset.tool)) {
        this.update({ tool: button.dataset.tool });
        this.close();
      } else if (isBrushShape(button.dataset.brush)) {
        this.update({ brush: button.dataset.brush });
      } else if (button.dataset.color) {
        this.update({ color: button.dataset.color });
      }
    });
    this.widthInput.addEventListener('input', () => this.update({ width: this.widthInput.valueAsNumber }));
    this.opacityInput.addEventListener('input', () => this.update({ opacity: this.opacityInput.valueAsNumber }));
    this.colorInput.addEventListener('input', () => this.update({ color: this.colorInput.value.toUpperCase() }));
    this.hexInput.addEventListener('input', () => {
      const valid = /^#[\da-f]{6}$/i.test(this.hexInput.value);
      this.hexInput.setAttribute('aria-invalid', String(!valid));
      if (valid) this.update({ color: this.hexInput.value.toUpperCase() });
    });
    this.hexInput.addEventListener('blur', () => {
      this.hexInput.value = this.preferences.color;
      this.hexInput.removeAttribute('aria-invalid');
    });
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
      if (event.key === 'Tab') {
        // macOS Safari otherwise skips buttons when Full Keyboard Access is off.
        // Keep every control reachable with the same order on all desktop engines.
        const controls = Array.from(this.element.querySelectorAll<HTMLElement>('button, input'));
        const index = controls.findIndex((control) => control === document.activeElement);
        const next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0)
          : (index + controls.length + (event.shiftKey ? -1 : 1)) % controls.length;
        event.preventDefault();
        controls[next]?.focus();
      }
    });
    window.addEventListener('pointerdown', (event) => {
      if (this.isOpen && event.target instanceof Node && !this.element.contains(event.target)) this.close();
    });
    // Rotation, the iOS keyboard or a window resize keep the palette open and
    // inside the screen; closing would interrupt typing a HEX color.
    const reposition = () => { if (this.isOpen) this.place(); };
    window.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('resize', reposition);
  }

  get isOpen(): boolean { return !this.element.hidden; }

  open(x: number, y: number, focus = true): void {
    this.element.hidden = false;
    this.anchor = [x, y];
    this.place();
    if (focus) this.element.querySelector<HTMLButtonElement>(`[data-tool="${this.preferences.tool}"]`)?.focus({ preventScroll: true });
  }

  close(focus = true): void {
    if (!this.isOpen) return;
    this.element.hidden = true;
    if (focus) this.actions.restoreFocus();
  }

  setZoom(zoom: number): void {
    this.zoom = zoom;
    const percent = this.percentFormat.format(zoom);
    this.zoomButton.textContent = percent;
    this.zoomButton.setAttribute('aria-label', this.messages.zoomReset(percent));
    this.zoomButton.title = this.messages.zoomReset(percent);
  }

  get zoomLevel(): number { return this.zoom; }

  private place(): void {
    const sheet = window.matchMedia?.(SHEET_QUERY).matches ?? false;
    this.element.classList.toggle('sheet', sheet);
    if (sheet) { this.element.style.left = this.element.style.top = ''; return; }
    const safe = safeArea();
    const view = window.visualViewport;
    const width = view?.width ?? window.innerWidth;
    const height = view?.height ?? window.innerHeight;
    const offsetX = view?.offsetLeft ?? 0;
    const offsetY = view?.offsetTop ?? 0;
    const rect = this.element.getBoundingClientRect();
    const inset = 8;
    const [x, y] = this.anchor;
    const left = Math.max(offsetX + safe.left + inset, Math.min(x, offsetX + width - safe.right - rect.width - inset));
    const top = Math.max(offsetY + safe.top + inset, Math.min(y, offsetY + height - safe.bottom - rect.height - inset));
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }

  private required<T extends Element>(selector: string): T {
    const element = this.element.querySelector<T>(selector);
    if (!element) throw new Error(`Missing palette control: ${selector}`);
    return element;
  }

  private update(patch: Partial<Preferences>): void {
    this.preferences = { ...this.preferences, ...patch };
    this.sync();
    this.actions.change({ ...this.preferences });
  }

  private sync(): void {
    const prefs = this.preferences;
    this.widthInput.value = String(prefs.width);
    this.opacityInput.value = String(prefs.opacity);
    this.colorInput.value = prefs.color;
    this.hexInput.value = prefs.color;
    this.widthOutput.value = `${prefs.width} px`;
    this.opacityOutput.value = this.percentFormat.format(prefs.opacity);
    this.element.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      if (button.dataset.action) return; // Commands, not toggles.
      const selected = button.dataset.tool ? button.dataset.tool === prefs.tool
        : button.dataset.brush ? button.dataset.brush === prefs.brush
        : button.dataset.color === prefs.color;
      button.setAttribute('aria-pressed', String(selected));
    });
  }
}

let probe: HTMLElement | undefined;
// env(safe-area-inset-*) is only readable through a laid-out element.
function safeArea(): { top: number; right: number; bottom: number; left: number } {
  if (!probe) {
    probe = document.createElement('div');
    probe.className = 'safe-area-probe';
    probe.setAttribute('aria-hidden', 'true');
    document.body.append(probe);
  }
  const style = getComputedStyle(probe);
  const px = (value: string) => Number.parseFloat(value) || 0;
  return { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
}

export function toolCursor(tool: Tool): string {
  return tool === 'hand' ? 'grab' : tool === 'eraser' ? 'cell' : 'crosshair';
}
