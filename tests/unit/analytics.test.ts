import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_ANALYTICS_SITE_ID, startWebAnalytics } from '../../src/analytics';

let script: { async?: boolean; src?: string; dataset: { cfBeacon?: string } };
let existing: boolean;
const append = vi.fn();
const querySelector = vi.fn(() => existing ? script : null);
const createElement = vi.fn(() => script);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PROD', true);
  vi.stubGlobal('location', new URL('https://endlessdrawing.com/'));
  script = { dataset: {} };
  existing = false;
  append.mockImplementation(() => { existing = true; });
  querySelector.mockImplementation(() => existing ? script : null);
  vi.stubGlobal('document', { querySelector, createElement, head: { append } });
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('optional public Cloudflare analytics', () => {
  it.each(['/', '/index.html', '/about', '/about/', '/about/index.html', '/privacy', '/privacy/', '/terms', '/terms/'])(
    'loads the async counter once on production %s with only public configuration', (path) => {
      vi.stubGlobal('location', new URL(path, 'https://endlessdrawing.com'));
      startWebAnalytics(); startWebAnalytics();
      expect(createElement).toHaveBeenCalledExactlyOnceWith('script');
      expect(script.async).toBe(true);
      expect(script.src).toBe('https://static.cloudflareinsights.com/beacon.min.js');
      expect(JSON.parse(script.dataset.cfBeacon!)).toEqual({ token: PUBLIC_ANALYTICS_SITE_ID, spa: false });
      expect(append).toHaveBeenCalledExactlyOnceWith(script);
    });

  it.each(['/admin', '/admin/', '/admin/index.html', '/admin/enroll', '/api/admin/session', '/unknown', '/privacy-not-a-page'])(
    'does not load or touch the DOM on excluded %s', (path) => {
      vi.stubGlobal('location', new URL(path, 'https://endlessdrawing.com'));
      startWebAnalytics();
      expect(querySelector).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    });

  it.each(['http://endlessdrawing.com/', 'https://endlessdrawing.com:8443/', 'https://www.endlessdrawing.com/',
    'http://localhost:5173/', 'http://127.0.0.1:4173/', 'https://staging.endlessdrawing.com/'])(
    'does not count development, previews or other origins: %s', (url) => {
      vi.stubGlobal('location', new URL(url));
      startWebAnalytics();
      expect(append).not.toHaveBeenCalled();
    });

  it('does not count the dev build even when served on the production hostname', () => {
    vi.stubEnv('PROD', false);
    startWebAnalytics();
    expect(append).not.toHaveBeenCalled();
  });

  it('does not add a second counter when another installation already exists', () => {
    existing = true;
    startWebAnalytics();
    expect(createElement).not.toHaveBeenCalled();
  });

  it('never lets an analytics DOM failure break the canvas', () => {
    querySelector.mockImplementationOnce(() => { throw new Error('blocked'); });
    expect(startWebAnalytics).not.toThrow();
    append.mockImplementationOnce(() => { throw new Error('blocked'); });
    expect(startWebAnalytics).not.toThrow();
  });
});
