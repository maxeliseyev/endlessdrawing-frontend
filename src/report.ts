// Report mode UI, the same flow as the iPad app: taps select other people's
// strokes (dashed outlines), the bar opens a reason dialog, sending hides them
// here right away. Pure DOM; selection and hit testing live in main.ts.
import type { Messages } from './i18n';
import { REPORT_REASONS, type ReportReason } from './safety';

const CLOSE_ICON = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>';
const SVG = 'http://www.w3.org/2000/svg';

export interface ReportActions {
  cancel: () => void;
  send: (reason: ReportReason, blockAuthor: boolean) => void;
}

export type ScreenRect = { x: number; y: number; width: number; height: number };

export class ReportUI {
  readonly bar = document.createElement('div');
  readonly outlines = document.createElementNS(SVG, 'svg');
  readonly dialog = document.createElement('dialog');
  private readonly count: HTMLOutputElement;
  private readonly next: HTMLButtonElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly body: HTMLElement;

  constructor(private readonly messages: Messages, private readonly actions: ReportActions) {
    this.bar.className = 'report-bar';
    this.bar.hidden = true;
    this.bar.setAttribute('role', 'toolbar');
    this.bar.setAttribute('aria-label', messages.report);
    this.bar.innerHTML = `
      <output aria-live="polite"></output>
      <button type="button" class="primary" data-action="next" disabled>${messages.report}</button>
      <button type="button" class="icon-button" data-action="cancel" aria-label="${messages.cancelReport}" title="${messages.cancelReport}">${CLOSE_ICON}</button>`;
    this.count = this.bar.querySelector('output')!;
    this.next = this.bar.querySelector('[data-action="next"]')!;
    this.bar.addEventListener('click', (event) => {
      const action = (event.target as Element).closest<HTMLButtonElement>('button')?.dataset.action;
      if (action === 'cancel') this.actions.cancel();
      else if (action === 'next') this.openDialog();
    });

    this.outlines.classList.add('report-outlines');
    this.outlines.setAttribute('aria-hidden', 'true');
    this.outlines.style.display = 'none';

    const reasons: Record<ReportReason, string> = {
      sexual: messages.reasonSexual, violence: messages.reasonViolence, hate: messages.reasonHate,
      illegal: messages.reasonIllegal, spam: messages.reasonSpam, other: messages.reasonOther,
    };
    this.dialog.className = 'report-dialog';
    this.dialog.setAttribute('aria-labelledby', 'report-title');
    this.dialog.innerHTML = `
      <div class="report-body">
        <h2 id="report-title">${messages.report}</h2>
        <fieldset>
          <legend>${messages.reportQuestion}</legend>
          ${REPORT_REASONS.map((reason) => `<label><input type="radio" name="reason" value="${reason}" /> ${reasons[reason]}</label>`).join('')}
        </fieldset>
        <label class="block"><input type="checkbox" name="block" checked /> ${messages.blockAuthor}</label>
        <p class="footnote">${messages.reportFooter}</p>
        <div class="buttons">
          <button type="button" data-action="dismiss">${messages.cancel}</button>
          <button type="button" class="primary" data-action="send" disabled>${messages.send}</button>
        </div>
      </div>`;
    // No <form>: the public canvas has none (no login-like controls, see admin e2e).
    this.body = this.dialog.querySelector('.report-body')!;
    this.sendButton = this.dialog.querySelector('[data-action="send"]')!;
    this.body.addEventListener('change', () => { this.sendButton.disabled = !this.reason(); });
    this.dialog.querySelector('[data-action="dismiss"]')!.addEventListener('click', () => this.dialog.close());
    this.sendButton.addEventListener('click', () => {
      const reason = this.reason();
      if (!reason) return;
      const block = this.body.querySelector<HTMLInputElement>('input[name="block"]')!.checked;
      this.dialog.close();
      this.actions.send(reason, block);
    });
  }

  get active(): boolean { return !this.bar.hidden; }
  get dialogOpen(): boolean { return this.dialog.open; }

  start(): void {
    this.bar.hidden = false;
    this.outlines.style.display = '';
    this.setCount(0);
    this.bar.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.focus({ preventScroll: true });
  }

  stop(): void {
    if (this.dialog.open) this.dialog.close();
    this.bar.hidden = true;
    this.outlines.style.display = 'none';
    this.outlines.replaceChildren();
  }

  setCount(count: number): void {
    this.count.value = count ? this.messages.reportSelected(count) : this.messages.reportTapHint;
    this.next.disabled = count === 0;
  }

  /** Dashed rectangles around the selected strokes, in CSS pixels. */
  outline(rects: readonly ScreenRect[]): void {
    this.outlines.replaceChildren(...rects.map((r) => {
      const rect = document.createElementNS(SVG, 'rect');
      rect.setAttribute('x', String(r.x - 4)); rect.setAttribute('y', String(r.y - 4));
      rect.setAttribute('width', String(Math.max(0, r.width + 8))); rect.setAttribute('height', String(Math.max(0, r.height + 8)));
      rect.setAttribute('rx', '4');
      return rect;
    }));
  }

  private openDialog(): void {
    for (const input of this.body.querySelectorAll<HTMLInputElement>('input[name="reason"]')) input.checked = false;
    this.body.querySelector<HTMLInputElement>('input[name="block"]')!.checked = true;
    this.sendButton.disabled = true;
    this.dialog.showModal();
  }

  private reason(): ReportReason | undefined {
    const value = this.body.querySelector<HTMLInputElement>('input[name="reason"]:checked')?.value;
    return REPORT_REASONS.find((reason) => reason === value);
  }
}
