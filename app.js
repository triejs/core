import { html, signal } from "./helix_v2.js";

export function Counter() {
  const $count = signal(0);

  return html`
    <button onclick=${() => $count.val++}>count: ${$count.val}</button>
  `;
}

export function MyInput() {
  // Hooray, this no longer works...
  const $text = signal(`"><img src="x" onerror="alert('gotcha!')">`);

  return html`
    <input value=${$text.val} oninput=${(e) => ($text.val = e.target.value)} />
  `;
}
