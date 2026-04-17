const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const editorPath = path.resolve(__dirname, '..', 'CocosCreator_RichText_Editor.html');

async function loadEditor() {
  const dom = await JSDOM.fromFile(editorPath, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.navigator.clipboard = {
        writeText: async () => {},
      };
      window.document.execCommand = () => true;
      if (window.Range && !window.Range.prototype.getClientRects) {
        window.Range.prototype.getClientRects = function () {
          return [];
        };
      }
    },
  });

  await new Promise(resolve => {
    dom.window.addEventListener('load', () => resolve(), { once: true });
  });

  return dom;
}

function getViz(window) {
  return window.document.getElementById('viz');
}

function getBBCode(window) {
  return window.document.getElementById('bbcode').textContent;
}

function collectTextNodes(root) {
  const walker = root.ownerDocument.createTreeWalker(root, root.ownerDocument.defaultView.NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function locateTextOffset(root, absoluteOffset) {
  const nodes = collectTextNodes(root);
  let remaining = absoluteOffset;
  for (const node of nodes) {
    const length = node.nodeValue.length;
    if (remaining <= length) {
      return { node, offset: remaining };
    }
    remaining -= length;
  }
  const lastNode = nodes.at(-1);
  if (!lastNode) throw new Error('No text nodes found in editor');
  return { node: lastNode, offset: lastNode.nodeValue.length };
}

function setTextSelection(window, start, end) {
  const viz = getViz(window);
  const range = window.document.createRange();
  const startPoint = locateTextOffset(viz, start);
  const endPoint = locateTextOffset(viz, end);
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  window.saveCurrentSelection();
  return range;
}

function setNodeSelection(window, node) {
  const range = window.document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  window.saveCurrentSelection();
  return range;
}

test('partial recolor keeps outer segments intact', async () => {
  const dom = await loadEditor();
  const { window } = dom;

  getViz(window).textContent = '12345';
  window.updateBBCode();

  setTextSelection(window, 0, 5);
  window.wrapSelection('color', { color: '#111111' });
  setTextSelection(window, 1, 4);
  window.wrapSelection('color', { color: '#222222' });

  assert.equal(getBBCode(window), '<color=#111111>1<color=#222222>234</color>5</color>');
  dom.window.close();
});

test('recoloring a full existing color span updates instead of nesting', async () => {
  const dom = await loadEditor();
  const { window } = dom;

  window.importBBCodeToEditor('<color=#111111>12345</color>');
  const colorSpan = getViz(window).querySelector('span[data-tag="color"]');
  setNodeSelection(window, colorSpan);
  window.wrapSelection('color', { color: '#333333' });

  assert.equal(getBBCode(window), '<color=#333333>12345</color>');
  dom.window.close();
});

test('wrapping a mixed selection across nested nodes preserves inner formatting', async () => {
  const dom = await loadEditor();
  const { window } = dom;

  window.importBBCodeToEditor('1<color=#00ff00>23</color>4');
  setTextSelection(window, 0, 4);
  window.wrapSelection('b');

  assert.equal(getBBCode(window), '<b>1<color=#00ff00>23</color>4</b>');
  dom.window.close();
});

test('clear format on an exact tagged range removes that wrapper only', async () => {
  const dom = await loadEditor();
  const { window } = dom;

  window.importBBCodeToEditor('<color=#abcdef>123</color>');
  const colorSpan = getViz(window).querySelector('span[data-tag="color"]');
  setNodeSelection(window, colorSpan);
  window.clearSelectionFormatting();

  assert.equal(getBBCode(window), '123');
  dom.window.close();
});

test('imports and exports on tags with click and param', async () => {
  const dom = await loadEditor();
  const { window } = dom;

  const source = '<on click="openPanel" param="shop_1">Go</on>';
  window.importBBCodeToEditor(source);

  assert.equal(getBBCode(window), source);
  const node = getViz(window).querySelector('span[data-tag="on"]');
  assert.equal(node.dataset.onClick, 'openPanel');
  assert.equal(node.dataset.onParam, 'shop_1');
  dom.window.close();
});

test('imports and exports img tags with optional attributes', async () => {
  const dom = await loadEditor();
  const { window } = dom;

  const source = "<img src='textures/icon/star' width=32 height=16 align=top offset='3,4' click='tapStar' />";
  window.importBBCodeToEditor(source);

  assert.equal(getBBCode(window), source);
  const node = getViz(window).querySelector('span[data-tag="img"]');
  assert.equal(node.dataset.src, 'textures/icon/star');
  assert.equal(node.dataset.width, '32');
  assert.equal(node.dataset.height, '16');
  assert.equal(node.dataset.align, 'top');
  assert.equal(node.dataset.offset, '3,4');
  assert.equal(node.dataset.click, 'tapStar');
  dom.window.close();
});

test('normalizes duplicate adjacent tags with the same attributes', async () => {
  const dom = await loadEditor();
  const { window } = dom;

  getViz(window).innerHTML =
    '<span data-tag="color" data-color="#123456" style="color:#123456;">12</span><span data-tag="color" data-color="#123456" style="color:#123456;">34</span>';
  window.updateBBCode();

  assert.equal(getBBCode(window), '<color=#123456>1234</color>');
  assert.equal(getViz(window).querySelectorAll('span[data-tag="color"]').length, 1);
  dom.window.close();
});

test('escapes text and attribute entities during export', async () => {
  const dom = await loadEditor();
  const { window } = dom;

  getViz(window).textContent = 'A&B<C>';
  window.updateBBCode();
  assert.equal(getBBCode(window), 'A&amp;B&lt;C&gt;');

  window.importBBCodeToEditor('<on click="say&go" param="x<y">T</on>');
  assert.equal(getBBCode(window), '<on click="say&amp;go" param="x&lt;y">T</on>');
  dom.window.close();
});

test('rejects invalid closing tags during import', async () => {
  const dom = await loadEditor();
  const { window } = dom;

  assert.throws(() => window.importBBCodeToEditor('<b>123</i>'), /Invalid closing tag/);
  assert.throws(() => window.importBBCodeToEditor('<color=#fff>123'), /Unclosed tag/);
  dom.window.close();
});
