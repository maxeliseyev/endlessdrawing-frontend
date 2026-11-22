// "Save image" mode UI, opened only from the ⋯ menu like a report: a panel at
// the bottom with a live preview of exactly what goes into the file, and a
// dashed frame with corner handles over the canvas. Pure DOM; selection, hit
// testing and the frame in world units live in main.ts.
import type { Messages } from './i18n';
import { EXPORT_SCALES, type ExportBackground, type ExportScale } from './export';
import type { ScreenRect } from './report';

const CLOSE_ICON = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>';
const SVG = 'http://www.w3.org/2000/svg';
const PREVIEW_WIDTH = 160;
const PREVIEW_HEIGHT = 112;
const NARROW_QUERY = '(max-width: 599px)'; // same breakpoint as the compact sheet in style.css

/** Frame corners clockwise from the top left. */
export type Corner = 0 | 1 | 2 | 3;

export interface ExportActions {
  close: () => void;
  save: () => void;
  fit: () => void;
  scale: (scale: ExportScale) => void;
  background: (background: ExportBackground) => void;
  /** A corner handle was dragged to this client (viewport) position. */
  resize: (corner: Corner, client: readonly [number, number]) => void;
}

export class ExportUI {
  readonly panel = document.createElement('section');
  readonly overlay = document.createElementNS(SVG, 'svg');
  private readonly preview: HTMLCanvasElement;
  private readonly summary: HTMLOutputElement;
  private readonly size: HTMLOutputElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly fitButton: HTMLButtonElement;
  private readonly rect = document.createElementNS(SVG, 'rect');
  private readonly handles: SVGCircleElement[] = [];
  private busy = false;
  private empty = true;

  /** Mounted into `host` only while active: the canvas element stays the only <canvas> otherwise. */
  constructor(private readonly host: HTMLElement, messages: Messages, private readonly actions: ExportActions) {
    this.panel.className = 'export-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', messages.exportLabel);
    this.panel.innerHTML = `
      <canvas class="export-preview" aria-hidden="true"></canvas>
      <div class="export-head">
        <output class="export-summary" aria-live="polite"></output>
        <button type="button" class="icon-button" data-action="close" aria-label="${messages.cancelExport}" title="${messages.cancelExport}">${CLOSE_ICON}</button>
      </div>
      <p class="export-hint">${messages.exportHint}</p>
      <div class="export-options">
        <div class="segmented" role="group" aria-label="${messages.exportScale}">
          ${EXPORT_SCALES.map((scale) => `<button type="button" data-scale="${scale}" aria-pressed="false">${scale}×</button>`).join('')}
        </div>
        <div class="segmented" role="group" aria-label="${messages.exportBackground}">
          <button type="button" data-background="transparent" aria-pressed="false">${messages.exportTransparent}</button>
          <button type="button" data-background="white" aria-pressed="false">${messages.exportWhite}</button>
        </div>
      </div>
      <p class="export-note"><output class="export-size"></output> · ${messages.exportLoadedOnly}</p>
      <div class="export-actions">
        <button type="button" data-action="fit" hidden>${messages.exportFit}</button>
        <button type="button" class="primary" data-action="save" disabled>${messages.exportSave}</button>
      </div>`;
    this.preview = this.panel.querySelector('.export-preview')!;
    this.summary = this.panel.querySelector('.export-summary')!;
    this.size = this.panel.querySelector('.export-size')!;
    this.saveButton = this.panel.querySelector('[data-action="save"]')!;
    this.fitButton = this.panel.querySelector('[data-action="fit"]')!;
    this.panel.addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button');
      if (!button) return;
      const { action, scale, background } = button.dataset;
      if (action === 'close') this.actions.close();
      else if (action === 'save') this.actions.save();
      else if (action === 'fit') this.actions.fit();
      else if (scale) this.actions.scale(Number(scale) as ExportScale);
      else if (background === 'transparent' || background === 'white') this.actions.background(background);
    });

    this.overlay.classList.add('export-frame');
    this.overlay.setAttribute('aria-hidden', 'true');
    this.overlay.style.display = 'none';
    this.overlay.append(this.rect);
    for (const corner of [0, 1, 2, 3] as const) {
      const handle = document.createElementNS(SVG, 'circle');
      handle.setAttribute('r', '7');
      handle.dataset.corner = String(corner);
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener('pointermove', (event) => {
        if (handle.hasPointerCapture(event.pointerId)) this.actions.resize(corner, [event.clientX, event.clientY]);
      });
      this.handles.push(handle);
      this.overlay.append(handle);
    }
  }

  get active(): boolean { return !this.panel.hidden; }

  start(scale: ExportScale, background: ExportBackground): void {
    this.host.append(this.overlay, this.panel);
    this.panel.hidden = false;
    this.overlay.style.display = '';
    this.setOptions(scale, background);
    this.panel.querySelector<HTMLButtonElement>('[data-action="close"]')?.focus({ preventScroll: true });
  }

  stop(): void {
    this.panel.hidden = true;
    this.overlay.style.display = 'none';
    this.busy = false;
    this.overlay.remove();
    this.panel.remove();
  }

  setOptions(scale: ExportScale, background: ExportBackground): void {
    for (const button of this.panel.querySelectorAll<HTMLButtonElement>('[data-scale]')) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.scale) === scale));
    }
    for (const button of this.panel.querySelectorAll<HTMLButtonElement>('[data-background]')) {
      button.setAttribute('aria-pressed', String(button.dataset.background === background));
    }
    this.preview.classList.toggle('transparent', background === 'transparent');
  }

  setSummary(text: string): void {
    if (this.summary.value !== text) this.summary.value = text;
  }

  /** Pixel size of the file, or nothing to save. */
  setSize(text: string | undefined): void {
    this.empty = text === undefined;
    const value = text ?? '—';
    if (this.size.value !== value) this.size.value = value;
    this.saveButton.disabled = this.empty || this.busy;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.saveButton.disabled = this.empty || busy;
  }

  /** A frame adjusted by hand stops following the selection until "Fit to drawings". */
  setManual(manual: boolean): void { this.fitButton.hidden = !manual; }

  /** The frame on screen in CSS pixels, or none when nothing is selected. */
  frame(rect: ScreenRect | undefined): void {
    const shown = rect !== undefined;
    this.rect.style.display = shown ? '' : 'none';
    for (const handle of this.handles) handle.style.display = shown ? '' : 'none';
    if (!rect) return;
    this.rect.setAttribute('x', String(rect.x)); this.rect.setAttribute('y', String(rect.y));
    this.rect.setAttribute('width', String(Math.max(0, rect.width))); this.rect.setAttribute('height', String(Math.max(0, rect.height)));
    const corners = [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height]];
    this.handles.forEach((handle, index) => {
      handle.setAttribute('cx', String(corners[index]![0])); handle.setAttribute('cy', String(corners[index]![1]));
    });
  }

  /** Redraws the preview with the aspect ratio of the frame (empty when nothing is selected). */
  drawPreview(aspect: number | undefined, paint: (context: CanvasRenderingContext2D, width: number, height: number) => void): void {
    const ratio = window.devicePixelRatio || 1;
    // Phones get a smaller preview so the compact sheet leaves the drawing visible.
    const [boxWidth, boxHeight] = matchMedia(NARROW_QUERY).matches ? [96, 72] : [PREVIEW_WIDTH, PREVIEW_HEIGHT];
    const fit = aspect && Number.isFinite(aspect) && aspect > 0
      ? (aspect >= boxWidth / boxHeight ? [boxWidth, boxWidth / aspect] : [boxHeight * aspect, boxHeight])
      : [boxWidth, boxHeight];
    const cssWidth = Math.max(1, Math.round(fit[0]!)), cssHeight = Math.max(1, Math.round(fit[1]!));
    this.preview.style.width = `${cssWidth}px`;
    this.preview.style.height = `${cssHeight}px`;
    this.preview.width = Math.round(cssWidth * ratio);
    this.preview.height = Math.round(cssHeight * ratio);
    const context = this.preview.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, this.preview.width, this.preview.height);
    if (aspect) paint(context, this.preview.width, this.preview.height);
  }
}
