const phraseTypes = {
  IDENTIFIER: "identifier",
  ATTRIBUTE: "attribute",
  HTML: "html",
  SLOT: "slot",
  COMPONENT: "component",
};

const INVALID_ARRAY_ITEM =
  "Each element in an array must be wrapped in html(key)`...`";
const MISSING_ARRAY_ITEM_KEY =
  "Each element in an array must have a key. Pass one like this: html(key)`...`";

// TODO
function debug(...msg) {
  console.log(...msg);
}

function isTemplate(value) {
  return value && value._isTemplateNode;
}

function isPrimitive(value) {
  return (
    value === null ||
    typeof value === "undefined" ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  );
}

function canRenderPrimitive(value) {
  return typeof value === "string" || typeof value === "number";
}

function isTemplateMatch(a, b) {
  if (!a.hash && !b.hash) {
    return a === b;
  }
  return a.hash === b.hash;
}

function isMergeable(phrase) {
  return phrase && phrase.type === phraseTypes.HTML;
}

function mergePhrases(phrases) {
  return phrases.reduce((acc, phrase) => {
    if (!acc.length) {
      return [phrase];
    } else {
      const prev = acc.at(-1);

      if (isMergeable(prev) && isMergeable(phrase)) {
        return [
          ...acc.slice(0, -1),
          { ...prev, value: prev.value + phrase.value },
        ];
      } else {
        return [...acc, phrase];
      }
    }
  }, []);
}

function html(htmlStringsOrConfig, ...interpolations) {
  if (Array.isArray(htmlStringsOrConfig)) {
    const strings = htmlStringsOrConfig;
    return getTemplateBuilder(undefined, strings, ...interpolations)();
  } else if (
    typeof htmlStringsOrConfig === "string" ||
    typeof htmlStringsOrConfig === "number"
  ) {
    const key = htmlStringsOrConfig;
    return getTemplateBuilder(key);
  } else {
    const config = htmlStringsOrConfig;
    return getTemplateBuilder(config.key);
  }
}

// TODO: figure out how to make templates cacheable
function getTemplateBuilder(key, defaultHtmlStrings, ...defaultInterpolations) {
  return (htmlStrings, ...interpolations) => {
    const htmlStringsWithDefaults = [...(htmlStrings || defaultHtmlStrings)];

    return {
      _isTemplateNode: true,
      assignedkey: "i_" + key,
      // NOTE: when determining dom changes object equality can be used instead
      // of a hash for templates created when parsing component children
      hash: htmlStringsWithDefaults.join("_"),
      interpolations: interpolations.length
        ? interpolations
        : defaultInterpolations,
      htmlStrings: htmlStringsWithDefaults,
      parsedHtmlPhrases: [],
      identifiers: [],
      slots: [],
      attributes: [],
      listeners: [],
      props: [],
    };
  };
}

// TODO: trim inter-element whitespace

// TODO: more work here and in a renderToString to make sure components are
// passed around properly
function parseTemplateInPlace(template) {
  let isOpeningTag = false;
  let isClosingTag = false;
  let isComponentTag = false;
  let isAttr = false;
  let suffix = 0;

  const templateStack = [template];

  function prevPhrase() {
    return templateStack.at(-1).parsedHtmlPhrases.at(-1);
  }

  function pushPhrase(phrase) {
    templateStack.at(-1).parsedHtmlPhrases.push(phrase);
  }

  function getIdentifiers() {
    return templateStack.at(-1).identifiers;
  }

  template.htmlStrings.forEach((fragment, i) => {
    // Add a closing identifier for slots
    if (!isOpeningTag && !isClosingTag && i !== 0) {
      pushPhrase({
        type: phraseTypes.IDENTIFIER,
        index: getIdentifiers().length - 1,
      });
    }

    let unparsedFragment = fragment;
    while (unparsedFragment.length) {
      let controlCharsIndex = unparsedFragment.split("").findIndex(
        (char, i) =>
          // Opening tag start
          (!isOpeningTag &&
            !isAttr &&
            char === "<" &&
            unparsedFragment[i + 1] !== "/") ||
          // Attribute start or end
          (isOpeningTag && char === '"') ||
          // Closing tag start (only matters for component tags)
          (templateStack.length > 1 &&
            !isOpeningTag &&
            !isAttr &&
            char === "<" &&
            unparsedFragment[i + 1] === "/") ||
          // Tag end
          (((isOpeningTag && !isAttr) || isClosingTag) && char === ">"),
      );

      if (controlCharsIndex < 0 && !isComponentTag) {
        pushPhrase({ type: phraseTypes.HTML, value: unparsedFragment });
        break;
      }

      let controlChars =
        unparsedFragment[controlCharsIndex] === "<" &&
        unparsedFragment[controlCharsIndex + 1] === "/"
          ? "</"
          : unparsedFragment[controlCharsIndex];

      switch (controlChars) {
        // Handle tag start
        case "<":
          if (controlCharsIndex !== 0) {
            pushPhrase({
              type: phraseTypes.HTML,
              value: unparsedFragment.slice(0, controlCharsIndex),
            });
          }

          if (/[A-Z]/.test(unparsedFragment[controlCharsIndex + 1])) {
            isComponentTag = true;
            getIdentifiers().push({ suffix });
            suffix++;

            pushPhrase({
              type: phraseTypes.IDENTIFIER,
              index: getIdentifiers().length - 1,
            });
          }

          if (isComponentTag) {
            pushPhrase({
              type: phraseTypes.COMPONENT,
              tagStart: true,
              value: "<",
              tagName: unparsedFragment.slice(
                controlCharsIndex + 1,
                controlCharsIndex +
                  1 +
                  unparsedFragment
                    .slice(controlCharsIndex + 1)
                    .split("")
                    // TODO: figure out what characters should be allowed in
                    // component names
                    .findIndex((char) => !/[a-z0-9]/i.test(char)),
              ),
              isOpeningTag: true,
              value: "",
            });
          } else {
            pushPhrase({ type: phraseTypes.HTML, tagStart: true, value: "<" });
          }

          isOpeningTag = true;
          break;
        // Handle non-interpolated attribute start/end
        case '"':
          if (!isComponentTag) {
            pushPhrase({
              type: phraseTypes.HTML,
              value: unparsedFragment.slice(0, controlCharsIndex + 1),
            });
          } else if (!isAttr) {
            const name = unparsedFragment.slice(
              unparsedFragment
                .slice(0, controlCharsIndex - 1)
                .lastIndexOf(" ") + 1,
              controlCharsIndex - 1,
            );

            const value = unparsedFragment.slice(
              controlCharsIndex + 1,
              controlCharsIndex +
                1 +
                unparsedFragment.slice(controlCharsIndex + 1).indexOf('"'),
            );

            templateStack.at(-1).props.push({
              identifierIndex: getIdentifiers().length - 1,
              name,
              value,
            });
          }

          isAttr = !isAttr;
          break;
        // Handle closing tag start
        case "</":
          if (/[A-Z]/.test(unparsedFragment[controlCharsIndex + 2])) {
            isComponentTag = true;
          }

          pushPhrase({
            type: phraseTypes.HTML,
            value: unparsedFragment.slice(
              0,
              isComponentTag ? controlCharsIndex : controlCharsIndex + 2,
            ),
          });

          if (isComponentTag) {
            templateStack.at(-1).parsedHtmlPhrases = mergePhrases(
              templateStack.at(-1).parsedHtmlPhrases,
            );
            templateStack.pop();
          }

          isClosingTag = true;
          break;
        // Handle tag end
        case ">":
          if (!isComponentTag) {
            // TODO: handle self closing tags
            pushPhrase({
              type: phraseTypes.HTML,
              value: unparsedFragment.slice(0, controlCharsIndex + 1),
            });
          } else if (
            isOpeningTag &&
            unparsedFragment[controlCharsIndex - 1] !== "/"
          ) {
            templateStack.at(-1).props.push({
              identifierIndex: getIdentifiers().length - 1,
              name: "children",
              value: {
                _isTemplateNode: true,
                interpolations: templateStack.at(-1).interpolations,
                parsedHtmlPhrases: [],
                identifiers: [],
                attributes: [],
                listeners: [],
                slots: [],
                props: [],
              },
            });

            templateStack.push(templateStack.at(-1).props.at(-1).value);
          } else if (
            isClosingTag ||
            unparsedFragment[controlCharsIndex - 1] === "/"
          ) {
            pushPhrase({
              type: phraseTypes.IDENTIFIER,
              index: getIdentifiers().length - 1,
            });
          }

          isClosingTag = false;
          isOpeningTag = false;
          isComponentTag = false;
          break;
      }

      unparsedFragment = controlChars
        ? unparsedFragment.slice(controlCharsIndex + controlChars.length)
        : "";

      // Handle component props and interpolated component attributes
      if (
        !unparsedFragment &&
        isComponentTag &&
        isOpeningTag &&
        prevPhrase().type === phraseTypes.COMPONENT &&
        fragment.endsWith("=")
      ) {
        templateStack.at(-1).props.push({
          identifierIndex: getIdentifiers().length - 1,
          name: fragment.slice(fragment.lastIndexOf(" ") + 1, -1),
          interpolationIndex: i,
        });
      }
    }

    // Handle slots, interpolated non-component attributes, and inline event
    // listeners
    if (
      !isOpeningTag &&
      !isClosingTag &&
      i !== template.htmlStrings.length - 1
    ) {
      getIdentifiers().push({ suffix });
      suffix++;

      pushPhrase({
        type: phraseTypes.IDENTIFIER,
        index: getIdentifiers().length - 1,
      });

      templateStack.at(-1).slots.push({
        interpolationIndex: i,
        identifierIndex: getIdentifiers().length - 1,
      });
      pushPhrase({
        type: phraseTypes.SLOT,
        index: templateStack.at(-1).slots.length - 1,
        type: "slot",
      });
    } else if (isOpeningTag && !isComponentTag) {
      const phrases = templateStack.at(-1).parsedHtmlPhrases;
      const tagStart = phrases.findLastIndex((phrase) => phrase.tagStart);

      if (
        !phrases[tagStart - 1] ||
        phrases[tagStart - 1].type !== phraseTypes.IDENTIFIER
      ) {
        getIdentifiers().push({ suffix });
        suffix++;

        phrases.splice(tagStart, 0, {
          type: phraseTypes.IDENTIFIER,
          index: getIdentifiers().length - 1,
        });
      }

      const attrStart =
        prevPhrase()
          .value.split("")
          .findLastIndex((char) => char === " ") + 1;
      const attrName = prevPhrase().value.slice(attrStart, -1);

      // Strip out inline event listeners so they can be attached later
      if (attrName.startsWith("on")) {
        prevPhrase().value = prevPhrase()
          .value.split("")
          .toSpliced(attrStart, attrName.length + 1)
          .join("");

        templateStack.at(-1).listeners.push({
          interpolationIndex: i,
          event: attrName.slice(2).toLowerCase(),
          identifierIndex: getIdentifiers().length - 1,
        });
      } else {
        templateStack.at(-1).attributes.push({
          name: attrName,
          interpolationIndex: i,
          identifierIndex: getIdentifiers().length - 1,
        });
        pushPhrase({
          type: phraseTypes.ATTRIBUTE,
          index: templateStack.at(-1).attributes.length - 1,
          type: "attribute",
        });
      }
    }
  });

  template.parsedHtmlPhrases = mergePhrases(template.parsedHtmlPhrases);
}

let currentKey;
let templatesByKey = {};
let propsByKey = {};
let componentsByKey = {};

function renderToString(key, node, result = { html: "", listenersByKey: {} }) {
  currentKey = key;

  let template;
  if (isTemplate(node)) {
    template = node;
  } else {
    componentsByKey[key] = node;
    template = node(propsByKey[key] || {});
  }

  if (isPrimitive(template)) {
    // TODO: primitives need to be escaped at some point
    if (canRenderPrimitive(template)) {
      result.html += template;
    }
    return result;
  }

  if (!template.parsedHtmlPhrases.length) {
    parseTemplateInPlace(template);
  }

  template.components ||= node.components;
  templatesByKey[key] = template;

  template.parsedHtmlPhrases.forEach((phrase, i) => {
    const prevPhrase = template.parsedHtmlPhrases[i - 1];
    const activeKey =
      prevPhrase?.type === phraseTypes.IDENTIFIER &&
      key + "." + template.identifiers[prevPhrase.index].suffix;

    switch (phrase.type) {
      case phraseTypes.IDENTIFIER:
        {
          result.html += `<!-- ${
            key + "." + template.identifiers[phrase.index].suffix
          } -->`;
        }
        break;
      case phraseTypes.HTML:
        result.html += phrase.value;
        break;
      case phraseTypes.ATTRIBUTE:
        {
          const attribute = template.attributes[phrase.index];
          result.html += `"${
            // TODO: you may need to escape this
            template.interpolations[attribute.interpolationIndex]
          }"`;
        }
        break;
      case phraseTypes.SLOT:
        {
          const value =
            template.interpolations[
              template.slots[phrase.index].interpolationIndex
            ];

          if (isPrimitive(value)) {
            if (canRenderPrimitive(value)) {
              // TODO: you also need to escape this
              result.html += value;
            }
          } else if (isTemplate(value)) {
            renderToString(activeKey, value, result);
          } else if (Array.isArray(value)) {
            if (!value.every(isTemplate)) {
              throw new Error(INVALID_ARRAY_ITEM);
            }

            if (!value.every((item) => item.assignedkey)) {
              throw new Error(MISSING_ARRAY_ITEM_KEY);
            }

            value.forEach((item) => {
              item.components ||= template.components;
              const itemKey = activeKey + "." + item.assignedkey;

              result.html += `<!-- ${itemKey} -->`;
              renderToString(itemKey, item, result);
              result.html += `<!-- ${itemKey} -->`;
            });
          }
        }
        break;
      case phraseTypes.COMPONENT:
        if (
          phrase.tagName in node.components &&
          typeof node.components[phrase.tagName] === "function"
        ) {
          propsByKey[activeKey] = Object.fromEntries(
            template.props.flatMap((prop) =>
              template.identifiers[prop.identifierIndex] ===
              template.identifiers[prevPhrase.index]
                ? [
                    [
                      prop.name,
                      prop.name === "children"
                        ? {
                            ...prop.value,
                            components:
                              prop.value.components || node.components,
                          }
                        : prop.value ||
                          template.interpolations[prop.interpolationIndex],
                    ],
                  ]
                : [],
            ),
          );

          renderToString(activeKey, node.components[phrase.tagName], result);
        } else {
          throw new Error(`Component "${phrase.tagName}" not found`);
        }
        break;
    }
  });

  // Keep track of listeners so they can be attached after the dom is updated
  template.listeners.forEach((listener) => {
    const listenerKey =
      key + "." + template.identifiers[listener.identifierIndex].suffix;

    result.listenersByKey[listenerKey] ||= [];
    result.listenersByKey[listenerKey].push({
      event: listener.event,
      handler: template.interpolations[listener.interpolationIndex],
    });
  });

  return result;
}

const elementsByKey = {};

function getElementByKey(key) {
  return (elementsByKey[key] ||= document.evaluate(
    `//comment()[contains(string(), " ${key} ")]`,
    document,
    null,
    XPathResult.FIRST_ORDERED_NODE_TYPE,
  ).singleNodeValue?.nextSibling);
}

// TODO: you shouldn't call document.evaluate for each listener and it might be
// better to attach listeners once you're done with other dom mutations
// - you can prepend "evt " to keys with listeners and then query the document
//   for all of those
// - when attaching listeners for a template you might be able to query the
//   document for just the keys belonging to the template

function hydrate({ listenersByKey }) {
  Object.entries(listenersByKey).forEach(([key, listeners]) =>
    listeners.forEach(({ event, handler }) =>
      getElementByKey(key).addEventListener(event, handler),
    ),
  );
}

/**
 * - "set" replaces html between two keys,
 * - "text" does the same thing for a text node
 * - "overwrite" is like set but it writes over the matching start and end keys
 *   as well
 * - "append" inserts html after the second matching key
 * - "insert" inserts html after the first matching key without replacing
 *   anything
 *
 * @param {"set" | "text" | "overwrite" | "append" | "insert"} [mode="set"]
 */
function setHtml(key, html, mode = "set") {
  debug("Setting html with mode", mode);

  let result = document.evaluate(
    `//comment()[contains(string(), " ${key} ")]`,
    document,
    null,
    mode === "append"
      ? XPathResult.ORDERED_NODE_ITERATOR_TYPE
      : XPathResult.FIRST_ORDERED_NODE_TYPE,
  );

  const node =
    mode === "append"
      ? result.iterateNext() && result.iterateNext()
      : result.singleNodeValue;

  if (mode === "set" || mode === "text" || mode === "overwrite") {
    while (
      node.nextSibling &&
      (node.nextSibling.nodeType !== Node.COMMENT_NODE ||
        !node.nextSibling.nodeValue?.includes(` ${key} `))
    ) {
      node.nextSibling.remove();
    }
  }

  let newNode;

  if (mode === "text") {
    newNode = document.createTextNode(html);
  } else {
    const template = document.createElement("template");
    template.innerHTML = html;
    newNode = template.content;
  }

  node.parentNode.insertBefore(newNode, node.nextSibling);

  if (mode === "overwrite") {
    node.nextSibling.remove();
    node.remove();
  }
}

function clearChildKeys(key, obj) {
  Object.keys(obj).forEach((objKey) => {
    if (objKey.startsWith(key)) {
      delete obj[objKey];
    }
  });
}

function clearTemplateCaches(key) {
  clearChildKeys(key, templatesByKey);
  clearChildKeys(key, propsByKey);
  clearChildKeys(key, componentsByKey);
  clearChildKeys(key, elementsByKey);
}

function render(key, node, depth = 0, domMutations = []) {
  currentKey = key;

  let template;
  if (isTemplate(node)) {
    template = node;
  } else {
    componentsByKey[key] = node;
    template = node(propsByKey[key] || {});
  }

  if (isPrimitive(template)) {
    domMutations.push(() =>
      setHtml(key, canRenderPrimitive(template) ? template : "", "text"),
    );
    return;
  }

  if (!template.parsedHtmlPhrases.length) {
    parseTemplateInPlace(template);
  }

  template.components ||= node.components;

  if (!templatesByKey[key] || !isTemplateMatch(templatesByKey[key], template)) {
    const result = renderToString(key, template);

    domMutations.push(() => {
      setHtml(key, result.html);
      hydrate(result);
    });

    return;
  }

  template.slots.forEach((slot) => {
    const slotKey =
      key + "." + template.identifiers[slot.identifierIndex].suffix;
    const value = template.interpolations[slot.interpolationIndex];
    const prevValue =
      templatesByKey[key].interpolations[slot.interpolationIndex];

    if (isPrimitive(value)) {
      if (prevValue !== value) {
        clearTemplateCaches(slotKey);

        domMutations.push(() =>
          setHtml(slotKey, canRenderPrimitive(value) ? value : "", "text"),
        );
      }
    } else if (
      isTemplate(value) &&
      (isPrimitive(prevValue) || !isTemplateMatch(prevValue, value))
    ) {
      render(slotKey, value, depth + 1, domMutations);
    } else if (Array.isArray(value)) {
      if (isTemplate(prevValue)) {
        clearTemplateCaches(slotKey);
      }

      if (!value.every(isTemplate)) {
        throw new Error(INVALID_ARRAY_ITEM);
      }

      if (!value.every((item) => item.assignedkey)) {
        throw new Error(MISSING_ARRAY_ITEM_KEY);
      }

      let renderAll = false;
      if (!Array.isArray(prevValue)) {
        renderAll = true;
      } else {
        const withoutNew = value.filter((item) =>
          prevValue.some(
            (prevItem) => prevItem.assignedkey === item.assignedkey,
          ),
        );
        const prevWithoutRemoved = prevValue.filter((prevItem) =>
          value.some((item) => item.assignedkey === prevItem.assignedkey),
        );
        const orderChanged = !withoutNew.every(
          (item, i) => prevWithoutRemoved[i].assignedkey === item.assignedkey,
        );

        orderChanged && debug("Array order changed");
        renderAll = orderChanged;
      }

      if (renderAll) {
        clearTemplateCaches(slotKey);
        domMutations.push(() => setHtml(slotKey, ""));

        value.toReversed().forEach((item) => {
          item.components ||= template.components;

          const itemKey = slotKey + "." + item.assignedkey;
          const result = renderToString(itemKey, item);

          domMutations.push(() => {
            setHtml(
              slotKey,
              `<!-- ${itemKey} -->` + result.html + `<!-- ${itemKey} -->`,
              "insert",
            );
            hydrate(result);
          });
        });
      } else {
        // Removed items
        prevValue.forEach((prevItem) => {
          if (
            !value.some((item) => item.assignedkey === prevItem.assignedkey)
          ) {
            domMutations.push(() =>
              setHtml(slotKey + "." + prevItem.assignedkey, "", "overwrite"),
            );
          }
        });

        // Added or changed items
        value.toReversed().forEach((item, i, reversed) => {
          const itemKey = slotKey + "." + item.assignedkey;
          const prevItem = prevValue.find(
            (prevItem) => prevItem.assignedkey === item.assignedkey,
          );

          if (!prevItem) {
            item.components ||= template.components;
            const result = renderToString(itemKey, item);
            const anchor = reversed
              .slice(i + 1)
              .find((item) =>
                prevValue.some(
                  (prevItem) => prevItem.assignedkey === item.assignedkey,
                ),
              );

            domMutations.push(() => {
              const itemHtml = `<!-- ${itemKey} -->${result.html}<!-- ${itemKey} -->`;

              if (anchor) {
                setHtml(slotKey + "." + anchor.assignedkey, itemHtml, "append");
              } else {
                setHtml(slotKey, itemHtml, "insert");
              }

              hydrate(result);
            });
          } else if (item.hash !== prevItem.hash) {
            render(itemKey, item, depth + 1, domMutations);
          }
        });
      }
    }
  });

  template.attributes.forEach((attr, i) => {
    // TODO: you may need to escape this
    const attrValue = template.interpolations[attr.interpolationIndex];
    const prevAttrValue =
      templatesByKey[key].interpolations[
        templatesByKey[key].attributes[i].interpolationIndex
      ];

    if (prevAttrValue !== attrValue) {
      domMutations.push(() => {
        const element = getElementByKey(
          key + "." + template.identifiers[attr.identifierIndex].suffix,
        );

        element.setAttribute(attr.name, attrValue);

        if (
          attr.name === "value" &&
          element.tagName === "INPUT" &&
          element.value !== attrValue
        ) {
          element.value = attrValue;
        }
      });
    }
  });

  // TODO: special handling for functions that don't reference stale variables
  // but are not themselves referencially stable?
  template.listeners.forEach((listener) => {
    const handler = template.interpolations[listener.interpolationIndex];
    const prevHandler =
      templatesByKey[key].interpolations[listener.interpolationIndex];

    if (prevHandler !== handler) {
      domMutations.push(() => {
        const elementKey =
          key + "." + template.identifiers[listener.identifierIndex].suffix;

        getElementByKey(elementKey).removeEventListener(
          listener.event,
          prevHandler,
        );

        getElementByKey(elementKey).addEventListener(listener.event, handler);
      });
    }
  });

  const keysToRerender = [];
  const renderedPropsByKey = {};

  template.props.forEach((prop, i) => {
    const propKey =
      key + "." + template.identifiers[prop.identifierIndex].suffix;

    // Check prop equality across renders
    if (
      templatesByKey[key].props[i].value !== prop.value ||
      templatesByKey[key].interpolations[prop.interpolationIndex] !==
        template.interpolations[prop.interpolationIndex]
    ) {
      keysToRerender.push(propKey);
    }

    renderedPropsByKey[propKey] ||= {};
    renderedPropsByKey[propKey][prop.name] =
      "value" in prop
        ? prop.value
        : template.interpolations[prop.interpolationIndex];
  });

  // Check if the number of props for each key is the same (sufficient with the
  // quality check above)
  Object.keys(renderedPropsByKey).forEach((key) => {
    if (
      Object.keys(propsByKey[key]).length !==
      Object.keys(renderedPropsByKey[key]).length
    ) {
      keysToRerender.push(key);
    }
  });

  propsByKey = { ...propsByKey, ...renderedPropsByKey };
  keysToRerender.forEach((key) =>
    render(key, componentsByKey[key], depth + 1, domMutations),
  );

  if (depth === 0 && domMutations.length) {
    domMutations.forEach((mutation) => mutation());
  }

  templatesByKey[key] = template;
}

function WithChildren({ children }) {
  return html`
    <br />
    children:
    <div>${children}</div>
  `;
}

function OtherPropsTest({ id, class: className, children }) {
  return html`<div id=${id} class=${className}>${children}</div> `;
}

WithChildren.components = { WithChildren, OtherPropsTest };

function Heading({ children }) {
  return html`<h1>${children}</h1> `;
}

let count = 0;

function Counter() {
  return html`
    <div>${count}</div>
    <button
      onClick=${() => {
        count++;
        render("root.0", Counter);
      }}
    >
      ↑
    </button>
    <button
      onClick=${() => {
        count--;
        render("root.0", Counter);
      }}
    >
      ↓
    </button>
  `;
}

let todoCount = 0;
function todoId() {
  return ++todoCount;
}

let todos = [...Array(3)].map(() => ({
  id: todoId(),
}));

function TodoList() {
  return html`
    <div>
      <h1 style="display: inline">Todos</h1>
      <button
        onClick=${() => {
          todos.push({ id: todoId() });
          render("root.0", TodoList);
        }}
      >
        +
      </button>
    </div>
    ${todos.map(
      (todo) => html(todo.id)`
        <Todo id=${todo.id} />
      `,
    )}
  `;
}

function Todo({ id }) {
  return html`
    <div>
      <input type="checkbox" />
      <input type="text" placeholder=${`To do [${id}]`} />
      <button
        onClick=${() => {
          const index = todos.findIndex((todo) => todo.id === id);
          const todo = todos[index];

          todos.splice(index, 1);
          todos.splice(index - 1, 0, todo);

          render("root.0", TodoList);
        }}
      >
        ↑
      </button>
      <button
        onClick=${() => {
          const index = todos.findIndex((todo) => todo.id === id);
          const todo = todos[index];

          todos.splice(index, 1);
          todos.splice(index + 1, 0, todo);

          render("root.0", TodoList);
        }}
      >
        ↓
      </button>
      <button
        onClick=${() => {
          todos.splice(todos.findIndex((todo) => todo.id === id) + 1, 0, {
            id: todoId(),
          });
          render("root.0", TodoList);
        }}
      >
        +
      </button>
      <button
        onClick=${() => {
          todos.splice(
            todos.findIndex((todo) => todo.id === id),
            1,
          );
          render("root.0", TodoList);
        }}
      >
        -
      </button>
    </div>
  `;
}

TodoList.components = { Todo };

let expanded = false;

function Accordion({ title, description }) {
  return html`
    <div>
      <div>
        <h2 style="display: inline">${title}</h2>
        <button
          onclick=${() => {
            expanded = !expanded;
            render("root.0", Accordion);
          }}
        >
          ${expanded ? "x" : "+"}
        </button>
      </div>
      ${expanded && html`<p>${description}</p>`}
    </div>
  `;
}

let value = "";

function TextInput() {
  return html`
    <input
      value=${value}
      oninput=${(e) => {
        value = e.target.value;
        render("root.0", TextInput);
      }}
    />
    <button
      onclick=${() => {
        value = "";
        render("root.0", TextInput);
      }}
    >
      X
    </button>
  `;
}

const App = () => {
  return html`<Counter />`;

  return html`<TodoList />`;

  return html`<TextInput />`;

  return html`
    <Accordion
      title="Hello world"
      description="Lorem ipsum dolor sit amet. The quick brown fox jumped over the lazy dog."
    />
  `;
};

App.components = {
  Heading,
  WithChildren,
  OtherPropsTest,
  Counter,
  Todo,
  TodoList,
  Accordion,
  TextInput,
};

const result = renderToString("root", App);
const root = document.getElementById("root");

root.innerHTML = result.html;
hydrate(result);
