const phraseTypes = {
  IDENTIFIER: "identifier",
  ATTRIBUTE: "attribute",
  HTML: "html",
  SLOT: "slot",
  COMPONENT: "component",
};

const INVALID_ARRAY_ITEM =
  "[helix] Each element in an array must be wrapped in html(key)`...`";
const MISSING_ARRAY_ITEM_KEY =
  "[helix] Each element in an array must have a key. Pass one like this: html(key)`...`";

const DEBUG = true;

function debug(...msg) {
  DEBUG && console.log(...msg);
}

function isTemplate(value) {
  return value && value._isTemplateNode;
}

function isTemplateMatch(a, b) {
  if (!a.hash && !b.hash) {
    return a === b;
  }
  return a.hash === b.hash;
}

function isInterpolationsMatch(a, b) {
  return (
    a.interpolations.length === b.interpolations.length &&
    a.interpolations.every(
      (value, i) => isPrimitive(value) && b.interpolations[i] === value,
    )
  );
}

function isPrimitive(value) {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  );
}

function canRenderPrimitive(value) {
  return typeof value === "string" || typeof value === "number";
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function isAttrTruthy(value) {
  if (value === false || value === undefined || value === null) {
    return false;
  }
  return true;
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

function resolveComponents(module) {
  const templates = [];
  const components = {};

  Object.entries(module).forEach(([name, value]) => {
    if (isTemplate(value)) {
      templates.push(value);
    } else if (typeof value === "function" && /[A-Z]/.test(name)) {
      components[name] = value;
    } else if (
      /[A-Z]/.test(name) &&
      value &&
      typeof value === "object" &&
      value[Symbol.toStringTag] === "Module" &&
      typeof value[name] === "function"
    ) {
      components[name] = value[name];
      components[name].components = resolveComponents(value);
    }
  });

  // TODO: re-exported templates may end up with the wrong components
  templates.forEach((template) => (template.components = components));
  Object.values(components).forEach(
    (component) => (component.components ||= components),
  );

  return components;
}

export function createRoot(domNode, scope) {
  const components = resolveComponents(scope);

  return {
    render(template) {
      template.components = components;

      const result = renderToString("root", template);
      domNode.innerHTML = result.html;

      hydrate(result);
    },
  };
}

const codeLookup = {
  "&": "&amp;",
  "<": "&lt;",
  '"': "&quot;",
  "'": "&#39;",
  ">": "&gt;",
};

function escapeHtml(text) {
  if (typeof text !== "string") {
    return text;
  }

  return text.replace(/&|<|"|'|>/g, (match) => codeLookup[match]);
}

export function html(htmlStringsOrConfig, ...interpolations) {
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
      assignedkey: key ? "i_" + key : undefined,
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

const keyStack = [];
function getCurrentKey() {
  return keyStack.at(-1);
}

const templatesByKey = {};
const componentsByKey = {};

let propsByKey = {};

function renderToString(key, node, result = { html: "", listenersByKey: {} }) {
  keyStack.push(key);

  let template;
  if (isTemplate(node)) {
    template = node;
  } else {
    componentsByKey[key] = node;
    template = node(propsByKey[key] || {});
  }

  if (isPrimitive(template)) {
    if (canRenderPrimitive(template)) {
      result.html += escapeHtml(template);
    }

    keyStack.pop();
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
          const value = template.interpolations[attribute.interpolationIndex];

          if (value === true) {
            // Truncate true boolean attributes to just the name
            result.html = result.html.slice(0, -1);
          } else if (!isAttrTruthy(value)) {
            // Strip out false or nullish attributes
            result.html = result.html.slice(
              0,
              result.html.length - attribute.name.length - 1,
            );
          } else {
            result.html += `"${escapeHtml(value)}"`;
          }
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
              result.html += escapeHtml(value);
            }
          } else if (isTemplate(value)) {
            value.components ||= template.components;

            renderToString(activeKey, value, result);
          } else if (Array.isArray(value)) {
            if (!value.every(isTemplate)) {
              throw new Error(INVALID_ARRAY_ITEM);
            }

            if (!value.every((item) => item.assignedkey)) {
              throw new Error(MISSING_ARRAY_ITEM_KEY);
            }

            value.forEach((item) => {
              const itemKey = activeKey + "." + item.assignedkey;

              item.components ||= template.components;

              result.html += `<!-- ${itemKey} -->`;
              renderToString(itemKey, item, result);
              result.html += `<!-- ${itemKey} -->`;
            });
          }
        }
        break;
      case phraseTypes.COMPONENT:
        if (
          phrase.tagName in template.components &&
          typeof template.components[phrase.tagName] === "function"
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

          renderToString(
            activeKey,
            template.components[phrase.tagName],
            result,
          );
        } else {
          throw new Error(`[helix] Component "${phrase.tagName}" not found`);
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

  keyStack.pop();
  return result;
}

const elementsByKey = {};

function getElementByKey(key) {
  const el = (elementsByKey[key] ||= document.evaluate(
    `//comment()[contains(string(), " ${key} ")]`,
    document,
    null,
    XPathResult.FIRST_ORDERED_NODE_TYPE,
  ).singleNodeValue?.nextSibling);

  if (!el.isConnected) {
    throw new Error("[helix] Encountered disconnected element");
  }

  return el;
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

function clearChildKeys(key, obj, clearSelf = true) {
  Object.keys(obj).forEach((objKey) => {
    if (objKey.startsWith(key) && (clearSelf || objKey !== key)) {
      delete obj[objKey];
    }
  });
}

function clearAll(key) {
  clearTemplate(key, true);
}

function clearTemplate(key, clearOwnComponent = false) {
  clearChildKeys(key, elementsByKey);
  clearChildKeys(key, templatesByKey);
  clearChildKeys(key, propsByKey, clearOwnComponent);
  clearChildKeys(key, signalInitsByKey, clearOwnComponent);
  clearChildKeys(key, componentsByKey, clearOwnComponent);
  clearChildKeys(key, accessByKey, clearOwnComponent);
  clearChildKeys(key, enumeratedAccessByKey, clearOwnComponent);
}

function render(key, node, depth = 0, domMutations = []) {
  keyStack.push(key);

  let template;
  if (isTemplate(node)) {
    template = node;
  } else {
    componentsByKey[key] = node;

    delete accessByKey[key];
    delete enumeratedAccessByKey[key];
    template = node(propsByKey[key] || {});
  }

  if (isPrimitive(template)) {
    clearTemplate(key);

    domMutations.push(() =>
      // No need to escape since setHtml with mode "text" calls createTextNode
      setHtml(key, canRenderPrimitive(template) ? template : "", "text"),
    );

    if (depth === 0 && domMutations.length) {
      domMutations.forEach((mutation) => mutation());
    }

    keyStack.pop();
    return;
  }

  if (!template.parsedHtmlPhrases.length) {
    parseTemplateInPlace(template);
  }

  template.components ||= node.components;

  if (!templatesByKey[key] || !isTemplateMatch(templatesByKey[key], template)) {
    clearTemplate(key);

    const result = renderToString(key, template);

    domMutations.push(() => {
      setHtml(key, result.html);
      hydrate(result);
    });

    if (depth === 0 && domMutations.length) {
      domMutations.forEach((mutation) => mutation());
    }

    templatesByKey[key] = template;
    keyStack.pop();
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
        clearAll(slotKey);

        domMutations.push(() =>
          // No need to escape since setHtml with mode "text" calls
          // createTextNode
          setHtml(slotKey, canRenderPrimitive(value) ? value : "", "text"),
        );
      }
    } else if (isTemplate(value)) {
      if (
        isPrimitive(prevValue) ||
        !isTemplateMatch(prevValue, value) ||
        !isInterpolationsMatch(prevValue, value)
      ) {
        if (isTemplate(prevValue) && !isTemplateMatch(prevValue, value)) {
          clearAll(slotKey);
        }

        value.components ||= template.components;

        render(slotKey, value, depth + 1, domMutations);
      }
    } else if (Array.isArray(value)) {
      if (isTemplate(prevValue)) {
        clearAll(slotKey);
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
        clearAll(slotKey);
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
            const itemKey = slotKey + "." + prevItem.assignedkey;
            clearAll(itemKey);
            domMutations.push(() => setHtml(itemKey, "", "overwrite"));
          }
        });

        // Added or changed items
        value.toReversed().forEach((item, i, reversed) => {
          const itemKey = slotKey + "." + item.assignedkey;
          const prevItem = prevValue.find(
            (prevItem) => prevItem.assignedkey === item.assignedkey,
          );

          item.components ||= template.components;

          if (!prevItem) {
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
          } else if (
            !isTemplateMatch(prevItem, item) ||
            !isInterpolationsMatch(prevItem, item)
          ) {
            render(itemKey, item, depth + 1, domMutations);
          }
        });
      }
    }
  });

  template.attributes.forEach((attr, i) => {
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

        if (!isAttrTruthy(attrValue)) {
          element.removeAttribute(attr.name);
        } else if (attrValue === true) {
          element.setAttribute(attr.name, "");
        } else {
          element.setAttribute(attr.name, attrValue);
        }

        if (element.tagName === "INPUT") {
          if (
            attr.name === "checked" &&
            element.checked !== isAttrTruthy(attrValue)
          ) {
            element.checked = isAttrTruthy(attrValue);
          } else if (attr.name === "value" && element.value !== attrValue) {
            element.value = attrValue;
          }
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
  // equality check above)
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
  keyStack.pop();
}

const accessByKey = {};
const enumeratedAccessByKey = {};

const pathPropertyName = Symbol();

function subscribe(lookup, signalId, path) {
  const currentKey = getCurrentKey();

  if (currentKey) {
    const access = (lookup[currentKey] ||= {});
    const paths = (access[signalId] ||= []);

    if (!paths.includes(path)) {
      paths.push(path);
    }
  }
}

function renderSubs(lookup, signalId, path) {
  Object.entries(lookup).forEach(([key, access]) => {
    const paths = access[signalId];

    // TODO: To ensure that each component is rendered no more than once per
    // signal update you'll need to track mutations to the keyStack array
    if (
      paths?.includes(path) &&
      // Check that the key is still present as rendering one key may clear
      // others
      lookup[key]
    ) {
      render(key, componentsByKey[key]);
    }
  });
}

class ProxyHandler {
  #signalId;

  constructor(signalId, path) {
    this.#signalId = signalId;
    this.path = path;
  }

  get(target, prop, receiver) {
    if (prop === pathPropertyName) {
      return this.path;
    }

    const value = Reflect.get(target, prop, receiver);
    let proxied;

    if (Array.isArray(value) || isPlainObject(value)) {
      if (typeof value[pathPropertyName] === "string") {
        proxied = value;
        proxied[pathPropertyName] = this.path + "." + prop;
      } else {
        proxied = new Proxy(
          value,
          new ProxyHandler(this.#signalId, this.path + "." + prop),
        );
      }
    } else {
      proxied = value;
    }

    if (getCurrentKey()) {
      if (
        Array.isArray(target) &&
        (typeof value === "function" || prop === "length")
      ) {
        subscribe(enumeratedAccessByKey, this.#signalId, this.path);
      } else {
        subscribe(accessByKey, this.#signalId, this.path + "." + prop);
      }
    }

    if (
      Array.isArray(target) &&
      (prop === "splice" ||
        prop === "fill" ||
        prop === "sort" ||
        prop === "reverse" ||
        prop === "shift" ||
        prop === "unshift" ||
        prop === "push" ||
        prop === "pop")
    ) {
      return (...args) => {
        debug("calling proxied", prop);

        // TODO: In order to handle the edge case where an array is mutated via
        // method but accessed elsewhere via arr[n], you'll need to track the
        // mutations that occur during method execution, and then let
        // subscribers know about them when the method is complete
        const result = target[prop](...args);

        renderSubs(enumeratedAccessByKey, this.#signalId, this.path);

        return result;
      };
    }

    return proxied;
  }

  has(target, prop, receiver) {
    subscribe(enumeratedAccessByKey, this.#signalId, this.path);

    return Reflect.has(target, prop, receiver);
  }

  ownKeys(target) {
    subscribe(enumeratedAccessByKey, this.#signalId, this.path);

    return Reflect.has(target, prop, receiver);
  }

  set(target, prop, value, receiver) {
    if (prop === pathPropertyName) {
      this.path = value;
      return true;
    }

    Reflect.set(target, prop, value, receiver);

    if (Array.isArray(target) || isPlainObject(target)) {
      renderSubs(enumeratedAccessByKey, this.#signalId, this.path);
    }

    renderSubs(accessByKey, this.#signalId, this.path + "." + prop);

    return true;
  }

  deleteProperty(target, prop) {
    Reflect.deleteProperty(target, prop, receiver);

    renderSubs(enumeratedAccessByKey, this.#signalId, this.path);

    return true;
  }
}

const signalInitsByKey = {};

export function signal(initialValue) {
  if (getCurrentKey()) {
    return (signalInitsByKey[getCurrentKey()] ||= new Proxy(
      { val: initialValue },
      new ProxyHandler(Symbol(), "[root]"),
    ));
  } else {
    return new Proxy(
      { val: initialValue },
      new ProxyHandler(Symbol(), "[root]"),
    );
  }
}
