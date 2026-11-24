/**
 * Builds the page's elements with DOM APIs. Text goes in as text nodes, never as markup, so that
 * what devices and clients wrote, such as log messages and device names, shows as text. No
 * helper sets a `style` attribute or an event handler attribute, which the page's content
 * security policy refuses anyway; styles come from classes, or from `element.style`.
 *
 * @decision .agents/decisions/261124_055114-rack-dashboard.md#who-can-use-the-dashboard
 */

/** What an element takes as a child: a node, or text. */
export type Child = Node | string | number | null | undefined | false;

/** The properties that {@link el} sets on an element. */
export interface Props {
  /** Its classes, separated by spaces. */
  class?: string;
  /** Its tooltip, as text. */
  title?: string;
  /** Other attributes, such as `aria-label`, `type`, or `data-device`. */
  attrs?: Record<string, string>;
}

/** Attributes that no helper sets: inline styles, and handlers, which would run text as code. */
function refused(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "style" || lower.startsWith("on") || lower === "srcdoc";
}

/**
 * Sets an attribute, refusing the ones that would carry style or code.
 *
 * @param element The element.
 * @param name The attribute.
 * @param value Its value, as text.
 * @throws Error for `style`, `srcdoc`, or an `on…` handler.
 */
export function setAttr(element: Element, name: string, value: string): void {
  if (refused(name)) throw new Error(`the page doesn't set the attribute ${name}`);
  element.setAttribute(name, value);
}

/**
 * Appends children to a node, text as text nodes.
 *
 * @param parent The node.
 * @param children Nodes, text, or nothing.
 */
export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

/**
 * Makes an HTML element.
 *
 * @param tag Its tag.
 * @param props Its classes, tooltip, and other attributes.
 * @param children Its children; text becomes text nodes.
 * @returns The element.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props !== null) {
    if (props.class !== undefined) element.className = props.class;
    if (props.title !== undefined) element.title = props.title;
    for (const [name, value] of Object.entries(props.attrs ?? {})) setAttr(element, name, value);
  }
  append(element, ...children);
  return element;
}

/** The namespace of SVG elements. */
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Makes an SVG element.
 *
 * @param tag Its tag.
 * @param attrs Its attributes, such as `d` or `viewBox`.
 * @param children Its children; text becomes text nodes.
 * @returns The element.
 */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) setAttr(element, name, String(value));
  append(element, ...children);
  return element;
}

/**
 * Replaces a node's children.
 *
 * @param parent The node.
 * @param children Its new children; text becomes text nodes.
 */
export function replace(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, ...children);
}

/** One child of a list that {@link reconcile} keeps. */
export interface KeyedItem {
  /** Which item it is, such as a record's `seq`. */
  id: string;
  /** What it shows; a node whose key didn't change stays, with any text the operator selected. */
  key: string;
  /** Makes its node when it is new, or its key changed. */
  build: () => Element;
}

const keyedNodes = new WeakMap<Element, Map<string, { key: string; node: Element }>>();

/**
 * Makes a parent's children the nodes of a list of items, in order, keeping the nodes of the
 * items whose key didn't change, and moving as few nodes as it can: new records at the top of a
 * list are inserted there, and the ones that left are removed.
 *
 * @param parent The parent, whose children only this function changes.
 * @param items The items, in order.
 */
export function reconcile(parent: Element, items: Iterable<KeyedItem>): void {
  const before = keyedNodes.get(parent) ?? new Map<string, { key: string; node: Element }>();
  const after = new Map<string, { key: string; node: Element }>();
  const nodes: Element[] = [];
  for (const item of items) {
    if (after.has(item.id)) continue;
    const kept = before.get(item.id);
    const node = kept !== undefined && kept.key === item.key ? kept.node : item.build();
    after.set(item.id, { key: item.key, node });
    nodes.push(node);
  }
  const keep = new Set<Node>(nodes);
  for (const child of [...parent.childNodes]) if (!keep.has(child)) child.remove();
  let cursor: ChildNode | null = parent.firstChild;
  for (const node of nodes) {
    if (cursor === node) {
      cursor = cursor.nextSibling;
      continue;
    }
    parent.insertBefore(node, cursor);
  }
  keyedNodes.set(parent, after);
}

/**
 * Makes a button.
 *
 * @param label Its text.
 * @param onClick What a click does.
 * @param props Its classes and attributes.
 * @returns The button, of type `button`.
 */
export function button(label: Child, onClick: () => void, props: Props = {}): HTMLButtonElement {
  const element = el("button", { ...props, attrs: { type: "button", ...props.attrs } }, label);
  element.addEventListener("click", onClick);
  return element;
}
