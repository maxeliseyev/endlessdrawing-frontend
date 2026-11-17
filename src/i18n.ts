export type Locale = 'en' | 'ru';

// Follow browser preference order. Unsupported languages fall through to the
// next supported one; an entirely unsupported/missing list defaults to English.
export function resolveLocale(languages: readonly string[], language?: string): Locale {
  const preferences = languages.length ? languages : [language ?? ''];
  for (const preference of preferences) {
    const base = preference.trim().toLowerCase().split('-')[0];
    if (base === 'en' || base === 'ru') return base;
  }
  return 'en';
}

const en = {
  canvasLabel: 'Endless Drawing — canvas. Right-click, long-press or press Shift+F10 to open tools.',
  paletteLabel: 'Drawing tools',
  toolLabel: 'Tool',
  brush: 'Brush',
  hand: 'Hand',
  eraser: 'Eraser',
  brushShape: 'Brush shape',
  roundBrush: 'Round brush',
  squareBrush: 'Square brush',
  chiselBrush: 'Chisel pen',
  sprayBrush: 'Spray',
  width: 'Width',
  color: 'Color',
  colors: 'Colors',
  colorSwatch: (color: string) => `Color ${color}`,
  chooseColor: 'Choose color',
  hexColor: 'HEX color',
  opacity: 'Opacity',
  panHint: 'Space + drag — pan',
  undoHint: 'Ctrl / ⌘ Z — undo',
  zoomHint: 'Ctrl / ⌘ + wheel or pinch — zoom',
  touchPanHint: 'Two fingers — move and zoom',
  touchPaletteHint: 'Long press — tools',
  undo: 'Undo',
  zoomLabel: 'Zoom',
  zoomOut: 'Zoom out',
  zoomIn: 'Zoom in',
  zoomReset: (percent: string) => `Zoom ${percent}. Reset to 100%`,
  strokeTooLarge: 'This stroke is too large. Try drawing a shorter one.',
  offline: 'No connection. Your strokes will be sent when it is back.',
  rejected: 'The server did not accept this stroke.',
  deleteFailed: 'Could not remove the stroke.',
  pendingLimit: 'Too many strokes are waiting to be sent. Wait a moment.',
  dense: 'This area is very dense: some strokes are not shown. Zoom in.',
  protocol: 'Connection problem. Reconnecting…',
};

// Adding/removing a key in English requires updating every translation.
export type Messages = typeof en;

const ru: Messages = {
  canvasLabel: 'Endless Drawing — холст. Правый клик, долгое нажатие или Shift+F10 открывает инструменты.',
  paletteLabel: 'Инструменты рисования',
  toolLabel: 'Инструмент',
  brush: 'Кисть',
  hand: 'Рука',
  eraser: 'Ластик',
  brushShape: 'Форма кисти',
  roundBrush: 'Круглая кисть',
  squareBrush: 'Квадратная кисть',
  chiselBrush: 'Косое перо',
  sprayBrush: 'Спрей',
  width: 'Толщина',
  color: 'Цвет',
  colors: 'Цвета',
  colorSwatch: (color: string) => `Цвет ${color}`,
  chooseColor: 'Выбрать цвет',
  hexColor: 'Цвет HEX',
  opacity: 'Непрозрачность',
  panHint: 'Space + drag — перемещение',
  undoHint: 'Ctrl / ⌘ Z — отмена',
  zoomHint: 'Ctrl / ⌘ + колесо или щипок — масштаб',
  touchPanHint: 'Два пальца — перемещение и масштаб',
  touchPaletteHint: 'Долгое нажатие — инструменты',
  undo: 'Отменить',
  zoomLabel: 'Масштаб',
  zoomOut: 'Уменьшить',
  zoomIn: 'Увеличить',
  zoomReset: (percent: string) => `Масштаб ${percent}. Сбросить до 100%`,
  strokeTooLarge: 'Штрих слишком большой. Попробуйте нарисовать его короче.',
  offline: 'Нет соединения. Штрихи отправятся, когда оно восстановится.',
  rejected: 'Сервер не принял этот штрих.',
  deleteFailed: 'Не удалось удалить штрих.',
  pendingLimit: 'Слишком много штрихов ждут отправки. Подождите немного.',
  dense: 'Здесь очень плотно: часть штрихов не показана. Увеличьте масштаб.',
  protocol: 'Проблема соединения. Переподключение…',
};

export const translations: Readonly<Record<Locale, Messages>> = { en, ru };
