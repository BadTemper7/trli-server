import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

for (const [label, path] of [
  ['Admin', '../../admin/src/components/documents/AdminDocumentPreview.jsx'],
  ['Client', '../../client/src/components/documents/DocumentPreview.jsx'],
]) {
  test(`${label} document preview uses the viewport height and keeps the PDF frame flexible`, () => {
    const component = source(path);
    assert.match(component, /height: '94vh', maxHeight: 'calc\(100dvh - 16px\)'/);
    assert.match(component, /className="min-h-0 flex-1 overflow-auto bg-slate-100/);
    assert.match(component, /<iframe[^>]+className="block h-full min-h-0 w-full rounded-lg border-0 bg-white"/s);
    assert.doesNotMatch(component, /height: '70vh'/);
    assert.doesNotMatch(component, /min-h-80/);
    for (const action of ['Download', 'Open', 'Printer', 'onClose']) {
      // Admin closes via a `close` function; both still provide the same operations.
      if (label === 'Admin' && action === 'onClose') continue;
      assert.ok(component.includes(action), `Missing ${action} action`);
    }
  });
}
