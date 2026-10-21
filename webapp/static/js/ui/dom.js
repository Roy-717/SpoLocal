/**
 * Small DOM helpers shared by view controllers.
 * Keeps element construction readable without pulling in a framework.
 */
export class Dom {
    /** Element with a class and optional text. */
    static el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    /** Lazy image that fades out instead of showing a broken icon. */
    static cover(src, className) {
        const img = Dom.el('img', className);
        img.src = src || '';
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.onerror = function () {
            this.onerror = null;
            this.style.opacity = '0';
        };
        return img;
    }

    /** Bind a listener once per element, keyed by name. */
    static bind_once(node, key, event, handler, options) {
        if (!node) return false;
        const flag = 'bound' + key;
        if (node.dataset[flag]) return false;
        node.dataset[flag] = '1';
        node.addEventListener(event, handler, options);
        return true;
    }
}
