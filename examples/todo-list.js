import { signal, html } from "trie";

let todoCount = 0;
function todoId() {
  return ++todoCount;
}

const initialTodos = [...Array(3)].map(() => ({
  id: todoId(),
  checked: false,
  text: "",
}));

export function TodoList() {
  console.log("[TodoList] rendering");

  const $todos = signal(initialTodos);

  return () => html`
    <div>
      <h1 style="display: inline">Todos</h1>
      <button
        onClick=${() =>
          $todos.val.push({ id: todoId(), text: "", checked: false })}
      >
        +
      </button>
      <button onClick=${() => $todos.val.pop()}>-</button>
      <button onClick=${() => $todos.val.reverse()}>↑↓</button>
    </div>
    ${$todos.val.map(
      // DEV: might be difficult to prevent declarations here
      (todo) =>
        html(todo.id)`
          <Todo id=${todo.id} $todos=${$todos} />
        `,
    )}
  `;
}

export function Todo(p) {
  console.log(`[Todo ${p.id}] rendering`);

  // DEV: this is still going to cause perf issues
  // - a lazy computed fn could help with this
  const $todo = p.$todos.val.find((todo) => todo.id === p.id);

  return () => html`
    <div>
      <input
        type="checkbox"
        checked=${$todo.checked}
        onInput=${(e) => ($todo.checked = e.target.checked)}
      />
      <input
        type="text"
        placeholder=${`To do [${p.id}]`}
        value=${$todo.text}
        onInput=${(e) => ($todo.text = e.target.value)}
      />
      <button
        onClick=${() => {
          const index = p.$todos.val.findIndex((todo) => todo.id === p.id);

          p.$todos.val.splice(index + 1, 0, {
            id: todoId(),
            text: "",
            checked: false,
          });
        }}
      >
        +
      </button>
      <button onClick=${() => p.$todos.val.splice(index, 1)}>-</button>
    </div>
  `;
}
