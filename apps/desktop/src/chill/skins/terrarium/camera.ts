/** Frame the complete plant and its perches inside the dome, not its trunk base. */
export function focusCamera(x: number, y: number, hero: boolean) {
  const top = hero ? -310 : -215;
  const bottom = 55;
  const zoom = Math.min(1.5, 420 / (bottom - top));
  return {
    zoom,
    x: 600 - x * zoom,
    y: 420 - (y + (top + bottom) / 2) * zoom,
  };
}
