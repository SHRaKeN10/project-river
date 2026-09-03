// @types/react v19 dropped the *global* `JSX` namespace in favour of `React.JSX`.
// The codebase annotates component return types as `: JSX.Element` in ~two dozen
// files; rather than churn every one, re-point the global namespace at React's.
// (The automatic JSX runtime already uses `React.JSX` directly - this is only for
// the explicit annotations.)
declare namespace JSX {
  type ElementType = React.JSX.ElementType;
  type Element = React.JSX.Element;
  type ElementClass = React.JSX.ElementClass;
  type ElementAttributesProperty = React.JSX.ElementAttributesProperty;
  type ElementChildrenAttribute = React.JSX.ElementChildrenAttribute;
  type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>;
  type IntrinsicAttributes = React.JSX.IntrinsicAttributes;
  type IntrinsicClassAttributes<T> = React.JSX.IntrinsicClassAttributes<T>;
  type IntrinsicElements = React.JSX.IntrinsicElements;
}
