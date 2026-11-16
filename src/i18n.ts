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
  canvasLabel: 'Endless Drawing — canvas. Right-click or press Shift+F10 to open tools.',
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
  prototypeNote: 'Local prototype · not saved',
  localLimit: (limit: number) => `Local prototype limit: ${limit} strokes. Remove unwanted strokes with the eraser.`,
  strokeTooLarge: 'This stroke is too large. Try drawing a shorter one.',
};

// Adding/removing a key in English requires updating every translation.
export type Messages = typeof en;

const ru: Messages = {
  canvasLabel: 'Endless Drawing — холст. Правый клик или Shift+F10 открывает инструменты.',
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
  prototypeNote: 'Локальный прототип · без сохранения',
  localLimit: (limit: number) => `Лимит локального прототипа: ${limit} штрихов. Удалите ненужные ластиком.`,
  strokeTooLarge: 'Штрих слишком большой. Попробуйте нарисовать его короче.',
};

export const translations: Readonly<Record<Locale, Messages>> = { en, ru };
