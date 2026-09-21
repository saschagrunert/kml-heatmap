/**
 * Draw at most once per animation frame, with the latest value.
 *
 * Pointer moves, slider drags and download chunks all arrive many times per
 * frame, and only the last of them is ever seen. `schedule` keeps the value
 * and asks for one frame; `cancel` drops a frame that is still waiting, for
 * when what it would draw into is going away.
 */
export interface FrameCoalescer<T> {
  schedule(value: T): void;
  cancel(): void;
}

export function frameCoalescer<T>(draw: (value: T) => void): FrameCoalescer<T> {
  let frame: number | null = null;
  let latest: T;
  return {
    schedule(value) {
      latest = value;
      frame ??= requestAnimationFrame(() => {
        frame = null;
        draw(latest);
      });
    },
    cancel() {
      if (frame === null) return;
      cancelAnimationFrame(frame);
      frame = null;
    },
  };
}
