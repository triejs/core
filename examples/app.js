import { html, signal } from "trie";

export * from "./todo-list.js";

export function Counter() {
  const $count = signal(0);

  console.log("[Counter] rendering");

  return () => html`
    <div>${$count.val}</div>
    <button onclick=${() => $count.val++}>↑</button>
    <button onclick=${() => $count.val--}>↓</button>
  `;
}

export function MyInput() {
  // Hooray, this no longer works...
  const $text = signal(`"><img src="x" onerror="alert('gotcha!')">`);

  return html`
    <input value=${$text.val} oninput=${(e) => ($text.val = e.target.value)} />
  `;
}

export function CounterWithInput() {
  const $count = signal(0);
  const $text = signal("");

  return html`
    <button onclick=${() => $count.val++}>count: ${$count.val}</button>
    <input value=${$text.val} oninput=${(e) => ($text.val = e.target.value)} />
  `;
}
