import { h, onMounted, onBeforeUnmount, watch } from "vue";

// Shared rendering conventions preserve the original DOM and CSS during migration.
// 将页面组件使用的属性转换为 Vue 可识别的形式。
const unitless = new Set([
  "opacity",
  "zIndex",
  "fontWeight",
  "lineHeight",
  "flex",
  "flexGrow",
  "flexShrink",
  "order",
  "zoom",
  "strokeWidth",
  "fillOpacity",
  "strokeOpacity",
  "aspectRatio",
  "gridRow",
  "gridColumn",
]);
export function jsx(type, props, ...children) {
  const attrs = { ...props };
  // 原生媒体事件没有连字符；将 JSX 写法转换为浏览器事件名。
  if (typeof type === "string") {
    for (const name of ["TimeUpdate", "LoadedMetadata", "LoadedData", "DurationChange", "CanPlay", "Seeked"]) {
      const key = `on${name}`;
      if (key in attrs) {
        const nativeKey = `on${name[0]}${name.slice(1).toLowerCase()}`;
        if (nativeKey !== key) {
          attrs[nativeKey] = attrs[key];
          delete attrs[key];
        }
      }
    }
  }

  if ("className" in attrs) {
    attrs.class = attrs.className;
    delete attrs.className;
  }
  if ("vectorEffect" in attrs) {
    attrs["vector-effect"] = attrs.vectorEffect;
    delete attrs.vectorEffect;
  }
  if ("htmlFor" in attrs) {
    attrs.for = attrs.htmlFor;
    delete attrs.htmlFor;
  }
  if (
    typeof type === "string" &&
    attrs.onChange &&
    ["input", "textarea"].includes(type)
  ) {
    attrs.onInput = attrs.onChange;
    delete attrs.onChange;
  }
  if (attrs.style && typeof attrs.style === "object")
    attrs.style = Object.fromEntries(
      Object.entries(attrs.style).map(([k, v]) => [
        k,
        typeof v === "number" &&
        v !== 0 &&
        !unitless.has(k) &&
        !k.startsWith("--")
          ? `${v}px`
          : v,
      ]),
    );
  if (attrs.dangerouslySetInnerHTML) {
    attrs.innerHTML = attrs.dangerouslySetInnerHTML.__html;
    delete attrs.dangerouslySetInnerHTML;
  }
  return h(
    type,
    attrs,
    children
      .flat(Infinity)
      .filter((x) => x !== false && x !== true && x != null),
  );
}
// 根据依赖变化执行回调。
export function observe(callback, dependencies) {
  let dispose, cleanup;
  onMounted(() => {
    dispose = watch(
      dependencies,
      (next, previous) => {
        if (
          previous &&
          next.length === previous.length &&
          next.every((v, i) => Object.is(v, previous[i]))
        )
          return;
        cleanup?.();
        cleanup = callback();
      },
      { immediate: true, flush: "post" },
    );
  });
  onBeforeUnmount(() => {
    dispose?.();
    cleanup?.();
  });
}
