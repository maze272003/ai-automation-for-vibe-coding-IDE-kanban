import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentTypeFor, resolveUiFile } from '../src/main/ui-path.ts';

const root = path.resolve('C:/app/ui');

describe('resolveUiFile', () => {
  it('maps app://ui URLs to files under the UI root', () => {
    expect(resolveUiFile(root, 'app://ui/')).toBe(path.join(root, 'index.html'));
    expect(resolveUiFile(root, 'app://ui/index.html')).toBe(path.join(root, 'index.html'));
    expect(resolveUiFile(root, 'app://ui/assets/main-abc.js')).toBe(path.join(root, 'assets', 'main-abc.js'));
  });
  it('blocks traversal, including encoded backslashes', () => {
    expect(resolveUiFile(root, 'app://ui/..%5c..%5cWindows%5cwin.ini')).toBeNull();
    expect(resolveUiFile(root, 'app://ui/%2e%2e%5csecret.txt')).toBeNull();
  });
  it('rejects other hosts and schemes', () => {
    expect(resolveUiFile(root, 'app://evil/index.html')).toBeNull();
    expect(resolveUiFile(root, 'file:///C:/app/ui/index.html')).toBeNull();
  });
});

describe('contentTypeFor', () => {
  it('knows the bundle file types', () => {
    expect(contentTypeFor('a.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('a.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('a.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('a.bin')).toBe('application/octet-stream');
  });
});
