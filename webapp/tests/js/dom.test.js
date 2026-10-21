import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Dom } from '../../static/js/ui/dom.js';

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
});

describe('el', () => {
    it('creates an element with a class and text', () => {
        const node = Dom.el('span', 'home-stat', 'Hello');
        expect(node.tagName).toBe('SPAN');
        expect(node.className).toBe('home-stat');
        expect(node.textContent).toBe('Hello');
    });

    it('skips the class when it is empty', () => {
        const node = Dom.el('div', '', 'x');
        expect(node.className).toBe('');
        expect(node.textContent).toBe('x');
    });

    it('leaves the text empty when it is null or undefined', () => {
        expect(Dom.el('div', 'a').textContent).toBe('');
        expect(Dom.el('div', 'a', null).textContent).toBe('');
        expect(Dom.el('div', 'a', undefined).textContent).toBe('');
    });

    it('keeps falsy but defined text such as zero', () => {
        expect(Dom.el('div', 'a', 0).textContent).toBe('0');
    });
});

describe('cover', () => {
    it('builds a lazy image with the given source and class', () => {
        const img = Dom.cover('/cover.jpg', 'home-cover');
        expect(img.tagName).toBe('IMG');
        expect(img.className).toBe('home-cover');
        expect(img.getAttribute('src')).toBe('/cover.jpg');
        expect(img.alt).toBe('');
        expect(img.loading).toBe('lazy');
        expect(img.decoding).toBe('async');
    });

    it('uses an empty source when none is given', () => {
        expect(Dom.cover('', 'c').getAttribute('src')).toBe('');
        expect(Dom.cover(null, 'c').getAttribute('src')).toBe('');
    });

    it('fades out and unbinds itself on a load error', () => {
        const img = Dom.cover('/missing.jpg', 'c');
        img.dispatchEvent(new Event('error'));
        expect(img.style.opacity).toBe('0');
        expect(img.onerror).toBe(null);
    });
});

describe('bind_once', () => {
    it('binds a listener only once per key', () => {
        const node = document.createElement('button');
        const handler = vi.fn();
        expect(Dom.bind_once(node, 'click', 'click', handler)).toBe(true);
        expect(Dom.bind_once(node, 'click', 'click', handler)).toBe(false);
        node.click();
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('allows a second key on the same node', () => {
        const node = document.createElement('button');
        const first = vi.fn();
        const second = vi.fn();
        expect(Dom.bind_once(node, 'first', 'click', first)).toBe(true);
        expect(Dom.bind_once(node, 'second', 'click', second)).toBe(true);
        node.click();
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('passes listener options through', () => {
        const node = document.createElement('button');
        const handler = vi.fn();
        Dom.bind_once(node, 'once', 'click', handler, { once: true });
        node.click();
        node.click();
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('returns false for a missing node', () => {
        expect(Dom.bind_once(null, 'click', 'click', vi.fn())).toBe(false);
    });
});
